import { useMemo } from 'react';
import hljs from 'highlight.js';
import { ansiToHtml, hasAnsi } from '../utils/ansi';
import './resultBlocks.css';

/**
 * A tool result that came back as content blocks rather than as one string.
 *
 * Two families produce them and they overlap:
 *
 *  - the API's own `tool_result.content` — `text`, `image`, `search_result`,
 *    `document`, `tool_reference` (what ToolSearch loads), `browser_state`;
 *  - MCP servers — `text`, `image`, `audio`, `resource` (a document inlined by
 *    uri), `resource_link` (one pointed at), optionally wrapped in
 *    `{content, structuredContent, isError}`.
 *
 * None of them had a pretty view before: a tool with no renderer of its own
 * fell through to the JSON dump, which for an MCP call meant reading its
 * output through a wall of `\n` escapes. This renders every type above, and
 * anything it does not know by name still lands as readable JSON rather than
 * disappearing.
 */
export type ResultBlock = Record<string, any>;

const KNOWN_TYPES = new Set([
  'text',
  'image',
  'audio',
  'resource',
  'resource_link',
  'tool_reference',
  'search_result',
  'document',
  'browser_state',
]);

const isBlock = (value: unknown): value is ResultBlock =>
  !!value && typeof value === 'object' && typeof (value as any).type === 'string';

/**
 * The block list inside a result, or null when the result is not block-shaped.
 * A list of objects that all carry a `type` but none of it recognised is
 * rejected: those are a tool's own records — rows, matches, alerts — and the
 * JSON dump reads them better than a stack of "unknown block" cards would.
 */
export const asResultBlocks = (result: unknown): ResultBlock[] | null => {
  const list: unknown = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && Array.isArray((result as any).content)
      ? (result as any).content
      : null;
  if (!Array.isArray(list) || list.length === 0) return null;
  if (!list.every(isBlock)) return null;
  if (!list.some(block => KNOWN_TYPES.has((block as ResultBlock).type))) return null;
  return list as ResultBlock[];
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const highlight = (code: string, lang: string): string => {
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
};

/** Re-indented JSON, when the text is JSON at all. */
const reindentJson = (text: string): string | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== 'object') return null;
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
};

const Json = ({ value }: { value: unknown }) => {
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }, [value]);
  return (
    <pre className="rb-json">
      <code
        className="hljs language-json"
        dangerouslySetInnerHTML={{ __html: highlight(text, 'json') }}
      />
    </pre>
  );
};

/**
 * A text payload as whatever it turns out to be. MCP servers answer in JSON
 * far more often than in prose, and a one-line JSON string is unreadable until
 * it is indented; a command's captured output keeps its colours.
 */
const TextBody = ({ text }: { text: string }) => {
  const json = useMemo(() => reindentJson(text), [text]);
  if (json !== null) {
    return (
      <pre className="rb-json">
        <code
          className="hljs language-json"
          dangerouslySetInnerHTML={{ __html: highlight(json, 'json') }}
        />
      </pre>
    );
  }
  if (hasAnsi(text)) {
    return (
      <pre className="rb-text">
        <code dangerouslySetInnerHTML={{ __html: ansiToHtml(text) }} />
      </pre>
    );
  }
  return <pre className="rb-text">{text}</pre>;
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

/** What a `source` holds, said in one line: a size, a link, or a file id. */
const describeSource = (source: any): { text: string; url?: string } => {
  if (!source || typeof source !== 'object') return { text: 'no source' };
  if (source.type === 'url' && typeof source.url === 'string') {
    return { text: source.url, url: source.url };
  }
  if (source.type === 'file' && typeof source.file_id === 'string') {
    return { text: `file ${source.file_id}` };
  }
  if (typeof source.data === 'string') {
    // The bytes themselves never reach here: the parser leaves their size
    // behind and the picture is rendered from the attachment below. Older
    // sessions, parsed before it did, still carry the payload.
    const marker = /^\[base64 · (\d+) bytes\]$/.exec(source.data);
    const bytes = marker ? Number(marker[1]) : Math.floor((source.data.length * 3) / 4);
    return { text: formatSize(bytes) };
  }
  return { text: source.type ? String(source.type) : 'no source' };
};

/** Header line shared by the blocks that are a payload with a label on it. */
const BlockHead = ({
  kind,
  title,
  meta,
  url,
}: {
  kind: string;
  title?: string;
  meta?: string;
  url?: string;
}) => (
  <div className="rb-head">
    <span className="rb-kind">{kind}</span>
    {url ? (
      <a className="tr-link rb-title" href={url} target="_blank" rel="noreferrer">
        {title || url}
      </a>
    ) : (
      title && <span className="rb-title">{title}</span>
    )}
    {meta && <span className="tr-meta">{meta}</span>}
  </div>
);

/**
 * One block. Both spellings of every payload are read: the API nests bytes
 * under `source`, MCP puts them flat on the block with `mimeType` beside them.
 */
const BlockView = ({ block }: { block: ResultBlock }) => {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? <TextBody text={block.text} /> : <Json value={block} />;

    case 'image':
    case 'audio': {
      const source = block.source ?? block;
      const media =
        source.media_type || block.mimeType || (block.type === 'image' ? 'image' : 'audio');
      const described = describeSource(source);
      return (
        <BlockHead
          kind={block.type}
          title={media}
          url={described.url}
          meta={
            described.url
              ? undefined
              : `${described.text}${block.type === 'image' ? ' · shown below' : ''}`
          }
        />
      );
    }

    // MCP: the document itself, inlined. Text resources are the common case;
    // a binary one arrives as `blob` and only its uri is worth showing.
    case 'resource': {
      const resource = block.resource ?? {};
      const uri = typeof resource.uri === 'string' ? resource.uri : '';
      const text = typeof resource.text === 'string' ? resource.text : '';
      return (
        <div className="rb-nested">
          <BlockHead
            kind="resource"
            title={uri}
            url={/^https?:/.test(uri) ? uri : undefined}
            meta={resource.mimeType}
          />
          {text ? (
            <TextBody text={text} />
          ) : (
            <div className="rb-note">
              {typeof resource.blob === 'string' ? 'binary contents' : 'no contents'}
            </div>
          )}
        </div>
      );
    }

    // MCP: a pointer to a document rather than the document.
    case 'resource_link': {
      const uri = typeof block.uri === 'string' ? block.uri : '';
      return (
        <div className="rb-nested">
          <BlockHead
            kind="link"
            title={block.name || uri}
            url={/^https?:/.test(uri) ? uri : undefined}
            meta={block.mimeType}
          />
          {block.description && <div className="rb-note">{block.description}</div>}
          {block.name && uri && uri !== block.name && <div className="rb-uri">{uri}</div>}
        </div>
      );
    }

    case 'search_result': {
      const inner: any[] = Array.isArray(block.content) ? block.content : [];
      const source = typeof block.source === 'string' ? block.source : '';
      return (
        <div className="rb-nested">
          <BlockHead
            kind="result"
            title={block.title || source}
            url={/^https?:/.test(source) ? source : undefined}
          />
          {inner.map((c, i) =>
            typeof c?.text === 'string' ? <TextBody key={i} text={c.text} /> : <Json key={i} value={c} />
          )}
        </div>
      );
    }

    case 'document': {
      const source = block.source ?? {};
      const described = describeSource(source);
      // `plain_text` and `content` sources carry the document inline; a PDF or
      // a file id does not, so only its size or link is left to show.
      const inline =
        typeof source.data === 'string' && source.type === 'text'
          ? source.data
          : typeof source.content === 'string'
            ? source.content
            : '';
      return (
        <div className="rb-nested">
          <BlockHead
            kind="document"
            title={block.title || described.text}
            url={described.url}
            meta={source.media_type}
          />
          {block.context && <div className="rb-note">{block.context}</div>}
          {inline && <TextBody text={inline} />}
        </div>
      );
    }

    // Browser state: the tab inventory after a browser tool call.
    case 'browser_state': {
      const tabs: any[] = Array.isArray(block.tabs) ? block.tabs : [];
      return (
        <div className="rb-nested">
          <BlockHead kind="browser" meta={`${tabs.length} tab${tabs.length === 1 ? '' : 's'}`} />
          <ul className="rb-tabs">
            {tabs.map((tab, i) => (
              <li key={i} className={`rb-tab${tab?.active ? ' rb-tab-active' : ''}`}>
                {tab?.active && <span className="rb-dot" aria-hidden>●</span>}
                <span className="rb-tab-title">{tab?.title || tab?.url || `tab ${i + 1}`}</span>
                {tab?.url && tab?.title && <span className="rb-uri">{tab.url}</span>}
              </li>
            ))}
          </ul>
        </div>
      );
    }

    default:
      return <Json value={block} />;
  }
};

/**
 * The blocks in order, with each run of `tool_reference` folded into one row:
 * they are names, not payloads, and a card apiece would bury the result they
 * belong to.
 */
export const ResultBlocks = ({ blocks }: { blocks: ResultBlock[] }) => {
  const rows = useMemo(() => {
    const out: Array<{ refs: string[] } | { block: ResultBlock }> = [];
    for (const block of blocks) {
      if (block.type === 'tool_reference') {
        const name = typeof block.tool_name === 'string' ? block.tool_name : '';
        const last = out[out.length - 1];
        if (last && 'refs' in last) last.refs.push(name);
        else out.push({ refs: [name] });
        continue;
      }
      out.push({ block });
    }
    return out;
  }, [blocks]);

  return (
    <div className="rb-blocks">
      {rows.map((row, i) =>
        'refs' in row ? (
          <div className="rb-chips" key={i}>
            {row.refs.map((name, j) => (
              <span className="rb-chip" key={j}>
                {name}
              </span>
            ))}
          </div>
        ) : (
          <BlockView block={row.block} key={i} />
        )
      )}
    </div>
  );
};

/**
 * Pretty view for a tool with no renderer of its own — every MCP call, in
 * practice. The arguments come first because an MCP tool name says little on
 * its own: `read_metrics` is the query it was given.
 */
export const ResultBlocksRenderer = ({ input, result }: { input: any; result: any }) => {
  const blocks = useMemo(() => asResultBlocks(result), [result]);
  const args = useMemo(() => {
    if (!input || typeof input !== 'object' || Object.keys(input).length === 0) return '';
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return '';
    }
  }, [input]);
  const isError = result && typeof result === 'object' && (result as any).isError === true;
  const structured = result && typeof result === 'object' ? (result as any).structuredContent : undefined;

  return (
    <div className="tr-block">
      {args && (
        // Open for a short argument list, folded for one that would push the
        // output off the screen.
        <details className="rb-args" open={args.length <= 400}>
          <summary>Arguments</summary>
          <pre className="rb-json">
            <code
              className="hljs language-json"
              dangerouslySetInnerHTML={{ __html: highlight(args, 'json') }}
            />
          </pre>
        </details>
      )}
      {isError && <div className="rb-note rb-note-error">The server flagged this result as an error.</div>}
      {blocks ? <ResultBlocks blocks={blocks} /> : <Json value={result} />}
      {structured !== undefined && (
        <>
          <div className="tr-section-label">Structured content</div>
          <Json value={structured} />
        </>
      )}
    </div>
  );
};

/**
 * ToolSearch: the query it ran and the tools it loaded. The result takes one
 * of two shapes — the harness's own `{matches, query, total_deferred_tools}`,
 * or the API's list of `tool_reference` blocks — and both say the same thing,
 * so both render the same way.
 */
export const ToolSearchRenderer = ({ input, result }: { input: any; result: any }) => {
  const query: string =
    (typeof result?.query === 'string' && result.query) ||
    (typeof input?.query === 'string' && input.query) ||
    '';
  const matches: string[] = useMemo(() => {
    if (Array.isArray(result?.matches)) {
      return result.matches.filter((m: unknown): m is string => typeof m === 'string');
    }
    const blocks = asResultBlocks(result);
    if (blocks) {
      return blocks
        .filter(b => b.type === 'tool_reference' && typeof b.tool_name === 'string')
        .map(b => b.tool_name as string);
    }
    return [];
  }, [result]);

  const total = typeof result?.total_deferred_tools === 'number' ? result.total_deferred_tools : undefined;
  const errorMessage =
    typeof result?.error_message === 'string'
      ? result.error_message
      : typeof result?.error_code === 'string'
        ? result.error_code
        : '';
  const max = typeof input?.max_results === 'number' ? input.max_results : undefined;

  return (
    <div className="tr-block">
      <div className="tr-grep-header">
        <code className="tr-grep-pattern">{query}</code>
        {max !== undefined && <span className="tr-meta">max {max}</span>}
        <span className="tr-meta">
          {matches.length} tool{matches.length === 1 ? '' : 's'} loaded
          {total !== undefined ? ` of ${total} deferred` : ''}
        </span>
      </div>
      {errorMessage ? (
        <div className="rb-note rb-note-error">{errorMessage}</div>
      ) : matches.length > 0 ? (
        <div className="rb-chips">
          {matches.map((name, i) => (
            <span className="rb-chip" key={i}>
              {name}
            </span>
          ))}
        </div>
      ) : (
        <div className="tr-empty">The search loaded no tools.</div>
      )}
    </div>
  );
};
