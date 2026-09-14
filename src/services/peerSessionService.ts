import * as fs from 'fs';
import * as path from 'path';
import { getClaudeConfigDir } from '../utils/claudePaths';
import { DiscoveryService } from './discoveryService';
import { SearchService } from './searchService';

/** A Claude Code session that is running right now, as its own process records it. */
export interface LivePeerSession {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  status?: string;
}

/** Where a message went, as far as it can be established. */
export interface PeerResolution {
  sessionId: string;
  /** Working directory of that session — the only hint of *which* project it is. */
  cwd?: string;
  name?: string;
  /** How it was found, so the UI can say why a stale link still works. */
  via: 'registry' | 'transcript';
}

/**
 * Finds the session on the other end of a cross-session message.
 *
 * Two sources, deliberately in this order:
 *
 *  1. **The live registry** — `<claude>/sessions/<pid>.json`, which every
 *     running session writes with its own pid, session id, cwd and name. It is
 *     a handful of small files and answers instantly, but it is keyed by pid
 *     and disappears when the process does.
 *  2. **The transcripts** — both ends of a message record the same `msg_id`
 *     (the sender in its `SendMessage` result, the receiver in the `origin` of
 *     the turn it arrived on), so a full-text scan for that id finds the
 *     counterpart session long after both processes are gone.
 *
 * Neither finding anything is an ordinary outcome, not an error: a peer may
 * have been running under a config directory this window never scans.
 */
export class PeerSessionService {
  private cache = new Map<number, LivePeerSession>();
  private cachedAt = 0;

  // The registry changes whenever a session starts, stops or goes idle, and a
  // resolution is only ever asked for on a click — so a short TTL is enough to
  // keep one click from re-reading the directory several times over.
  private static readonly TTL_MS = 5000;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly search: SearchService
  ) {}

  /** Sessions running right now, keyed by pid. Empty when there is no registry. */
  readLiveSessions(): Map<number, LivePeerSession> {
    const now = Date.now();
    if (now - this.cachedAt < PeerSessionService.TTL_MS) {
      return this.cache;
    }

    const sessions = new Map<number, LivePeerSession>();
    const dir = path.join(getClaudeConfigDir(), 'sessions');

    try {
      for (const name of fs.readdirSync(dir)) {
        // Session state is `<pid>.json`; the `.key` files next to it are the
        // sockets' secrets and are none of our business.
        if (!name.endsWith('.json')) {
          continue;
        }
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
          if (typeof raw?.pid !== 'number' || typeof raw?.sessionId !== 'string') {
            continue;
          }
          sessions.set(raw.pid, {
            pid: raw.pid,
            sessionId: raw.sessionId,
            cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
            name: typeof raw.name === 'string' ? raw.name : undefined,
            status: typeof raw.status === 'string' ? raw.status : undefined,
          });
        } catch {
          // A file being rewritten as we read it — skip it, the next call gets it.
        }
      }
    } catch {
      // No registry at all (older CLI, relocated config): the transcript path
      // still works.
    }

    this.cache = sessions;
    this.cachedAt = now;
    return sessions;
  }

  /**
   * The session a message reached. `pid` and `name` come from the message's
   * `origin` and only mean anything while that session lives; `msgId` works
   * either way but costs a scan, so it is tried last.
   */
  async resolve(query: {
    pid?: number;
    name?: string;
    msgId?: string;
    selfSessionId?: string;
    /**
     * Allow the fallback that reads every transcript. Off by default: opening
     * a step should not cost a full-corpus scan, so the registry answers or
     * the caller asks again once a person has said they want it.
     */
    deep?: boolean;
  }): Promise<PeerResolution | undefined> {
    const live = this.readLiveSessions();

    const fromRegistry = (session: LivePeerSession | undefined): PeerResolution | undefined =>
      session && session.sessionId !== query.selfSessionId
        ? { sessionId: session.sessionId, cwd: session.cwd, name: session.name, via: 'registry' }
        : undefined;

    const byPid = query.pid !== undefined ? fromRegistry(live.get(query.pid)) : undefined;
    if (byPid) {
      return byPid;
    }

    if (query.name) {
      // A name is only an address while its session runs, and the next session
      // in the same project gets a different one — so an ambiguous name is no
      // answer at all.
      const named = [...live.values()].filter(s => s.name === query.name);
      const byName = named.length === 1 ? fromRegistry(named[0]) : undefined;
      if (byName) {
        return byName;
      }
    }

    return query.deep && query.msgId
      ? this.resolveByMsgId(query.msgId, query.selfSessionId)
      : undefined;
  }

  /**
   * The session whose transcript carries this message id, other than our own.
   * Both ends write the id verbatim, so the raw-text search the Sessions view
   * already uses finds it without parsing anything.
   */
  private async resolveByMsgId(
    msgId: string,
    selfSessionId?: string
  ): Promise<PeerResolution | undefined> {
    const hits = await this.search.search(msgId, this.discovery.getSearchTargets());
    if (!hits) {
      return undefined;
    }

    for (const sessionId of hits) {
      if (sessionId === selfSessionId) {
        continue;
      }
      const location = this.discovery.getSessionLocation(sessionId);
      return {
        sessionId,
        cwd: location?.projectPath || location?.project || undefined,
        via: 'transcript',
      };
    }

    return undefined;
  }
}
