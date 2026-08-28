/**
 * Terminal output that reached the transcript with its colours still attached.
 *
 * A `/context` dump, a `ls --color`, a test runner — anything that decided it
 * was writing to a TTY — lands in the JSONL as text with ESC sequences baked
 * in. Rendered as prose those bytes are invisible, so the pretty view showed a
 * dump whose alignment and emphasis had silently been dropped on the floor.
 *
 * Detection is deliberately narrow: `hasAnsi` looks for an SGR sequence — ESC
 * `[` … `m`, the one that sets colour — and nothing else. ESC (0x1B) is a
 * control byte no prose, no Markdown and no source file carries, so text
 * without terminal colours cannot match, and every caller keeps the exact
 * behaviour it had before. Cursor moves, OSC titles and the rest are stripped
 * when rendering but never count as evidence of colour on their own.
 */

// Matches one escape sequence of any kind: CSI (the `[` family, SGR included),
// OSC (terminated by BEL or ST), and the two-character escapes.
const ANSI_ANY = /\u001b(?:\[[0-9;:?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

// SGR alone — this is the colour test. Not global: `test` must stay stateless.
const SGR_ONLY = /\u001b\[[0-9;:]*m/;

/** True when the text carries terminal colour/emphasis codes. */
export const hasAnsi = (text: string): boolean => SGR_ONLY.test(text);

/** The same text as a terminal would print it once the codes are consumed. */
export const stripAnsi = (text: string): string => text.replace(ANSI_ANY, '');

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ─── Palette ──────────────────────────────────────────────────────────────
// The 16 named colours resolve against the user's VS Code terminal theme, so a
// transcript looks like the terminal it was captured from; the literals are
// the defaults of VS Code's own Dark+ for the webview themes that lack them.
const NAMES = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];
const NORMAL = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5'];
const BRIGHT = ['#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];

const named = (index: number): string => {
  const bright = index > 7;
  const slot = index % 8;
  const varName = `--vscode-terminal-ansi${bright ? 'Bright' : ''}${NAMES[slot]}`;
  return `var(${varName}, ${(bright ? BRIGHT : NORMAL)[slot]})`;
};

/** xterm-256: 0-15 named, 16-231 the 6×6×6 cube, 232-255 the grey ramp. */
const indexed = (n: number): string => {
  if (n < 16) return named(n);
  if (n < 232) {
    const i = n - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${level(Math.floor(i / 36) % 6)},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`;
  }
  const grey = 8 + (n - 232) * 10;
  return `rgb(${grey},${grey},${grey})`;
};

const channel = (v: number) => Math.max(0, Math.min(255, v | 0));

// ─── State ────────────────────────────────────────────────────────────────
interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
}

/**
 * Fold one SGR parameter list into the running style.
 *
 * Colons are treated as separators alongside semicolons: the ITU-T form
 * (`38:2::R:G:B`) carries an empty colour-space field that drops out with the
 * other empties, leaving the same numbers as the common `38;2;R;G;B`.
 */
const applyCodes = (style: Style, params: string): Style => {
  const codes = params
    .split(/[;:]/)
    .filter(part => part !== '')
    .map(Number)
    .filter(n => Number.isFinite(n));
  // A bare `ESC[m` means reset, same as `ESC[0m`.
  if (codes.length === 0) return {};

  let next: Style = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) { next = {}; continue; }
    if (code === 1) { next.bold = true; continue; }
    if (code === 2) { next.dim = true; continue; }
    if (code === 3) { next.italic = true; continue; }
    if (code === 4) { next.underline = true; continue; }
    if (code === 7) { next.inverse = true; continue; }
    if (code === 9) { next.strike = true; continue; }
    if (code === 21 || code === 22) { next.bold = false; next.dim = false; continue; }
    if (code === 23) { next.italic = false; continue; }
    if (code === 24) { next.underline = false; continue; }
    if (code === 27) { next.inverse = false; continue; }
    if (code === 29) { next.strike = false; continue; }
    if (code >= 30 && code <= 37) { next.fg = named(code - 30); continue; }
    if (code >= 40 && code <= 47) { next.bg = named(code - 40); continue; }
    if (code >= 90 && code <= 97) { next.fg = named(code - 90 + 8); continue; }
    if (code >= 100 && code <= 107) { next.bg = named(code - 100 + 8); continue; }
    if (code === 39) { next.fg = undefined; continue; }
    if (code === 49) { next.bg = undefined; continue; }
    if (code === 38 || code === 48) {
      const mode = codes[i + 1];
      let colour: string | undefined;
      if (mode === 5) {
        colour = indexed(codes[i + 2]);
        i += 2;
      } else if (mode === 2) {
        colour = `rgb(${channel(codes[i + 2])},${channel(codes[i + 3])},${channel(codes[i + 4])})`;
        i += 4;
      } else {
        // An extended-colour form we don't know: skip the code rather than
        // reading its arguments as styles of their own.
        i += 1;
      }
      if (colour) {
        if (code === 38) next.fg = colour;
        else next.bg = colour;
      }
      continue;
    }
    // Everything else (blink, fonts, overline, …) has no useful web analogue.
  }
  return next;
};

const openTag = (style: Style): string => {
  // Reverse video with no explicit pair swaps against the panel's own colours,
  // which is what a terminal does with its default fg/bg.
  const fg = style.inverse ? style.bg ?? 'var(--bg)' : style.fg;
  const bg = style.inverse ? style.fg ?? 'var(--text)' : style.bg;

  const css: string[] = [];
  if (fg) css.push(`color:${fg}`);
  if (bg) css.push(`background-color:${bg}`);
  if (style.bold) css.push('font-weight:600');
  // Dim is a brightness reduction in the terminal; opacity is the closest
  // thing that works over whatever colour is underneath.
  if (style.dim) css.push('opacity:0.7');
  if (style.italic) css.push('font-style:italic');
  const decoration = [style.underline && 'underline', style.strike && 'line-through'].filter(Boolean);
  if (decoration.length) css.push(`text-decoration:${decoration.join(' ')}`);

  return css.length ? `<span style="${css.join(';')}">` : '';
};

/**
 * Progress bars redraw a line by returning to its start, so only the text
 * after the last CR is what the line ended up saying. Codes dropped with the
 * overwritten prefix could have left a colour open — a cosmetic loss on a line
 * that, by construction, was never meant to be read in its earlier states.
 */
const applyCarriageReturns = (text: string): string =>
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n');

/**
 * Terminal text as HTML: colours become spans, every other escape is dropped.
 * The output is built from this module's own literals plus HTML-escaped text,
 * so it is safe for `dangerouslySetInnerHTML`.
 */
export const ansiToHtml = (text: string): string => {
  const source = applyCarriageReturns(text);
  const re = new RegExp(ANSI_ANY.source, 'g');
  let out = '';
  let cursor = 0;
  let style: Style = {};

  const emit = (slice: string) => {
    if (!slice) return;
    const open = openTag(style);
    out += open ? `${open}${escapeHtml(slice)}</span>` : escapeHtml(slice);
  };

  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    emit(source.slice(cursor, match.index));
    cursor = re.lastIndex;
    const sgr = /^\u001b\[([0-9;:]*)m$/.exec(match[0]);
    if (sgr) style = applyCodes(style, sgr[1]);
  }
  emit(source.slice(cursor));
  return out;
};
