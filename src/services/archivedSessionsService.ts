import * as fs from 'fs';
import { readStateDbItem } from '../utils/vscodeStateDb';

/**
 * Which sessions the user archived in Claude Code's own VS Code extension.
 *
 * Archiving is not recorded in the transcript: Claude Code keeps the ids in its
 * extension `globalState`, under the key below, and hides them from its session
 * list. Argus lists every transcript it finds, so the flag is only used as a
 * mark — an archived session stays in the list, it just says so.
 *
 * The state database is polled rather than watched: it is VS Code's shared
 * store, written on all sorts of unrelated activity, so a watcher would fire
 * constantly for a value that changes a few times a day. A stat guards every
 * read, and the file is only parsed when its mtime moved.
 */

/** Key Claude Code's extension state lives under in `ItemTable`. */
const CLAUDE_CODE_STATE_KEY = 'Anthropic.claude-code';
/** Field inside that state holding the archived (hidden) session ids. */
const ARCHIVED_IDS_FIELD = 'hiddenSessionIds';

export class ArchivedSessionsService {
  /** Shortest gap between two stats of the state database. */
  private static readonly STAT_INTERVAL_MS = 2000;

  private ids: Set<string> = new Set();
  private lastMtimeMs = -1;
  private lastStatAt = 0;

  /** `undefined` when the host gave us no state database to read. */
  constructor(private readonly dbPath: string | undefined) {}

  /** True when Claude Code has this session archived. */
  isArchived(sessionId: string): boolean {
    this.refreshIfStale();
    return this.ids.has(sessionId);
  }

  /**
   * Re-read the archived ids, ignoring the stat interval. Returns whether the
   * set changed, so callers can re-render the list only when it did.
   */
  refresh(): boolean {
    this.lastStatAt = Date.now();

    if (!this.dbPath) {
      return false;
    }

    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.dbPath).mtimeMs;
    } catch {
      // No state database (a host that stores state elsewhere, or a first run
      // before VS Code wrote one): nothing is archived as far as we know.
      const had = this.ids.size > 0;
      this.ids = new Set();
      this.lastMtimeMs = -1;
      return had;
    }

    if (mtimeMs === this.lastMtimeMs) {
      return false;
    }
    this.lastMtimeMs = mtimeMs;

    const next = this.readIds();
    if (next.size === this.ids.size && [...next].every(id => this.ids.has(id))) {
      return false; // The file moved on, but for some other extension's key.
    }
    this.ids = next;
    return true;
  }

  private refreshIfStale(): void {
    if (Date.now() - this.lastStatAt >= ArchivedSessionsService.STAT_INTERVAL_MS) {
      this.refresh();
    }
  }

  private readIds(): Set<string> {
    const raw = this.dbPath ? readStateDbItem(this.dbPath, CLAUDE_CODE_STATE_KEY) : null;
    if (!raw) {
      return new Set();
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const ids = parsed?.[ARCHIVED_IDS_FIELD];
      if (!Array.isArray(ids)) {
        return new Set();
      }
      return new Set(ids.filter((id): id is string => typeof id === 'string'));
    } catch {
      return new Set(); // Half-written JSON; the next poll will pick it up.
    }
  }
}
