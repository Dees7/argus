import * as fs from 'fs';
import * as path from 'path';
import { SessionSummary } from '../types/models';
import { getClaudeConfigDir } from '../utils/claudePaths';
import { ParserService } from './parserService';
import { SearchTarget } from './searchService';

export interface DiscoveredSession {
  sessionId: string;
  filePath: string;
  projectDir: string;
  /** Sub-agent transcripts spawned by this session, if any. */
  subagentFiles: string[];
  project: string;
  /** Absolute cwd of the session, when known ('' otherwise). */
  projectPath: string;
  model: string;
  prompt: string;
  /** Title Claude Code generated for the session, '' when it never did. */
  aiTitle: string;
  timestamp: Date;
  lastModified: Date;
  source: 'history' | 'scan';
}

export interface DiscoveryResult {
  sessions: DiscoveredSession[];
  claudeDirs: string[];
}

interface SessionFileInfo {
  sessionId: string;
  filePath: string;
  projectDir: string;
  subagentFiles: string[];
}

export class DiscoveryService {
  /** How recently a transcript must have been written to count as live. */
  private static readonly ACTIVE_WINDOW_MS = 2 * 60 * 1000;
  /**
   * Past this age, a session is old enough that no sub-agent of it can still
   * be running, so its sub-agent transcripts aren't worth stat-ing.
   */
  private static readonly SUBAGENT_LOOKBACK_MS = 6 * 60 * 60 * 1000;

  private sessionIndex: Map<string, DiscoveredSession> = new Map();
  private claudeDirs: string[] = [];
  private lastDiscovery: Date = new Date(0);
  private parserService: ParserService;

  constructor() {
    this.parserService = new ParserService();
  }

  /**
   * Locate the user's ~/.claude directory if it has a projects/ subdirectory.
   * We intentionally do not scan the rest of the filesystem: it's slow and can
   * make the extension look like it's snooping on user files.
   */
  async findClaudeDirs(): Promise<string[]> {
    const mainClaudeDir = getClaudeConfigDir();
    return this.hasProjectsDir(mainClaudeDir) ? [mainClaudeDir] : [];
  }

  /**
   * Scan a .claude/projects/ directory for session files
   */
  scanProjectsDir(projectsDir: string): SessionFileInfo[] {
    const results: SessionFileInfo[] = [];

    try {
      const projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });

      for (const projEntry of projectEntries) {
        if (!projEntry.isDirectory()) {
          continue;
        }

        const projDir = path.join(projectsDir, projEntry.name);
        const files = fs.readdirSync(projDir, { withFileTypes: true });

        for (const file of files) {
          // Only include direct .jsonl children (not in subdirectories like subagents/)
          if (file.isDirectory() || !file.name.endsWith('.jsonl')) {
            continue;
          }

          const sessionId = file.name.replace('.jsonl', '');
          results.push({
            sessionId,
            filePath: path.join(projDir, file.name),
            projectDir: projDir,
            subagentFiles: this.listSubagentFiles(projDir, sessionId),
          });
        }
      }
    } catch (err) {
      console.error('Error scanning projects dir:', projectsDir, err);
    }

    return results;
  }

  /**
   * Discover all sessions from all .claude directories
   */
  async discoverAllSessions(): Promise<DiscoveryResult> {
    // Step 1: Find all .claude directories
    const claudeDirs = await this.findClaudeDirs();

    // Step 2: Scan all projects directories
    const allFiles = new Map<string, SessionFileInfo>();

    for (const claudeDir of claudeDirs) {
      const projectsDir = path.join(claudeDir, 'projects');
      const files = this.scanProjectsDir(projectsDir);

      for (const file of files) {
        if (!allFiles.has(file.sessionId)) {
          allFiles.set(file.sessionId, file);
        }
      }
    }

    // Step 3: Read history.jsonl for display prompts
    const historyMap = await this.parserService.readHistoryMap();

    // Step 4: Extract metadata from each session file
    const sessions = await this.processMetadataConcurrently(allFiles, historyMap);

    return {
      sessions,
      claudeDirs,
    };
  }

  /**
   * Get session list with caching
   */
  async getSessionList(forceRefresh: boolean = false): Promise<SessionSummary[]> {
    const needsDiscovery =
      forceRefresh ||
      this.sessionIndex.size === 0 ||
      Date.now() - this.lastDiscovery.getTime() > 5 * 60 * 1000; // 5 minutes

    if (needsDiscovery) {
      await this.refreshDiscovery();
    } else {
      await this.refreshChangedSessions();
    }

    return this.getSessionSummaries();
  }

  /**
   * Project the current index into summaries, without touching the filesystem
   * beyond the liveness check. Callers that just refreshed the index use this
   * instead of `getSessionList()` to avoid a second pass over every session.
   *
   * `isActive` depends on wall-clock time, so it is recomputed on every call
   * rather than cached alongside the rest of the metadata.
   */
  getSessionSummaries(): SessionSummary[] {
    const now = Date.now();
    const summaries: SessionSummary[] = [];

    for (const ds of this.sessionIndex.values()) {
      summaries.push({
        sessionId: ds.sessionId,
        prompt: ds.prompt,
        aiTitle: ds.aiTitle || undefined,
        project: ds.project,
        projectPath: ds.projectPath,
        model: ds.model,
        timestamp: ds.timestamp,
        lastModified: ds.lastModified,
        isActive: this.isSessionActive(ds, now),
      });
    }

    // Sort by timestamp descending (newest first)
    summaries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return summaries;
  }

  /** True when the session is still in the index. */
  hasSession(sessionId: string): boolean {
    return this.sessionIndex.has(sessionId);
  }

  /**
   * Liveness check for one named session, guarding destructive actions.
   *
   * Unlike the indexed `isActive`, this re-stats the transcript instead of
   * trusting the cached mtime: a watcher event we missed would otherwise make
   * a running session look dead, and here that is the difference between
   * keeping and losing its history. The coarse age cutoff is skipped too —
   * for a single session the sub-agent stat is cheap.
   */
  isSessionLive(sessionId: string): boolean {
    const ds = this.sessionIndex.get(sessionId);
    if (!ds) {
      return false;
    }

    const now = Date.now();
    try {
      if (now - fs.statSync(ds.filePath).mtimeMs < DiscoveryService.ACTIVE_WINDOW_MS) {
        return true;
      }
    } catch {
      return false; // Transcript is already gone; nothing is writing to it.
    }

    return now - this.latestSubagentMtime(ds) < DiscoveryService.ACTIVE_WINDOW_MS;
  }

  /** Drop a session from the index, after its transcript was deleted. */
  removeSession(sessionId: string): void {
    this.sessionIndex.delete(sessionId);
  }

  /**
   * Re-read metadata for the named sessions only. Used by the file watcher,
   * which knows exactly which transcript changed and has no reason to walk the
   * whole index. Ids that aren't indexed are ignored — the caller is expected
   * to fall back to a full discovery for those.
   */
  async refreshSessions(sessionIds: string[]): Promise<void> {
    const known = sessionIds
      .map(id => this.sessionIndex.get(id))
      .filter((ds): ds is DiscoveredSession => ds !== undefined);

    if (known.length === 0) {
      return;
    }

    const historyMap = await this.parserService.readHistoryMap();

    for (const ds of known) {
      const updated = await this.processSessionFile(
        {
          sessionId: ds.sessionId,
          filePath: ds.filePath,
          projectDir: ds.projectDir,
          subagentFiles: this.listSubagentFiles(ds.projectDir, ds.sessionId),
        },
        historyMap
      );
      if (updated) {
        this.sessionIndex.set(updated.sessionId, updated);
      }
    }
  }

  /**
   * A session counts as live while something is still being written to it.
   *
   * The parent transcript alone is not enough: while a `Task` runs, nothing is
   * appended to it for as long as the sub-agent works, so a busy session would
   * look dead. The sub-agent transcript is the only sign of life in that
   * window, hence the second check — kept behind a coarse age cutoff so the
   * common case (hundreds of long-finished sessions) costs one `stat` each.
   */
  private isSessionActive(ds: DiscoveredSession, now: number): boolean {
    const age = now - ds.lastModified.getTime();
    if (age < DiscoveryService.ACTIVE_WINDOW_MS) {
      return true;
    }
    if (age > DiscoveryService.SUBAGENT_LOOKBACK_MS) {
      return false;
    }
    return now - this.latestSubagentMtime(ds) < DiscoveryService.ACTIVE_WINDOW_MS;
  }

  /** Newest mtime among the session's sub-agent transcripts, 0 when it has none. */
  private latestSubagentMtime(ds: DiscoveredSession): number {
    let latest = 0;
    for (const file of this.listSubagentFiles(ds.projectDir, ds.sessionId)) {
      try {
        latest = Math.max(latest, fs.statSync(file).mtimeMs);
      } catch {
        // Sub-agent file vanished mid-scan; ignore it.
      }
    }
    return latest;
  }

  /**
   * Get session file path from cache
   */
  getSessionFilePath(sessionId: string): { filePath: string; projectDir: string } | undefined {
    const ds = this.sessionIndex.get(sessionId);
    if (ds) {
      return {
        filePath: ds.filePath,
        projectDir: ds.projectDir,
      };
    }
    return undefined;
  }

  /**
   * Every discovered session paired with the transcript files that make it up,
   * for full-text search.
   */
  getSearchTargets(): SearchTarget[] {
    const targets: SearchTarget[] = [];
    for (const ds of this.sessionIndex.values()) {
      targets.push({
        sessionId: ds.sessionId,
        files: [ds.filePath, ...ds.subagentFiles],
      });
    }
    return targets;
  }

  /**
   * Refresh discovery cache
   */
  async refreshDiscovery(): Promise<void> {
    const result = await this.discoverAllSessions();

    this.sessionIndex.clear();
    for (const session of result.sessions) {
      this.sessionIndex.set(session.sessionId, session);
    }

    this.claudeDirs = result.claudeDirs;
    this.lastDiscovery = new Date();
  }

  /**
   * Re-read the metadata of sessions whose transcript grew since we indexed
   * them, without rescanning the whole projects tree. A session gets its
   * `ai-title` only after the first assistant reply, so a session opened
   * moments ago would otherwise sit in the list under its raw prompt until the
   * next full discovery.
   */
  private async refreshChangedSessions(): Promise<void> {
    const stale: string[] = [];

    for (const ds of this.sessionIndex.values()) {
      try {
        const stat = fs.statSync(ds.filePath);
        if (stat.mtime.getTime() !== ds.lastModified.getTime()) {
          stale.push(ds.sessionId);
        }
      } catch {
        // File vanished; leave the cached entry for the next full discovery.
      }
    }

    await this.refreshSessions(stale);
  }

  /**
   * Get list of discovered .claude directories
   */
  getClaudeDirs(): string[] {
    return [...this.claudeDirs];
  }

  // Helper methods

  /**
   * Sub-agent transcripts live in `<projectDir>/<sessionId>/subagents/*.jsonl`.
   * They carry no session file of their own, so full-text search has to reach
   * them through their parent session.
   */
  private listSubagentFiles(projDir: string, sessionId: string): string[] {
    const dir = path.join(projDir, sessionId, 'subagents');
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
        .map(e => path.join(dir, e.name));
    } catch {
      return [];
    }
  }

  private hasProjectsDir(claudeDir: string): boolean {
    try {
      const projectsPath = path.join(claudeDir, 'projects');
      const stat = fs.statSync(projectsPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private async processMetadataConcurrently(
    files: Map<string, SessionFileInfo>,
    historyMap: Map<string, any>
  ): Promise<DiscoveredSession[]> {
    const sessions: DiscoveredSession[] = [];

    for (const info of files.values()) {
      const session = await this.processSessionFile(info, historyMap);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions;
  }

  private async processSessionFile(
    info: SessionFileInfo,
    historyMap: Map<string, any>
  ): Promise<DiscoveredSession | null> {
    const metadata = await this.parserService.quickMetadataWithPrompt(info.filePath);
    if (!metadata) {
      return null;
    }

    const ds: DiscoveredSession = {
      sessionId: info.sessionId,
      filePath: info.filePath,
      projectDir: info.projectDir,
      subagentFiles: info.subagentFiles,
      project: '',
      projectPath: metadata.cwd || '',
      model: metadata.model || 'unknown',
      prompt: '',
      aiTitle: metadata.aiTitle,
      timestamp: new Date(),
      lastModified: new Date(),
      source: 'scan',
    };

    // Get file modification time
    try {
      const stat = fs.statSync(info.filePath);
      ds.lastModified = stat.mtime;
    } catch {
      // ignore
    }

    // Prefer history data for project and timing. The prompt comes from the
    // transcript first: history records the raw keystrokes of the turn, while
    // the transcript keeps the message with the harness's wrappers stripped.
    const historyEntry = historyMap.get(info.sessionId);
    if (historyEntry) {
      ds.source = 'history';
      ds.prompt = metadata.prompt || historyEntry.display;
      if (historyEntry.project) {
        ds.project = this.humanProjectName(historyEntry.project);
        // History records the absolute cwd; prefer it over the transcript's,
        // which is only present when the file carries a `cwd` field.
        ds.projectPath = historyEntry.project;
      }
      ds.timestamp = new Date(historyEntry.timestamp);
    } else {
      ds.source = 'scan';
      ds.prompt = metadata.prompt;

      // Parse timestamp from first event
      if (metadata.firstTimestamp) {
        const parsed = this.parseTimestamp(metadata.firstTimestamp);
        if (parsed) {
          ds.timestamp = parsed;
        } else {
          ds.timestamp = ds.lastModified;
        }
      } else {
        ds.timestamp = ds.lastModified;
      }
    }

    // Derive project name from cwd or directory name
    if (!ds.project) {
      if (metadata.cwd) {
        ds.project = this.humanProjectName(metadata.cwd);
      } else {
        ds.project = this.projectNameFromDir(info.projectDir);
      }
    }

    return ds;
  }

  private humanProjectName(pathStr: string): string {
    const parts = pathStr.split(path.sep).filter(p => p);
    if (parts.length === 0) {
      return pathStr;
    }
    if (parts.length <= 2) {
      return parts.join('/');
    }
    return parts.slice(-2).join('/');
  }

  private projectNameFromDir(dirPath: string): string {
    const base = path.basename(dirPath);
    const parts = base.split('-').filter((p: string) => p);

    if (parts.length === 0) {
      return base;
    }
    if (parts.length <= 2) {
      return parts.join('/');
    }
    return parts.slice(-2).join('/');
  }

  private parseTimestamp(ts: string): Date | null {
    try {
      return new Date(ts);
    } catch {
      return null;
    }
  }
}
