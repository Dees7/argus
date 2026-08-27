import * as path from 'path';
import * as vscode from 'vscode';
import { DiscoveryService } from './services/discoveryService';
import { ParserService } from './services/parserService';
import { AnalyzerService } from './services/analyzerService';
import { SearchService } from './services/searchService';
import { SessionWebviewProviderReact } from './providers/sessionWebviewProviderReact';
import { SessionListViewProvider } from './providers/sessionListViewProvider';
import { DatePickerPanel } from './providers/datePickerPanel';
import {
  FilterState,
  DEFAULT_FILTER_STATE,
  GROUP_MODES,
  GroupMode,
  DatePreset,
  SessionSummary,
} from './types/models';
import { collectModelFilterOptions, modelFamilyKey } from './types/modelFamily';
import { getClaudeConfigDir } from './utils/claudePaths';

export function activate(context: vscode.ExtensionContext) {
  // Initialize services
  const discoveryService = new DiscoveryService();
  const parserService = new ParserService();
  const analyzerService = new AnalyzerService();
  const searchService = new SearchService();

  // Initialize providers
  const webviewProvider = new SessionWebviewProviderReact(
    context,
    discoveryService,
    parserService,
    analyzerService
  );

  // Filter state. The "current project only" toggle and the grouping mode are
  // remembered in the extension's global state (VS Code's own storage, not any
  // file in the workspace), so they survive reloads and apply in every window.
  const PROJECT_FILTER_KEY = 'argus.filter.onlyCurrentProject';
  const GROUP_MODE_KEY = 'argus.group.mode';

  /** Stored modes come from an earlier install, so treat unknown ones as default. */
  function storedGroupMode(): GroupMode {
    const stored = context.globalState.get<string>(GROUP_MODE_KEY);
    return GROUP_MODES.includes(stored as GroupMode)
      ? (stored as GroupMode)
      : DEFAULT_FILTER_STATE.groupMode;
  }

  let filterState: FilterState = {
    ...DEFAULT_FILTER_STATE,
    onlyCurrentProject: context.globalState.get<boolean>(PROJECT_FILTER_KEY, false),
    groupMode: storedGroupMode(),
  };
  let allSessions: SessionSummary[] = [];

  // Ids matching the current full-text query. `null` means no full-text filter
  // is in effect (the toggle is off, or the query is empty).
  let contentMatches: Set<string> | null = null;
  let searchGeneration = 0;

  // --- Filtering logic ---

  const normalizeModel = modelFamilyKey;

  /** Last two segments of a path — the shape `SessionSummary.project` uses. */
  function humanProjectName(pathStr: string): string {
    const parts = pathStr.split(path.sep).filter(p => p);
    if (parts.length === 0) {
      return pathStr;
    }
    return parts.slice(-2).join('/');
  }

  /**
   * True when the session ran inside one of the open workspace folders. Older
   * sessions may have no recorded cwd; those fall back to matching the display
   * name, which is all the discovery step could recover for them.
   */
  function isCurrentProject(s: SessionSummary, folders: string[]): boolean {
    if (s.projectPath) {
      const p = path.normalize(s.projectPath);
      return folders.some(f => p === f || p.startsWith(f + path.sep));
    }
    return folders.some(f => s.project === humanProjectName(f));
  }

  function applyFilters(sessions: SessionSummary[]): SessionSummary[] {
    let result = sessions;

    // Current-project filter. With no folder open there is no "current
    // project" to compare against, so the toggle simply has no effect.
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f =>
      path.normalize(f.uri.fsPath)
    );
    if (filterState.onlyCurrentProject && folders.length > 0) {
      result = result.filter(s => isCurrentProject(s, folders));
    }

    // Text search. Session ids are matched too so a UUID pasted from a log or
    // a transcript path resolves to its session. With the "*" toggle on,
    // transcript contents count as a match as well.
    const q = filterState.searchQuery.toLowerCase().trim();
    if (q) {
      result = result.filter(s =>
        s.prompt.toLowerCase().includes(q) ||
        (s.aiTitle ?? '').toLowerCase().includes(q) ||
        s.project.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q) ||
        (contentMatches !== null && contentMatches.has(s.sessionId))
      );
    }

    // Model filter
    if (filterState.selectedModels.length > 0) {
      result = result.filter(s =>
        filterState.selectedModels.includes(normalizeModel(s.model))
      );
    }

    // Date filter
    const now = Date.now();
    switch (filterState.datePreset) {
      case '1h':
        result = result.filter(s => now - s.lastModified.getTime() < 60 * 60 * 1000);
        break;
      case '3h':
        result = result.filter(s => now - s.lastModified.getTime() < 3 * 60 * 60 * 1000);
        break;
      case '6h':
        result = result.filter(s => now - s.lastModified.getTime() < 6 * 60 * 60 * 1000);
        break;
      case '24h':
        result = result.filter(s => now - s.lastModified.getTime() < 24 * 60 * 60 * 1000);
        break;
      case '7d':
        result = result.filter(s => now - s.lastModified.getTime() < 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        result = result.filter(s => now - s.lastModified.getTime() < 30 * 24 * 60 * 60 * 1000);
        break;
      case 'custom': {
        const from = filterState.customDateFrom ?? 0;
        const to = filterState.customDateTo ?? Infinity;
        result = result.filter(s => {
          const t = s.lastModified.getTime();
          return t >= from && t <= to;
        });
        break;
      }
    }

    return result;
  }

  function refreshList() {
    const filtered = applyFilters(allSessions);
    // Options come from every session, not the filtered ones — otherwise
    // picking a model would remove every other choice from the dropdown.
    listViewProvider.updateSessions(
      filtered,
      filterState,
      collectModelFilterOptions(allSessions.map(s => s.model))
    );
  }

  /**
   * Re-run the full-text scan for the current query. Scanning every transcript
   * takes a moment, so the previous result stays on screen (with the spinner
   * up) instead of blanking the list, and a scan superseded by newer input is
   * dropped rather than rendered.
   */
  async function runContentSearch() {
    const query = filterState.searchQuery.trim();

    if (!filterState.searchAllContent || !query) {
      searchService.cancel();
      listViewProvider.setSearching(false);
      if (contentMatches !== null) {
        contentMatches = null;
        refreshList();
      }
      return;
    }

    const gen = ++searchGeneration;
    listViewProvider.setSearching(true);

    try {
      if (discoveryService.getSearchTargets().length === 0) {
        await ensureSessions();
      }

      const matches = await searchService.search(query, discoveryService.getSearchTargets());
      if (matches === null || gen !== searchGeneration) {
        return; // Superseded by a newer query.
      }

      contentMatches = matches;
      refreshList();
    } catch (error) {
      console.error('Full-text search failed:', error);
    } finally {
      if (gen === searchGeneration) {
        listViewProvider.setSearching(false);
      }
    }
  }

  // Coalesce concurrent discovery requests so the view-open path and the
  // activation path don't both walk ~/.claude at the same time.
  let discoveryPromise: Promise<void> | null = null;

  function ensureSessions(): Promise<void> {
    if (discoveryPromise) {
      return discoveryPromise;
    }
    discoveryPromise = (async () => {
      try {
        await discoveryService.refreshDiscovery();
        searchService.invalidate();
        allSessions = discoveryService.getSessionSummaries();
        refreshList();
      } finally {
        discoveryPromise = null;
      }
    })();
    return discoveryPromise;
  }

  /**
   * Session a watched transcript belongs to. Sub-agent transcripts live in
   * `<projectDir>/<sessionId>/subagents/*.jsonl` and have no index entry of
   * their own, so they resolve to the parent session that spawned them.
   */
  function sessionIdForPath(fsPath: string): string | null {
    const parts = path.normalize(fsPath).split(path.sep);
    const subagentsAt = parts.lastIndexOf('subagents');
    if (subagentsAt > 0) {
      return parts[subagentsAt - 1] || null;
    }
    const name = parts[parts.length - 1];
    return name?.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : null;
  }

  // Claude Code appends one line at a time, so a single turn arrives as a
  // burst of change events. Collect the sessions they touched and re-read only
  // those, instead of walking the whole index on every write.
  const pendingSessionRefreshes = new Set<string>();
  let sessionRefreshTimer: NodeJS.Timeout | undefined;

  function queueSessionRefresh(sessionId: string) {
    pendingSessionRefreshes.add(sessionId);
    // Fixed window rather than a sliding one: a session being written to
    // continuously would keep pushing a sliding deadline out forever.
    if (sessionRefreshTimer) {
      return;
    }
    sessionRefreshTimer = setTimeout(() => {
      sessionRefreshTimer = undefined;
      void flushSessionRefreshes();
    }, 400);
  }

  async function flushSessionRefreshes() {
    const ids = [...pendingSessionRefreshes];
    pendingSessionRefreshes.clear();
    if (ids.length === 0) {
      return;
    }

    // An id that isn't indexed means we missed its create event (or it landed
    // while discovery was still running). Fall back to a full pass, otherwise
    // that session would stay invisible until the next restart.
    if (ids.some(id => !discoveryService.hasSession(id))) {
      await discoveryService.refreshDiscovery();
      searchService.invalidate();
    } else {
      // Deliberately no searchService.invalidate() here: appends happen
      // constantly and dropping the full-text cache on each one would make
      // every search re-scan ~200 MB of transcripts.
      await discoveryService.refreshSessions(ids);
    }

    allSessions = discoveryService.getSessionSummaries();
    refreshList();
  }

  function syncContextKeys() {
    const models = filterState.selectedModels;
    vscode.commands.executeCommand('setContext', 'argus.filter.opus', models.includes('opus'));
    vscode.commands.executeCommand('setContext', 'argus.filter.sonnet', models.includes('sonnet'));
    vscode.commands.executeCommand('setContext', 'argus.filter.haiku', models.includes('haiku'));
    vscode.commands.executeCommand('setContext', 'argus.filter.date', filterState.datePreset);
    vscode.commands.executeCommand('setContext', 'argus.group', filterState.groupMode);
    vscode.commands.executeCommand(
      'setContext',
      'argus.filter.currentProject',
      filterState.onlyCurrentProject
    );
  }

  function toggleModel(model: string) {
    const idx = filterState.selectedModels.indexOf(model);
    if (idx >= 0) {
      filterState.selectedModels.splice(idx, 1);
    } else {
      filterState.selectedModels.push(model);
    }
    syncContextKeys();
    refreshList();
  }

  function setDatePreset(preset: DatePreset) {
    filterState.datePreset = preset;
    if (preset !== 'custom') {
      filterState.customDateFrom = undefined;
      filterState.customDateTo = undefined;
    }
    syncContextKeys();
    refreshList();
  }

  function setGroupMode(mode: GroupMode) {
    filterState.groupMode = mode;
    void context.globalState.update(GROUP_MODE_KEY, mode);
    syncContextKeys();
    refreshList();
  }

  // Initialize context keys
  syncContextKeys();

  // Register session list webview view
  const listViewProvider = new SessionListViewProvider(
    context.extensionPath,
    (query) => {
      filterState.searchQuery = query;
      syncContextKeys();
      refreshList();
      void runContentSearch();
    },
    (all) => {
      filterState.searchAllContent = all;
      void runContentSearch();
    },
    (sessionId) => {
      vscode.commands.executeCommand('argus.openSessionDetail', sessionId);
    },
    (model) => {
      filterState.selectedModels = model ? [model] : [];
      syncContextKeys();
      refreshList();
    },
    (preset, from, to) => {
      filterState.datePreset = preset as any;
      if (preset === 'custom') {
        filterState.customDateFrom = from;
        filterState.customDateTo = to;
      } else {
        filterState.customDateFrom = undefined;
        filterState.customDateTo = undefined;
      }
      syncContextKeys();
      refreshList();
    }
  );

  // When the view is first opened with no cached data, run a real discovery
  // instead of just re-filtering an empty list.
  listViewProvider.setRefreshCallback(() => { void ensureSessions(); });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SessionListViewProvider.viewId, listViewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Show/hide the model selector live. Hiding it would otherwise leave an
  // invisible model filter applied, so drop the filter along with the control.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('argus.searchBar.showModelSelector')) {
        return;
      }
      const visible = vscode.workspace
        .getConfiguration('argus')
        .get<boolean>('searchBar.showModelSelector', true);
      listViewProvider.setModelSelectorVisible(visible);
      if (!visible && filterState.selectedModels.length > 0) {
        filterState.selectedModels = [];
        syncContextKeys();
        refreshList();
      }
    })
  );

  // Model / project in the subtitle of each session item.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        !e.affectsConfiguration('argus.sessionList.showModel') &&
        !e.affectsConfiguration('argus.sessionList.showProject')
      ) {
        return;
      }
      const cfg = vscode.workspace.getConfiguration('argus');
      listViewProvider.setSessionMetaVisible(
        cfg.get<boolean>('sessionList.showModel', true),
        cfg.get<boolean>('sessionList.showProject', true)
      );
    })
  );

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand('argus.refreshSessions', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Argus: Refreshing sessions...' },
        async () => {
          try {
            await discoveryService.refreshDiscovery();
            searchService.invalidate();
            allSessions = discoveryService.getSessionSummaries();
            refreshList();
            await runContentSearch();
            vscode.window.showInformationMessage(`Sessions refreshed (${allSessions.length} found)`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage('Failed to refresh sessions: ' + msg);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('argus.openSessionDetail', async (sessionId: string) => {
      try {
        await webviewProvider.openSessionDetail(sessionId);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage('Failed to open session: ' + msg);
      }
    })
  );

  // Re-read the index after a session panel deleted its transcript. The file
  // watcher below notices too, but only after the OS event round-trip, which
  // would leave the deleted session sitting in the list in the meantime.
  context.subscriptions.push(
    vscode.commands.registerCommand('argus.sessionsChanged', async () => {
      await discoveryService.refreshDiscovery();
      searchService.invalidate();
      allSessions = discoveryService.getSessionSummaries();
      refreshList();
    })
  );

  // Model toggles
  context.subscriptions.push(
    vscode.commands.registerCommand('argus.toggleModelOpus', () => toggleModel('opus')),
    vscode.commands.registerCommand('argus.toggleModelSonnet', () => toggleModel('sonnet')),
    vscode.commands.registerCommand('argus.toggleModelHaiku', () => toggleModel('haiku'))
  );

  // Date presets
  context.subscriptions.push(
    vscode.commands.registerCommand('argus.setDateAll', () => setDatePreset('all')),
    vscode.commands.registerCommand('argus.setDate1h', () => setDatePreset('1h')),
    vscode.commands.registerCommand('argus.setDate3h', () => setDatePreset('3h')),
    vscode.commands.registerCommand('argus.setDate6h', () => setDatePreset('6h')),
    vscode.commands.registerCommand('argus.setDate24h', () => setDatePreset('24h')),
    vscode.commands.registerCommand('argus.setDate7d', () => setDatePreset('7d')),
    vscode.commands.registerCommand('argus.setDate30d', () => setDatePreset('30d'))
  );

  // Custom date range
  context.subscriptions.push(
    vscode.commands.registerCommand('argus.setDateCustom', () => {
      DatePickerPanel.show(context, (from, to) => {
        filterState.datePreset = 'custom';
        filterState.customDateFrom = from;
        filterState.customDateTo = to;
        syncContextKeys();
        refreshList();
      });
    })
  );

  // Current-project filter. Both ids run the same toggle; they exist only so
  // the title bar can show a filled icon while the filter is on.
  function toggleProjectFilter() {
    filterState.onlyCurrentProject = !filterState.onlyCurrentProject;
    void context.globalState.update(PROJECT_FILTER_KEY, filterState.onlyCurrentProject);
    syncContextKeys();
    refreshList();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('argus.filterCurrentProjectOn', toggleProjectFilter),
    vscode.commands.registerCommand('argus.filterCurrentProjectOff', toggleProjectFilter)
  );

  // Opening or closing a folder changes what "current project" means.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (filterState.onlyCurrentProject) {
        refreshList();
      }
    })
  );

  // Grouping
  context.subscriptions.push(
    vscode.commands.registerCommand('argus.setGroupNone', () => setGroupMode('none')),
    vscode.commands.registerCommand('argus.setGroupProject', () => setGroupMode('project')),
    vscode.commands.registerCommand('argus.setGroupModel', () => setGroupMode('model')),
    vscode.commands.registerCommand('argus.setGroupDate', () => setGroupMode('date'))
  );

  // Initial discovery — fire and forget; ensureSessions dedupes against the
  // view-open path if the user clicks Argus before this finishes.
  void ensureSessions();

  // Watch for session file changes under the user's Claude config directory.
  // Use an absolute RelativePattern so the watcher fires regardless of which
  // folder is open in VS Code (workspace-relative globs would only match
  // files inside the workspace).
  const projectsDir = path.join(getClaudeConfigDir(), 'projects');
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(projectsDir), '**/*.jsonl')
  );

  watcher.onDidCreate(async () => {
    await discoveryService.refreshDiscovery();
    searchService.invalidate();
    allSessions = discoveryService.getSessionSummaries();
    refreshList();
  });

  watcher.onDidChange(uri => {
    const sessionId = sessionIdForPath(uri.fsPath);
    if (sessionId) {
      queueSessionRefresh(sessionId);
    }
  });

  watcher.onDidDelete(async () => {
    await discoveryService.refreshDiscovery();
    searchService.invalidate();
    allSessions = discoveryService.getSessionSummaries();
    refreshList();
  });

  context.subscriptions.push(watcher);

  // `isActive` is a function of wall-clock time, so a session that stops being
  // written produces no event to clear its live dot. Re-project the index on a
  // timer, but only while something is actually marked live — otherwise this
  // is a no-op comparison and costs nothing.
  const liveTicker = setInterval(() => {
    if (allSessions.some(s => s.isActive)) {
      allSessions = discoveryService.getSessionSummaries();
      refreshList();
    }
  }, 30 * 1000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(liveTicker);
      if (sessionRefreshTimer) {
        clearTimeout(sessionRefreshTimer);
      }
    },
  });

  // Status bar item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(pulse) Argus';
  statusBarItem.tooltip = 'Claude Code Session Debugger';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
}

export function deactivate() {}
