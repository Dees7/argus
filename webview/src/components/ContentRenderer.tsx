import { useMemo, useState } from 'react';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import { Step } from '../types/session';
import { ansiToHtml, hasAnsi } from '../utils/ansi';
import './ContentRenderer.css';

// ─── Markdown engine with code-block highlighting ───────────────────────
// One Marked instance is reused across renders. The custom code renderer
// runs each fence through highlight.js so prose blocks pick up the same
// styling as the ToolRenderer's code views.
const marked = new Marked();
marked.setOptions({ gfm: true, breaks: true });
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const code = text;
      const language = (lang || '').trim();
      let html: string;
      try {
        if (language && hljs.getLanguage(language)) {
          html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
        } else {
          html = hljs.highlightAuto(code).value;
        }
      } catch {
        html = escapeHtml(code);
      }
      return `<pre class="cr-code"><code class="hljs language-${language || 'plaintext'}">${html}</code></pre>`;
    },
  },
});

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ─── Component ───────────────────────────────────────────────────────────
interface Props {
  step: Step;
  // Rendered at the left of the pretty/raw toolbar — token counts today.
  meta?: React.ReactNode;
}

// Only kinds whose label says more than the step header already does. "Text"
// and "Thinking" would just repeat the step type, so they carry no label.
const KIND_LABEL: Record<string, string> = {
  compact: 'Compaction Summary',
  user: 'User Prompt',
};

// pretty = markdown, raw = verbatim with horizontal scroll, wrap = raw with
// long lines folded to the panel width.
type View = 'pretty' | 'raw' | 'wrap';

const ContentRenderer = ({ step, meta }: Props) => {
  const [view, setView] = useState<View>('pretty');
  const content = step.content || '';
  const kind = step.type;
  const label = KIND_LABEL[kind];

  // Terminal output — a slash command's stdout, above all — is not Markdown:
  // its meaning is in the columns and the colours, both of which Markdown
  // reflows away. So when the text carries colour codes the pretty view shows
  // the terminal instead. The test is the ESC byte (see `utils/ansi`), which
  // prose never contains, so nothing that used to render as Markdown stops.
  const terminal = useMemo(
    () => (content && hasAnsi(content) ? ansiToHtml(content) : ''),
    [content]
  );

  const html = useMemo(() => {
    if (!content || terminal) return '';
    try {
      return marked.parse(content) as string;
    } catch {
      return `<pre>${escapeHtml(content)}</pre>`;
    }
  }, [content, terminal]);

  if (!content) return null;

  return (
    <div className={`content-renderer cr-${kind}`}>
      <div className="cr-toolbar">
        <div className="cr-toolbar-left">
          {label && <span className="cr-kind">{label}</span>}
          {/* Says why Pretty is a terminal here and not the usual Markdown. */}
          {terminal && (
            <span className="cr-ansi-badge" title="Terminal output — ANSI colours rendered">
              ANSI
            </span>
          )}
          {meta}
        </div>
        <div className="cr-toggle">
          <button
            type="button"
            className={`cr-toggle-btn${view === 'pretty' ? ' active' : ''}`}
            onClick={() => setView('pretty')}
          >
            Pretty
          </button>
          <button
            type="button"
            className={`cr-toggle-btn${view === 'raw' ? ' active' : ''}`}
            onClick={() => setView('raw')}
          >
            Raw
          </button>
          <button
            type="button"
            className={`cr-toggle-btn${view === 'wrap' ? ' active' : ''}`}
            onClick={() => setView('wrap')}
            title="Raw view with long lines wrapped to the panel width"
          >
            Wrap
          </button>
        </div>
      </div>
      {view === 'pretty' && terminal ? (
        <pre className="cr-ansi" dangerouslySetInnerHTML={{ __html: terminal }} />
      ) : view === 'pretty' ? (
        <div className="cr-pretty" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className={`cr-raw${view === 'wrap' ? ' cr-raw-wrap' : ''}`}>{content}</pre>
      )}
    </div>
  );
};

export default ContentRenderer;
