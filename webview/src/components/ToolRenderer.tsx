import { useEffect, useMemo, useState } from 'react';
import hljs from 'highlight.js';
import { diffLines } from 'diff';
import { Attachment, Step } from '../types/session';
import Attachments, { useAttachmentBytes } from './Attachments';
import { parseAskUserQuestion } from './askUserQuestion';
import 'highlight.js/styles/github-dark.css';
import './ToolRenderer.css';

// ─── Language detection ───────────────────────────────────────────────────
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python',
  rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  swift: 'swift', scala: 'scala', php: 'php', cs: 'csharp',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  m: 'objectivec', mm: 'objectivec',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  ps1: 'powershell',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini',
  md: 'markdown', markdown: 'markdown',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  sql: 'sql',
  graphql: 'graphql', gql: 'graphql',
  dockerfile: 'dockerfile',
  vue: 'xml', svelte: 'xml',
  lua: 'lua', dart: 'dart', r: 'r', jl: 'julia',
  ex: 'elixir', exs: 'elixir', erl: 'erlang',
  hs: 'haskell', clj: 'clojure', elm: 'elm',
};

const langFromPath = (path: string | undefined | null): string => {
  if (!path) return 'plaintext';
  const lower = path.toLowerCase();
  if (lower.endsWith('/dockerfile') || lower === 'dockerfile') return 'dockerfile';
  if (lower.endsWith('/makefile') || lower === 'makefile') return 'makefile';
  const m = lower.match(/\.([a-z0-9]+)$/);
  if (!m) return 'plaintext';
  return EXT_LANG[m[1]] || 'plaintext';
};

const safeHighlight = (code: string, lang: string): string => {
  try {
    if (lang && lang !== 'plaintext' && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ─── Parse tool result safely ─────────────────────────────────────────────
type ParsedResult = { ok: boolean; value: any };
const parseToolResult = (raw?: string): ParsedResult => {
  if (!raw) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: true, value: raw };
  }
};

// Pull a human-readable error string out of whatever shape the tool result
// happens to take. Errored tool calls land here as either a plain "Error: …"
// string, an object with a `.content` / `.error` / `.message` field, or
// simply the entire stdout/stderr blob — handle each case.
const extractErrorMessage = (result: any): string => {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return String(result);

  const candidates = [
    (result as any).error,
    (result as any).message,
    (result as any).errorMessage,
    (result as any).stderr,
    (result as any).content,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c;
  }
  // Bash-shaped errors: keep stdout if stderr was empty.
  if (typeof (result as any).stdout === 'string') return (result as any).stdout;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
};

// ─── Code block with line numbers ─────────────────────────────────────────
interface CodeBlockProps {
  code: string;
  language?: string;
  startLine?: number;
  showLineNumbers?: boolean;
}

const CodeBlock = ({ code, language, startLine = 1, showLineNumbers = true }: CodeBlockProps) => {
  const lang = language || 'plaintext';
  const lines = code.split('\n');
  // Drop a trailing empty line that comes from a final \n so we don't render a blank row.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const highlighted = safeHighlight(code, lang).split('\n');
  if (highlighted.length > lines.length) highlighted.length = lines.length;
  const gutterWidth = String(startLine + lines.length - 1).length;

  return (
    <pre className="tr-code">
      <code className={`hljs language-${lang}`}>
        {lines.map((_, i) => (
          <div key={i} className="tr-code-line">
            {showLineNumbers && (
              <span
                className="tr-code-gutter"
                style={{ minWidth: `${gutterWidth}ch` }}
              >
                {startLine + i}
              </span>
            )}
            <span
              className="tr-code-content"
              dangerouslySetInnerHTML={{ __html: highlighted[i] || '&nbsp;' }}
            />
          </div>
        ))}
      </code>
    </pre>
  );
};

// ─── Renderers ────────────────────────────────────────────────────────────
const PathHeader = ({
  path,
  badge,
  badgeKind,
  meta,
}: {
  path: string;
  badge?: string;
  badgeKind?: 'success' | 'info' | 'warn' | 'error';
  meta?: string;
}) => (
  <div className="tr-path-header">
    {badge && <span className={`tr-badge tr-badge-${badgeKind ?? 'info'}`}>{badge}</span>}
    <span className="tr-path" title={path}>{path}</span>
    {meta && <span className="tr-meta">{meta}</span>}
  </div>
);

const ReadRenderer = ({ input, result }: { input: any; result: any }) => {
  const filePath: string = input?.file_path || result?.file?.filePath || '';
  const offset: number | undefined = input?.offset;
  const limit: number | undefined = input?.limit;
  const file = result?.file ?? {};
  const totalLines: number | undefined = file.totalLines;
  const numLines: number | undefined = file.numLines;
  // Sub-agent transcripts carry the result as plain text rather than the
  // structured `{file: …}` envelope the main session records.
  const content: string | undefined =
    file.content ?? (typeof result === 'string' ? result : undefined);
  const startLine = offset && offset > 0 ? offset : 1;

  let metaParts: string[] = [];
  if (typeof numLines === 'number' && typeof totalLines === 'number') {
    metaParts.push(`${numLines}/${totalLines} lines`);
  } else if (typeof totalLines === 'number') {
    metaParts.push(`${totalLines} lines`);
  }
  if (offset) metaParts.push(`from line ${offset}`);
  if (limit) metaParts.push(`limit ${limit}`);
  if (file.originalSize) metaParts.push(`${formatSize(file.originalSize)}`);

  return (
    <div className="tr-block">
      <PathHeader path={filePath} meta={metaParts.join(' · ')} />
      {content ? (
        <CodeBlock
          code={content}
          language={langFromPath(filePath)}
          startLine={startLine}
        />
      ) : (
        <div className="tr-empty">No content body returned with this read.</div>
      )}
    </div>
  );
};

const WriteRenderer = ({ input, result }: { input: any; result: any }) => {
  const filePath: string = input?.file_path || result?.filePath || '';
  const content: string = input?.content ?? result?.content ?? '';
  const isCreate = result?.type === 'create';
  return (
    <div className="tr-block">
      {/* "CREATE" is not the tool name repeated — it distinguishes a new file
          from an overwrite, which the header can't tell you. */}
      <PathHeader
        path={filePath}
        badge={isCreate ? 'CREATE' : undefined}
        badgeKind="success"
        meta={`${content.split('\n').length} lines · ${formatSize(content.length)}`}
      />
      <CodeBlock code={content} language={langFromPath(filePath)} />
    </div>
  );
};

interface DiffSpec {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

const DiffView = ({ filePath, spec }: { filePath: string; spec: DiffSpec }) => {
  const lang = langFromPath(filePath);
  const parts = useMemo(
    () => diffLines(spec.oldString || '', spec.newString || ''),
    [spec.oldString, spec.newString]
  );
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    if (p.added) added += p.count ?? 0;
    if (p.removed) removed += p.count ?? 0;
  }
  return (
    <div className="tr-diff">
      <div className="tr-diff-stats">
        <span className="tr-diff-add">+{added}</span>
        <span className="tr-diff-del">−{removed}</span>
        {spec.replaceAll && <span className="tr-diff-flag">replace_all</span>}
      </div>
      <div className="tr-diff-body">
        {parts.map((part, i) => {
          const lines = part.value.split('\n');
          if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
          const cls = part.added ? 'tr-diff-add-line' : part.removed ? 'tr-diff-del-line' : 'tr-diff-ctx-line';
          const sign = part.added ? '+' : part.removed ? '−' : ' ';
          return lines.map((ln, j) => (
            <div key={`${i}-${j}`} className={`tr-diff-line ${cls}`}>
              <span className="tr-diff-sign">{sign}</span>
              <span
                className="tr-diff-content"
                dangerouslySetInnerHTML={{ __html: safeHighlight(ln || ' ', lang) }}
              />
            </div>
          ));
        })}
      </div>
    </div>
  );
};

const EditRenderer = ({ input, result }: { input: any; result: any }) => {
  const filePath: string = input?.file_path || result?.filePath || '';
  const oldString: string = input?.old_string ?? result?.oldString ?? '';
  const newString: string = input?.new_string ?? result?.newString ?? '';
  const replaceAll: boolean = input?.replace_all ?? result?.replaceAll ?? false;
  return (
    <div className="tr-block">
      <PathHeader path={filePath} />
      <DiffView filePath={filePath} spec={{ oldString, newString, replaceAll }} />
    </div>
  );
};

const MultiEditRenderer = ({ input, result }: { input: any; result: any }) => {
  const filePath: string = input?.file_path || result?.filePath || '';
  const edits: any[] = input?.edits || [];
  return (
    <div className="tr-block">
      <PathHeader
        path={filePath}
        meta={`${edits.length} edit${edits.length === 1 ? '' : 's'}`}
      />
      <div className="tr-multi-edits">
        {edits.map((e, i) => (
          <div key={i} className="tr-multi-edit-item">
            <div className="tr-multi-edit-header">Edit {i + 1}</div>
            <DiffView
              filePath={filePath}
              spec={{
                oldString: e.old_string ?? '',
                newString: e.new_string ?? '',
                replaceAll: e.replace_all,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

const BashRenderer = ({ input, result }: { input: any; result: any }) => {
  const cmd: string = input?.command || '';
  let stdout = '';
  let stderr = '';
  let interrupted = false;
  let exitCode: number | undefined;
  if (typeof result === 'object' && result !== null) {
    stdout = String(result.stdout ?? '');
    stderr = String(result.stderr ?? '');
    interrupted = !!result.interrupted;
    exitCode = result.exit_code ?? result.exitCode;
  } else if (typeof result === 'string') {
    stdout = result;
  }
  const errored = exitCode !== undefined ? exitCode !== 0 : !!stderr.trim();

  return (
    <div className="tr-block tr-bash">
      {/* Only exit state lives here now — the tool name is in the step header
          and the description was promoted there too. */}
      {(interrupted || exitCode !== undefined) && (
        <div className="tr-bash-header">
          {interrupted && <span className="tr-badge tr-badge-warn">interrupted</span>}
          {exitCode !== undefined && (
            <span className={`tr-badge ${errored ? 'tr-badge-error' : 'tr-badge-success'}`}>
              exit {exitCode}
            </span>
          )}
        </div>
      )}
      <div className="tr-bash-cmd">
        <span className="tr-bash-prompt">$</span>
        <span
          className="tr-bash-cmd-text"
          dangerouslySetInnerHTML={{ __html: safeHighlight(cmd, 'bash') }}
        />
      </div>
      {stdout && (
        <pre className="tr-bash-stdout">
          <code>{stdout}</code>
        </pre>
      )}
      {stderr && (
        <pre className="tr-bash-stderr">
          <code>{stderr}</code>
        </pre>
      )}
    </div>
  );
};

const GrepRenderer = ({ input, result }: { input: any; result: any }) => {
  const pattern: string = input?.pattern || '';
  const path: string | undefined = input?.path;
  const glob: string | undefined = input?.glob;
  const outputMode: string | undefined = input?.output_mode;
  const text =
    typeof result === 'string' ? result : result?.content ?? result?.matches ?? '';
  const lines = String(text).split('\n').filter((l) => l.trim().length > 0);

  return (
    <div className="tr-block">
      <div className="tr-grep-header">
        <code className="tr-grep-pattern">{pattern}</code>
        {path && <span className="tr-meta">in {path}</span>}
        {glob && <span className="tr-meta">glob: {glob}</span>}
        {outputMode && <span className="tr-meta">{outputMode}</span>}
        <span className="tr-meta">{lines.length} match{lines.length === 1 ? '' : 'es'}</span>
      </div>
      <pre className="tr-grep-body">
        <code>{lines.join('\n')}</code>
      </pre>
    </div>
  );
};

const GlobRenderer = ({ input, result }: { input: any; result: any }) => {
  const pattern: string = input?.pattern || '';
  const path: string | undefined = input?.path;
  const text = typeof result === 'string' ? result : result?.content ?? '';
  const files = String(text).split('\n').filter((l) => l.trim().length > 0);

  return (
    <div className="tr-block">
      <div className="tr-grep-header">
        <code className="tr-grep-pattern">{pattern}</code>
        {path && <span className="tr-meta">in {path}</span>}
        <span className="tr-meta">{files.length} file{files.length === 1 ? '' : 's'}</span>
      </div>
      <ul className="tr-glob-list">
        {files.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
    </div>
  );
};

const TaskRenderer = ({ input, result }: { input: any; result: any }) => {
  // Coerce every field to a primitive so React never sees an object/array
  // child. Older sessions occasionally carry odd shapes here that crashed
  // the previous render path.
  const asStr = (v: unknown): string =>
    v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
  const asNum = (v: unknown): number | undefined =>
    typeof v === 'number' && !Number.isNaN(v) ? v : undefined;

  const inputObj = input && typeof input === 'object' ? input : {};
  const resultObj = result && typeof result === 'object' && !Array.isArray(result) ? result : {};

  const prompt: string = asStr(inputObj.prompt);
  const subagentType: string = asStr(inputObj.subagent_type);
  const agentId: string = asStr(resultObj.agentId);
  const status: string = asStr(resultObj.status);
  const totalDurationMs = asNum(resultObj.totalDurationMs);
  const totalTokens = asNum(resultObj.totalTokens);
  const totalToolUseCount = asNum(resultObj.totalToolUseCount);
  const content: string =
    typeof result === 'string' ? result : asStr(resultObj.content);

  return (
    <div className="tr-block">
      {/* The description is the step header's subtitle now; the agent type is
          the one thing here the header doesn't carry. */}
      {subagentType && (
        <div className="tr-task-header">
          <span className="tr-task-type">{subagentType}</span>
        </div>
      )}
      {(agentId || status) && (
        <div className="tr-task-meta">
          {status && <span className={`tr-badge tr-badge-${status === 'completed' ? 'success' : 'info'}`}>{status}</span>}
          {totalDurationMs !== undefined && <span className="tr-meta">{formatDuration(totalDurationMs)}</span>}
          {totalTokens !== undefined && <span className="tr-meta">{totalTokens.toLocaleString()} tokens</span>}
          {totalToolUseCount !== undefined && <span className="tr-meta">{totalToolUseCount} tool calls</span>}
          {agentId && <span className="tr-meta tr-mono">{agentId.slice(0, 8)}</span>}
        </div>
      )}
      <div className="tr-task-prompt">
        <div className="tr-section-label">Prompt</div>
        <pre className="tr-text">{prompt}</pre>
      </div>
      {content && (
        <div className="tr-task-result">
          <div className="tr-section-label">Result</div>
          <pre className="tr-text">{content}</pre>
        </div>
      )}
    </div>
  );
};

const TodoWriteRenderer = ({ input }: { input: any; result: any }) => {
  const todos: any[] = input?.todos || [];
  return (
    <div className="tr-block">
      <div className="tr-todo-header">
        <span className="tr-meta">{todos.length} item{todos.length === 1 ? '' : 's'}</span>
      </div>
      <ul className="tr-todo-list">
        {todos.map((t, i) => {
          const status = t.status || 'pending';
          const text = t.activeForm && status === 'in_progress' ? t.activeForm : t.content || '';
          return (
            <li key={i} className={`tr-todo-item tr-todo-${status}`}>
              <span className="tr-todo-icon" aria-hidden>
                {status === 'completed' ? '✓' : status === 'in_progress' ? '◐' : '○'}
              </span>
              <span className="tr-todo-text">{text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const WebFetchRenderer = ({ input, result }: { input: any; result: any }) => {
  const url: string = input?.url || '';
  const prompt: string | undefined = input?.prompt;
  const content =
    typeof result === 'string'
      ? result
      : result?.content || result?.text || JSON.stringify(result, null, 2);
  return (
    <div className="tr-block">
      <div className="tr-task-header">
        <a href={url} className="tr-link" target="_blank" rel="noreferrer">{url}</a>
      </div>
      {prompt && (
        <div className="tr-task-prompt">
          <div className="tr-section-label">Prompt</div>
          <pre className="tr-text">{prompt}</pre>
        </div>
      )}
      <div className="tr-task-result">
        <div className="tr-section-label">Result</div>
        <pre className="tr-text">{content}</pre>
      </div>
    </div>
  );
};

const WebSearchRenderer = ({ input, result }: { input: any; result: any }) => {
  const query: string = input?.query || '';
  const content =
    typeof result === 'string' ? result : result?.content || JSON.stringify(result, null, 2);
  return (
    <div className="tr-block">
      <div className="tr-task-header">
        <code className="tr-grep-pattern">{query}</code>
      </div>
      <pre className="tr-text">{content}</pre>
    </div>
  );
};

const AskUserQuestionRenderer = ({ input, result }: { input: any; result: any }) => {
  const call = useMemo(() => parseAskUserQuestion(input, result), [input, result]);

  if (call.questions.length === 0) {
    return <div className="tr-empty">No questions recorded for this ask.</div>;
  }

  return (
    <div className="tr-block">
      {call.questions.map((q, i) => {
        const answer = call.answers[i];
        const picked = new Set(answer.picked);
        // A single-select shows what was taken and what was passed over; a
        // multi-select is a checklist, so unticked options are part of the
        // answer too. Same glyph pair either way, filled vs. empty.
        const [on, off] = q.multiSelect ? ['☑', '☐'] : ['●', '○'];
        return (
          <div className="tr-ask-question" key={i}>
            <div className="tr-ask-head">
              {q.header && <span className="tr-ask-header">{q.header}</span>}
              {q.multiSelect && <span className="tr-badge tr-badge-info">multi</span>}
              {!answer.answered && <span className="tr-badge tr-badge-warn">unanswered</span>}
              <span className="tr-ask-text">{q.question}</span>
            </div>
            <ul className="tr-ask-options">
              {q.options.map((o, j) => {
                const chosen = picked.has(o.label);
                return (
                  <li key={j} className={`tr-ask-option${chosen ? ' tr-ask-option-chosen' : ''}`}>
                    <span className="tr-ask-mark" aria-hidden>{chosen ? on : off}</span>
                    <div className="tr-ask-option-body">
                      <div className="tr-ask-label">{o.label}</div>
                      {o.description && <div className="tr-ask-desc">{o.description}</div>}
                      {/* Previews are mockups several lines tall. The chosen
                          one is the reason the answer reads the way it does, so
                          it opens; the rest stay one line until asked for. */}
                      {o.preview && (
                        <details className="tr-ask-preview" open={chosen}>
                          <summary>preview</summary>
                          <pre>{o.preview}</pre>
                        </details>
                      )}
                    </div>
                  </li>
                );
              })}
              {/* What the user typed under "Other" — never one of the offered
                  options, and on a multi-select it can sit alongside them. */}
              {answer.custom && (
                <li className="tr-ask-option tr-ask-option-chosen tr-ask-option-custom">
                  <span className="tr-ask-mark" aria-hidden>✎</span>
                  <div className="tr-ask-option-body">
                    <div className="tr-ask-label">Own answer</div>
                    <pre className="tr-ask-custom">{answer.custom}</pre>
                  </div>
                </li>
              )}
            </ul>
            {answer.note && (
              <div className="tr-ask-note">
                <span className="tr-ask-note-label">note</span>
                <pre className="tr-ask-custom">{answer.note}</pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/**
 * The base64 payload of a result's attachments. The parser leaves a `[image]`
 * marker in the result text — that is the parsed view — so the raw view has to
 * go back to the host for the bytes the transcript actually holds.
 */
const RawAttachments = ({
  attachments,
  agentId,
  preClass,
}: {
  attachments: Attachment[];
  agentId?: string;
  preClass: string;
}) => {
  const { blobs, request } = useAttachmentBytes(attachments, agentId);

  useEffect(() => {
    for (const attachment of attachments) request(attachment.id);
  }, [attachments, request]);

  return (
    <>
      {attachments.map(attachment => {
        const blob = blobs[attachment.id];
        return (
          <div className="tr-raw-section" key={attachment.id}>
            <div className="tr-section-label">
              {attachment.name} · {attachment.mediaType} (base64)
            </div>
            <pre className={preClass}>
              {blob?.base64 ?? blob?.error ?? 'Loading…'}
            </pre>
          </div>
        );
      })}
    </>
  );
};

const RawView = ({ step, wrap }: { step: Step; wrap?: boolean }) => {
  const result = parseToolResult(step.toolResult);
  const preClass = `tr-code-raw${wrap ? ' tr-code-raw-wrap' : ''}`;
  const attachments = step.attachments ?? [];
  return (
    <div className="tr-raw">
      {step.toolInput !== undefined && (
        <div className="tr-raw-section">
          <div className="tr-section-label">Tool Input</div>
          <pre className={preClass}>{JSON.stringify(step.toolInput, null, 2)}</pre>
        </div>
      )}
      {step.toolResult !== undefined && (
        <div className="tr-raw-section">
          <div className="tr-section-label">Tool Result</div>
          <pre className={preClass}>
            {result.ok && typeof result.value === 'object'
              ? JSON.stringify(result.value, null, 2)
              : String(result.value ?? step.toolResult)}
          </pre>
        </div>
      )}
      {attachments.length > 0 && (
        <RawAttachments attachments={attachments} agentId={step.agentId} preClass={preClass} />
      )}
    </div>
  );
};

// ─── Helpers ──────────────────────────────────────────────────────────────
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
};

// ─── Dispatcher ───────────────────────────────────────────────────────────
const RENDERERS: Record<string, (props: { input: any; result: any }) => JSX.Element> = {
  Read: ReadRenderer,
  Write: WriteRenderer,
  Edit: EditRenderer,
  MultiEdit: MultiEditRenderer,
  Bash: BashRenderer,
  Grep: GrepRenderer,
  Glob: GlobRenderer,
  Task: TaskRenderer,
  Agent: TaskRenderer,
  TodoWrite: TodoWriteRenderer,
  WebFetch: WebFetchRenderer,
  WebSearch: WebSearchRenderer,
  AskUserQuestion: AskUserQuestionRenderer,
};

// pretty = per-tool renderer, raw = JSON dump with horizontal scroll,
// wrap = same dump with long lines folded to the panel width.
type View = 'pretty' | 'raw' | 'wrap';

interface ToolRendererProps {
  step: Step;
  // Rendered at the left of the pretty/raw toolbar — token counts today.
  meta?: React.ReactNode;
}

const ToolRenderer = ({ step, meta }: ToolRendererProps) => {
  const [view, setView] = useState<View>('pretty');
  const tool = step.toolName;
  const renderer = tool ? RENDERERS[tool] : undefined;
  const parsed = useMemo(() => parseToolResult(step.toolResult), [step.toolResult]);
  const attachments = step.attachments ?? [];

  // No tool data at all — nothing to render.
  if (!step.toolInput && !step.toolResult) return null;

  // A result that came back as a picture or a file is already parsed: showing
  // it is showing the attachment. So a tool with no renderer of its own still
  // gets a pretty view when it returned one.
  const hasPretty = !!renderer || attachments.length > 0;
  // Tools without a pretty renderer fall back to Raw, but keep Wrap available.
  const active: View = !hasPretty && view === 'pretty' ? 'raw' : view;
  const isError = step.toolSuccess === false;
  const errorMessage = isError ? extractErrorMessage(parsed.value) : '';

  return (
    <div className={`tool-renderer${isError ? ' tool-renderer-error' : ''}`}>
      <div className="tr-toolbar">
        <div className="tr-toolbar-left">
          {isError && <span className="tr-toolbar-error-badge">ERROR</span>}
          {meta}
        </div>
        {/* Tools without a dedicated renderer (MCP ones especially) still get
            the bar — Raw/Wrap only — so the toolbar's token counts have a
            consistent home. */}
        <div className="tr-toggle">
          {hasPretty && (
            <button
              className={`tr-toggle-btn${active === 'pretty' ? ' active' : ''}`}
              onClick={() => setView('pretty')}
              type="button"
            >
              Pretty
            </button>
          )}
          <button
            className={`tr-toggle-btn${active === 'raw' ? ' active' : ''}`}
            onClick={() => setView('raw')}
            type="button"
            title={hasPretty ? undefined : 'No pretty view for this tool'}
          >
            Raw
          </button>
          <button
            className={`tr-toggle-btn${active === 'wrap' ? ' active' : ''}`}
            onClick={() => setView('wrap')}
            type="button"
            title="Raw view with long lines wrapped to the panel width"
          >
            Wrap
          </button>
        </div>
      </div>

      {/* Error banner — pretty view only. The full message is shown verbatim
          (no truncation) so the operator can debug from a glance. The raw
          view already exposes the same data via the JSON dump. */}
      {active === 'pretty' && isError && errorMessage && (
        <div className="tr-error-banner">
          <div className="tr-error-banner-head">
            <svg
              className="tr-error-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="13" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="tr-error-banner-label">Tool returned an error</span>
          </div>
          <pre className="tr-error-banner-body">{errorMessage}</pre>
        </div>
      )}

      {active === 'pretty' ? (
        <>
          {renderer?.({ input: step.toolInput, result: parsed.value })}
          {attachments.length > 0 && (
            <Attachments attachments={attachments} agentId={step.agentId} />
          )}
        </>
      ) : (
        <RawView step={step} wrap={active === 'wrap'} />
      )}
    </div>
  );
};

export default ToolRenderer;
