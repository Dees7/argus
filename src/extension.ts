import * as path from 'path';
import * as vscode from 'vscode';
import { DiscoveryService } from './services/discoveryService';
import { ParserService } from './services/parserService';
import { AnalyzerService } from './services/analyzerService';
import { SearchService } from './services/searchService';
import { SessionWebviewProviderReact } from './providers/sessionWebviewProviderReact';
import { SessionListViewProvider } from './providers/sessionListViewProvider';
import { DatePickerPanel } from './providers/datePickerPanel';
import { FilterState, DEFAULT_FILTER_STATE, GroupMode, DatePreset, SessionSummary } from './types/models';
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

  // Filter state. The "current project only" toggle is remembered in the
  // extension's global state (VS Code's own storage, not any file in the
  // workspace), so it survives reloads and applies in every window.
  const PROJECT_FILTER_KEY = 'argus.filter.onlyCurrentProject';
  let filterState: FilterState = {
    ...DEFAULT_FILTER_STATE,
    onlyCurrentProject: context.globalState.get<boolean>(PROJECT_FILTER_KEY, false),
  };
  let allSessions: SessionSummary[] = [];

  // Ids matching the current full-text query. `null` means no full-text filter
  // is in effect (the toggle is off, or the query is empty).
  let contentMatches: Set<string> | null = null;
  let searchGeneration = 0;

  // --- Filtering logic ---

  function normalizeModel(model: string): string {
    if (model.includes('opus')) return 'opus';
    if (model.includes('sonnet')) return 'sonnet';
    if (model.includes('haiku')) return 'haiku';
    return 'unknown';
  }

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
    listViewProvider.updateSessions(filtered, filterState);
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
        allSessions = await discoveryService.getSessionList();
        refreshList();
      } finally {
        discoveryPromise = null;
      }
    })();
    return discoveryPromise;
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

    const hasActive =
      filterState.searchQuery !== '' ||
      filterState.selectedModels.length > 0 ||
      filterState.datePreset !== 'all' ||
      filterState.groupMode !== 'none';
    vscode.commands.executeCommand('setContext', 'argus.hasActiveFilters', hasActive);
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

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand('argus.refreshSessions', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Argus: Refreshing sessions...' },
        async () => {
          try {
            await discoveryService.refreshDiscovery();
            searchService.invalidate();
            allSessions = await discoveryService.getSessionList();
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

  // Clear filters
  context.subscriptions.push(
    vscode.commands.registerCommand('argus.clearFilters', () => {
      // The project toggle is a persisted preference with its own button, not
      // part of the ad-hoc filter set this command clears.
      filterState = {
        ...DEFAULT_FILTER_STATE,
        onlyCurrentProject: filterState.onlyCurrentProject,
      };
      searchService.cancel();
      contentMatches = null;
      listViewProvider.clearSearch();
      listViewProvider.setSearching(false);
      syncContextKeys();
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
    vscode.commands.registerCommand('argus.setGroupModel', () => setGroupMode('model'))
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
    allSessions = await discoveryService.getSessionList(true);
    refreshList();
  });

  watcher.onDidChange(async () => {
    allSessions = await discoveryService.getSessionList();
    refreshList();
  });

  watcher.onDidDelete(async () => {
    await discoveryService.refreshDiscovery();
    allSessions = await discoveryService.getSessionList(true);
    refreshList();
  });

  context.subscriptions.push(watcher);

  // Status bar item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(pulse) Argus';
  statusBarItem.tooltip = 'Claude Code Session Debugger';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
}

export function deactivate() {}
