import { Step } from '../types/session';

/**
 * What a step did to a path. `create` and `delete` exist because a session's
 * scratch files — a `/tmp` fixture written by `cat > … <<EOF` and removed by
 * `rm` three steps later — are part of the story the Map tells, and neither
 * the file system nor a plain read/write split can recover them afterwards.
 */
export type FileEventKind = 'read' | 'write' | 'create' | 'delete';

/**
 * `tool` — the transcript named the path outright (`Read`, `Write`, `Edit`).
 * `shell` — it was inferred from a `Bash` command line, which is a heuristic:
 * the shell is a programming language, and only its obvious shapes are read.
 */
export type FileEventSource = 'tool' | 'shell';

export interface FileEvent {
  /** Absolute, `/`-separated, no trailing slash. */
  path: string;
  kind: FileEventKind;
  /** `mkdir`, `rm -r` — the node is a folder, not a file. */
  isDir: boolean;
  stepIndex: number;
  agentId?: string;
  source: FileEventSource;
  /**
   * Text the session itself carries for this write — a `Write` body or a
   * heredoc. The only way to look inside a file that no longer exists.
   */
  content?: string;
}

const WINDOWS_ABS = /^[a-zA-Z]:[\\/]/;

const isAbsolute = (p: string) => p.startsWith('/') || WINDOWS_ABS.test(p);

/**
 * Home directory, guessed from the session's cwd, so `~/…` in a shell command
 * resolves to the same node as the absolute path a tool call reported. A cwd
 * that is not under a user directory yields '', and `~` paths are then dropped
 * rather than resolved to something wrong.
 */
export const inferHome = (cwd: string): string => {
  const unix = /^((?:\/Users|\/home)\/[^/]+)/.exec(cwd);
  if (unix) return unix[1];
  const win = /^([a-zA-Z]:[\\/]Users[\\/][^\\/]+)/.exec(cwd);
  return win ? win[1].replace(/\\/g, '/') : '';
};

/**
 * Absolute `/`-separated path with `.` and `..` resolved. Returns '' for
 * anything not worth guessing at — a `~` with no known home, a relative path
 * with no base.
 */
export const resolvePath = (raw: string, base: string, home: string): string => {
  let p = raw.trim();
  if (!p) return '';
  if (WINDOWS_ABS.test(p)) p = p.replace(/\\/g, '/');
  if (p === '~' || p.startsWith('~/')) {
    if (!home) return '';
    p = home + p.slice(1);
  }
  if (!isAbsolute(p)) {
    if (!base) return '';
    p = `${base.replace(/\/+$/, '')}/${p}`;
  }
  const segments = p.split('/');
  const drive = WINDOWS_ABS.test(p) ? segments.shift() ?? '' : '';
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return drive ? `${drive}/${out.join('/')}` : `/${out.join('/')}`;
};

// A `Write` that made a new file, as opposed to one that replaced an existing
// one. Main sessions store the structured body (`{"type":"create",…}`),
// sub-agent transcripts only the sentence the model was shown. Both markers
// sit at the very start of the result, so a file whose *contents* happen to
// contain them cannot be mistaken for one.
const CREATION_MARKER = /"type"\s*:\s*"create"|File created successfully at/;

const isCreation = (step: Step): boolean =>
  typeof step.toolResult === 'string' && CREATION_MARKER.test(step.toolResult.slice(0, 200));

// ---------------------------------------------------------------------------
// Shell parsing
// ---------------------------------------------------------------------------

interface Token {
  text: string;
  op: boolean;
}

/**
 * Heredoc bodies, lifted out of the command before it is tokenized. Two
 * reasons: a body is not shell (a Python script full of `>` and quotes would
 * otherwise read as redirections), and the body of `cat > file <<'EOF'` is
 * exactly the content worth keeping for a file that gets deleted later.
 */
const extractHeredocs = (command: string): { text: string; bodies: string[] } => {
  const lines = command.split('\n');
  const kept: string[] = [];
  const bodies: string[] = [];
  let queued: string[] = [];
  let collecting: { delim: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (collecting) {
      if (line.trim() === collecting.delim) {
        bodies.push(collecting.lines.join('\n'));
        collecting = queued.length ? { delim: queued.shift() as string, lines: [] } : null;
      } else {
        collecting.lines.push(line);
      }
      continue;
    }
    kept.push(line);
    const delims = Array.from(line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)).map(
      (m) => m[2]
    );
    if (delims.length > 0) {
      collecting = { delim: delims[0], lines: [] };
      queued = delims.slice(1);
    }
  }
  // An unterminated heredoc still carries everything it collected.
  if (collecting) bodies.push(collecting.lines.join('\n'));
  return { text: kept.join('\n'), bodies };
};

const OPERATOR_CHARS = new Set([';', '|', '&', '<', '>', '(', ')']);

const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  let word = '';
  let started = false;
  const flush = () => {
    if (started) tokens.push({ text: word, op: false });
    word = '';
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      flush();
      tokens.push({ text: ';', op: true });
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush();
      continue;
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      word += end < 0 ? text.slice(i + 1) : text.slice(i + 1, end);
      started = true;
      i = end < 0 ? text.length : end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === '\\' && j + 1 < text.length) {
          word += text[j + 1];
          j++;
          continue;
        }
        if (text[j] === '"') break;
        word += text[j];
      }
      started = true;
      i = j;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      word += text[i + 1];
      started = true;
      i++;
      continue;
    }
    if (OPERATOR_CHARS.has(ch)) {
      // `2>file` — a bare fd number belongs to the redirection, not to a word.
      if (ch === '>' && /^\d+$/.test(word)) {
        word = '';
        started = false;
      }
      flush();
      let op = ch;
      while (
        i + 1 < text.length &&
        OPERATOR_CHARS.has(text[i + 1]) &&
        text[i + 1] !== '(' &&
        text[i + 1] !== ')'
      ) {
        op += text[i + 1];
        i++;
      }
      tokens.push({ text: op, op: true });
      continue;
    }
    word += ch;
    started = true;
  }
  flush();
  return tokens;
};

/** Paths that cannot be resolved, or that name no real file. */
const isUsablePath = (p: string): boolean => {
  if (!p) return false;
  if (/[$`*?]/.test(p)) return false; // command substitution, variables, globs
  if (p.startsWith('/dev/')) return false;
  return true;
};

const stripFlags = (words: string[]): string[] => words.filter((w) => w && !w.startsWith('-'));

export interface ShellFileEvent {
  path: string;
  kind: FileEventKind;
  isDir: boolean;
  content?: string;
}

/**
 * File events a shell command line implies. Deliberately narrow: only the
 * commands whose effect on the file system is unambiguous from the words
 * alone. Whatever a script does from inside `python3 - <<PY` stays invisible,
 * and that is the right trade — the map shows what it can prove.
 *
 * Reads are not inferred at all: `grep pattern file` and `cat file | head`
 * would need real argument parsing per command to tell a path from a pattern,
 * and a wrong read is noise on every node of the tree.
 */
export const parseShellFileEvents = (
  command: string,
  cwd: string,
  home: string
): ShellFileEvent[] => {
  const { text, bodies } = extractHeredocs(command);
  const tokens = tokenize(text);
  const out: ShellFileEvent[] = [];

  // `cd dir && …` is how a session leaves its cwd, so paths after it resolve
  // against somewhere else.
  let base = cwd;
  let heredocAt = 0;

  let words: string[] = [];
  let writes: Array<{ path: string; append: boolean }> = [];
  let sawHeredoc = false;
  // Set by a redirection operator: the word that follows is its target
  // (`> out.txt`) or a heredoc delimiter (`<<EOF`), never a plain argument.
  let pendingRedirect: { append: boolean; isTarget: boolean } | null = null;

  const flushSegment = () => {
    const body = sawHeredoc ? bodies[heredocAt++] : undefined;
    for (const w of writes) {
      const abs = resolvePath(w.path, base, home);
      if (!abs) continue;
      // A truncating redirect is how sessions make scratch files; an
      // appending one presumes something is already there.
      out.push({ path: abs, kind: w.append ? 'write' : 'create', isDir: false, content: body });
    }

    const head = words[0] === 'sudo' || words[0] === 'command' ? words[1] : words[0];
    const rest = stripFlags(words.slice(head === words[0] ? 1 : 2));
    const push = (raw: string, kind: FileEventKind, isDir: boolean) => {
      const abs = resolvePath(raw, base, home);
      if (abs) out.push({ path: abs, kind, isDir });
    };

    switch (head) {
      case 'cd': {
        const next = rest[0] ? resolvePath(rest[0], base, home) : '';
        if (next) base = next;
        break;
      }
      case 'touch':
      case 'tee':
        rest.forEach((p) => push(p, 'create', false));
        break;
      case 'mkdir':
        rest.forEach((p) => push(p, 'create', true));
        break;
      case 'rm': {
        const recursive = words.some((w) => /^-[a-zA-Z]*[rR]/.test(w));
        rest.forEach((p) => push(p, 'delete', recursive));
        break;
      }
      case 'rmdir':
        rest.forEach((p) => push(p, 'delete', true));
        break;
      case 'cp':
      case 'install':
      case 'ln':
        if (rest.length >= 2) push(rest[rest.length - 1], 'create', false);
        break;
      case 'mv':
        if (rest.length >= 2) {
          rest.slice(0, -1).forEach((p) => push(p, 'delete', false));
          push(rest[rest.length - 1], 'create', false);
        }
        break;
      default:
        break;
    }

    words = [];
    writes = [];
    sawHeredoc = false;
    pendingRedirect = null;
  };

  for (const token of tokens) {
    if (!token.op) {
      if (pendingRedirect) {
        if (pendingRedirect.isTarget) {
          writes.push({ path: token.text, append: pendingRedirect.append });
        }
        pendingRedirect = null;
        continue;
      }
      words.push(token.text);
      continue;
    }
    if (token.text.includes('<')) {
      if (token.text.includes('<<')) sawHeredoc = true;
      pendingRedirect = { append: false, isTarget: false };
      continue;
    }
    if (token.text.includes('>')) {
      // `2>&1` and friends redirect to a descriptor, not to a path.
      pendingRedirect = { append: token.text.includes('>>'), isTarget: !token.text.includes('&') };
      continue;
    }
    flushSegment();
  }
  flushSegment();

  return out.filter((e) => isUsablePath(e.path));
};

// ---------------------------------------------------------------------------

/**
 * Every file the session touched, in step order, from both tool calls and
 * shell commands. Paths come out absolute: a session's cwd is not necessarily
 * where its work happens (skills, dotfiles, `/tmp` fixtures), so the map
 * anchors itself on what it finds instead of on the cwd alone.
 */
export const extractFileEvents = (steps: Step[], cwd: string): FileEvent[] => {
  const home = inferHome(cwd);
  const base = cwd.replace(/\/+$/, '');
  const out: FileEvent[] = [];

  for (const step of steps) {
    // A refused or failed call changed nothing; counting it would paint edits
    // that never landed.
    if (step.toolSuccess === false) continue;
    const tool = step.toolName;
    if (!tool) continue;
    const stepIndex = step.globalIndex ?? step.index;
    const agentId = step.agentId;

    const filePath: unknown = step.toolInput?.file_path ?? step.toolInput?.notebook_path;
    if (typeof filePath === 'string' && filePath) {
      const abs = resolvePath(filePath, base, home);
      if (!abs) continue;
      if (tool === 'Read') {
        out.push({ path: abs, kind: 'read', isDir: false, stepIndex, agentId, source: 'tool' });
      } else if (tool === 'Write') {
        const content =
          typeof step.toolInput?.content === 'string' ? step.toolInput.content : undefined;
        out.push({
          path: abs,
          kind: isCreation(step) ? 'create' : 'write',
          isDir: false,
          stepIndex,
          agentId,
          source: 'tool',
          content,
        });
      } else if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
        out.push({ path: abs, kind: 'write', isDir: false, stepIndex, agentId, source: 'tool' });
      }
      continue;
    }

    if (tool === 'Bash' && typeof step.toolInput?.command === 'string') {
      for (const ev of parseShellFileEvents(step.toolInput.command, base, home)) {
        out.push({ ...ev, stepIndex, agentId, source: 'shell' });
      }
    }
  }

  return out;
};

/**
 * Deepest directory containing every one of these paths — where the tree gets
 * rooted. With everything under the cwd this is the cwd itself, the common
 * case; a session that also wrote to `~/.claude` or `/tmp` anchors higher up
 * instead of hiding those files.
 */
export const commonAncestor = (paths: string[]): string => {
  const usable = paths.filter(Boolean);
  if (usable.length === 0) return '';
  let prefix = usable[0].split('/');
  for (const p of usable.slice(1)) {
    const segments = p.split('/');
    let i = 0;
    while (i < prefix.length && i < segments.length && prefix[i] === segments[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length <= 1) break;
  }
  const joined = prefix.join('/');
  return joined === '' ? '/' : joined;
};
