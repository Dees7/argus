import { useState, useEffect, useMemo } from 'react';
import { SessionDetail, flattenSessionSteps, isSystemStep } from './types/session';
import { SYSTEM_STEP_TOGGLES, systemToggleOf } from './components/systemSteps';
import { formatModelLabel } from '../../src/types/modelFamily';
import { formatEffortLabel } from '../../src/types/effort';
import StepsTab from './components/StepsTab';
import AnalysisTab from './components/AnalysisTab';
import CostTab from './components/CostTab';
import FlowTab from './components/FlowTab';
import ContextTab from './components/ContextTab';
import PerformanceTab from './components/PerformanceTab';
import InsightsTab from './components/InsightsTab';
import MapTab, { DirEntry } from './components/MapTab';
import SessionNotes from './components/SessionNotes';
import './styles/global.css';
import './styles/App.css';

type Tab = 'steps' | 'analysis' | 'cost' | 'flow' | 'map' | 'context' | 'performance' | 'insights';

function App() {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('steps');
  const [loading, setLoading] = useState(true);
  const [highlightStep, setHighlightStep] = useState<number | null>(null);
  const [mapCwd, setMapCwd] = useState<string>('');
  const [mapEntries, setMapEntries] = useState<DirEntry[]>([]);
  const [stepsSortOrder, setStepsSortOrder] = useState('newest');
  const [stepsAutoExpand, setStepsAutoExpand] = useState<string[]>([]);
  const [hideNotes, setHideNotes] = useState(false);
  // Tab bar / Steps search bar folded away. The extension host owns these
  // flags (global state), so they are the same in every session panel and
  // survive a reload.
  const [tabsCollapsed, setTabsCollapsed] = useState(false);
  const [searchCollapsed, setSearchCollapsed] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  // Which header buttons are pressed — one entry per button, not per kind, so a
  // button that covers two kinds brings both in at once (see `toggleWith` in
  // `systemSteps`). Deliberately local and deliberately not persisted: reading
  // hook errors is something you do while chasing one thing down, not a way to
  // read sessions, so closing the panel puts the timeline back to what the
  // model did.
  const [visibleSystemToggles, setVisibleSystemToggles] = useState<Set<string>>(new Set());
  // Steps left after the Steps tab's own search/filters; null when that tab is
  // closed, in which case the header shows the plain total.
  const [stepsFilteredCount, setStepsFilteredCount] = useState<number | null>(null);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'sessionData') {
        setSession(message.data);
        setLoading(false);
      } else if (message.type === 'config') {
        if (message.data?.stepsSortOrder) {
          setStepsSortOrder(message.data.stepsSortOrder);
        }
        if (Array.isArray(message.data?.stepsAutoExpand)) {
          setStepsAutoExpand(message.data.stepsAutoExpand);
        }
        if (typeof message.data?.hideNotes === 'boolean') {
          setHideNotes(message.data.hideNotes);
        }
        if (typeof message.data?.tabsCollapsed === 'boolean') {
          setTabsCollapsed(message.data.tabsCollapsed);
        }
        if (typeof message.data?.searchCollapsed === 'boolean') {
          setSearchCollapsed(message.data.searchCollapsed);
        }
      } else if (message.type === 'directoryTree') {
        setMapCwd(message.cwd || '');
        setMapEntries(Array.isArray(message.entries) ? message.entries : []);
      }
    };

    window.addEventListener('message', handleMessage);

    if (window.vscodeApi) {
      window.vscodeApi.postMessage({ type: 'ready' });
    }

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Hooks must run unconditionally on every render (Rules of Hooks). Compute
  // the flattened timeline before any early returns.
  //
  // Numbering happens here, over everything the transcript produced, so a
  // step's `globalIndex` is the same whether or not the system steps around it
  // are on screen — the tabs navigate by that number, and it must not move
  // under a highlight because a button was pressed.
  const flatSteps = useMemo(
    () => (session ? flattenSessionSteps(session) : []),
    [session]
  );

  // How many steps each button would bring in — summed over the kinds it
  // covers, so its count is what pressing it actually adds to the timeline.
  const systemStepCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const step of flatSteps) {
      if (!isSystemStep(step)) continue;
      const toggle = systemToggleOf(step.systemKind);
      counts.set(toggle, (counts.get(toggle) ?? 0) + 1);
    }
    return counts;
  }, [flatSteps]);

  // What the Steps tab renders. Also what the header counts, so the number by
  // the tab name always matches the rows underneath it.
  const timelineSteps = useMemo(
    () =>
      flatSteps.filter(
        step => !isSystemStep(step) || visibleSystemToggles.has(systemToggleOf(step.systemKind))
      ),
    [flatSteps, visibleSystemToggles]
  );

  // Every other tab measures the session — cost, context, durations, file
  // dependencies — and a harness event is none of those things. They see the
  // timeline without them. Cost and Context filter this down to main/one
  // agent/everything themselves (see `AgentFilterBar`); the rest still expect
  // `mainSteps`, the main session alone.
  const analyticSteps = useMemo(() => flatSteps.filter(step => !isSystemStep(step)), [flatSteps]);
  const mainSteps = useMemo(
    () => (session ? session.steps.filter(step => !isSystemStep(step)) : []),
    [session]
  );

  // The main session as it sits in the flattened timeline: the same steps as
  // `mainSteps`, but carrying `globalIndex` and still accompanied by the
  // harness events. The Performance tab measures gaps over these — a retry
  // storm has to be able to end a pause it sits in, and a step it links to has
  // to be numbered the way the Steps tab numbers it. Sub-agent steps stay out,
  // so a Task keeps the duration of the whole agent it spawned.
  const mainFlatSteps = useMemo(() => flatSteps.filter(step => !step.agentId), [flatSteps]);

  // "Steps (55)" normally, "Steps (13/55)" while a search or filter narrows it.
  const stepsTabLabel =
    stepsFilteredCount !== null && stepsFilteredCount !== timelineSteps.length
      ? `${stepsFilteredCount}/${timelineSteps.length}`
      : `${timelineSteps.length}`;

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div>
        <p>Loading session data...</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="app-error">
        <p>No session data available</p>
      </div>
    );
  }

  const agentFindingCount = session.subagents.reduce(
    (acc, s) => acc + (s.analysis?.findings?.length ?? 0),
    0
  );
  const findingCount = (session.analysis?.findings?.length ?? 0) + agentFindingCount;
  const agentSubCost = session.subagents.reduce((acc, s) => acc + (s.totalCost || 0), 0);
  const totalCost =
    (session.analysis?.totalCost ?? session.totalCost ?? 0) + agentSubCost;

  const goToStep = (stepIndex: number) => {
    setActiveTab('steps');
    setHighlightStep(stepIndex);
  };

  const formatModel = formatModelLabel;

  // The extension host owns the clipboard in a webview; navigator.clipboard is
  // only the fallback for running the UI outside VS Code (vite dev server).
  const copySessionId = (id: string) => {
    if (window.vscodeApi) {
      window.vscodeApi.postMessage({ type: 'copyToClipboard', text: id });
    } else {
      navigator.clipboard?.writeText(id);
    }
    setIdCopied(true);
    setTimeout(() => setIdCopied(false), 1500);
  };

  // Deleting is entirely the extension host's job: it owns the file paths, the
  // "is this session still running" check and the confirmation dialog — a
  // webview can't show one of its own, window.confirm is blocked here. It
  // closes this panel once the files are gone.
  const deleteSession = () => {
    window.vscodeApi?.postMessage({ type: 'deleteSession' });
  };

  // Flip locally so the bar folds right away, and let the host store it; the
  // host echoes a config message back, which also updates any other panel.
  const toggleTabs = () => {
    const collapsed = !tabsCollapsed;
    setTabsCollapsed(collapsed);
    window.vscodeApi?.postMessage({ type: 'setTabsCollapsed', collapsed });
  };

  const toggleSearch = () => {
    const collapsed = !searchCollapsed;
    setSearchCollapsed(collapsed);
    window.vscodeApi?.postMessage({ type: 'setSearchCollapsed', collapsed });
  };

  // A tab filtered itself and needs the bar back — a query nobody can see is a
  // list that has silently lost rows. Treated as the user having opened it, so
  // it stays open the same way the toggle would.
  const revealSearch = () => {
    if (!searchCollapsed) return;
    setSearchCollapsed(false);
    window.vscodeApi?.postMessage({ type: 'setSearchCollapsed', collapsed: false });
  };

  // Nothing is sent to the host here: these live and die with the panel.
  const toggleSystemKind = (toggle: string) => {
    setVisibleSystemToggles(prev => {
      const next = new Set(prev);
      if (next.has(toggle)) next.delete(toggle);
      else next.add(toggle);
      return next;
    });
  };

  const formatDuration = (ms: number): string => {
    if (!ms) return '';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remainder = sec % 60;
    return `${min}m ${remainder}s`;
  };

  return (
    <div className="app">
      <div className="detail-header">
        <h2 title={session.prompt}>
          {session.customTitle || session.aiTitle || session.prompt}
        </h2>
        <div className="detail-meta">
          <span>{session.project}</span>
          <span className="meta-badge">{formatModel(session.model)}</span>
          {session.effort && (
            <span className="meta-badge meta-badge-effort" title={`Reasoning effort: ${session.effort}`}>
              {formatEffortLabel(session.effort)}
            </span>
          )}
          {session.isArchived && (
            <span className="meta-badge archived" title="Archived in Claude Code">
              Archived
            </span>
          )}
          <span>{formatDuration(session.durationMs)}</span>
          <span className="meta-dim">
            {timelineSteps.length} steps
            {session.subagents.length > 0 && ` · ${session.subagents.length} agents`}
          </span>
          <span className="detail-session-id">
            <span title="Session ID">{session.sessionId}</span>
            <button
              className={`copy-btn ${idCopied ? 'copied' : ''}`}
              onClick={() => copySessionId(session.sessionId)}
              title={idCopied ? 'Copied!' : 'Copy session ID'}
              aria-label="Copy session ID"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="5.75" y="5.75" width="8.5" height="8.5" rx="1.5" />
                <path d="M10.5 3.25v-.5A1 1 0 0 0 9.5 1.75h-6.75A1 1 0 0 0 1.75 2.75V9.5a1 1 0 0 0 1 1h.5" />
              </svg>
            </button>
          </span>

          {/* Fold the tab bar / the Steps search bar away. Carets read the same
              way as everywhere: ^ folds, v brings it back. */}
          <span className="detail-view-toggles">
            <button
              className="view-toggle-btn"
              onClick={toggleTabs}
              title={tabsCollapsed ? 'Show tabs' : 'Hide tabs'}
              aria-label={tabsCollapsed ? 'Show tabs' : 'Hide tabs'}
              aria-expanded={!tabsCollapsed}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.25" />
                <path d="M1.75 6.75h12.5" />
              </svg>
              <svg className="view-toggle-caret" width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                <path
                  d={tabsCollapsed ? 'M3.5 6.25 8 10.75l4.5-4.5' : 'M3.5 9.75 8 5.25l4.5 4.5'}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              className="view-toggle-btn"
              onClick={toggleSearch}
              title={searchCollapsed ? 'Show search bar' : 'Hide search bar'}
              aria-label={searchCollapsed ? 'Show search bar' : 'Hide search bar'}
              aria-expanded={!searchCollapsed}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="7" cy="7" r="4.25" />
                <path d="M10.25 10.25 14 14" strokeLinecap="round" />
              </svg>
              <svg className="view-toggle-caret" width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                <path
                  d={searchCollapsed ? 'M3.5 6.25 8 10.75l4.5-4.5' : 'M3.5 9.75 8 5.25l4.5 4.5'}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            {/* Past the divider the buttons no longer fold anything away —
                each one brings a kind of harness event into the timeline, lit
                while its steps are on screen and carrying how many there are.
                Straight off the registry, minus the kinds that ride on another
                button rather than carrying one of their own. */}
            <span className="view-toggle-divider" />
            {SYSTEM_STEP_TOGGLES.map(info => {
              // A button that covers several kinds is worded for the group, not
              // for whichever kind happens to own it.
              const button = info.button ?? info;
              const count = systemStepCounts.get(info.kind) ?? 0;
              const shown = visibleSystemToggles.has(info.kind);
              const action = shown ? 'Hide' : 'Show';
              return (
                <button
                  key={info.kind}
                  className={`view-toggle-btn system-toggle-btn${shown ? ' active' : ''}`}
                  onClick={() => toggleSystemKind(info.kind)}
                  disabled={count === 0}
                  title={
                    count === 0
                      ? `No ${button.plural} in this session`
                      : `${action} ${button.plural} (${count}) — ${button.hint}`
                  }
                  aria-label={`${action} ${button.plural}`}
                  aria-pressed={shown}
                >
                  <button.Icon size={12} />
                  <span className="view-toggle-count">{count}</span>
                </button>
              );
            })}
          </span>

          {/* Last in the row, pushed to the far edge — deleting a session is
              not something to hit while reaching for the copy button. */}
          <button
            className="delete-btn"
            onClick={deleteSession}
            title="Delete session"
            aria-label="Delete session"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2.5 4.25h11" strokeLinecap="round" />
              <path d="M6.25 4.25v-1.5a1 1 0 0 1 1-1h1.5a1 1 0 0 1 1 1v1.5" />
              <path d="M3.75 4.25 4.4 13.3a1 1 0 0 0 1 .95h5.2a1 1 0 0 0 1-.95l.65-9.05" />
              <path d="M6.75 7v4.25M9.25 7v4.25" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Folded away by the caret next to the delete button; the active tab's
          content (and its own search box) stays where it is. */}
      {!tabsCollapsed && (
        <div className="tab-bar">
          <button
            className={`tab ${activeTab === 'steps' ? 'active' : ''}`}
            onClick={() => setActiveTab('steps')}
          >
            Steps ({stepsTabLabel})
          </button>
          <button
            className={`tab ${activeTab === 'analysis' ? 'active' : ''}`}
            onClick={() => setActiveTab('analysis')}
          >
            Analysis ({findingCount})
          </button>
          <button
            className={`tab ${activeTab === 'cost' ? 'active' : ''}`}
            onClick={() => setActiveTab('cost')}
          >
            Cost (${totalCost.toFixed(2)})
          </button>
          <button
            className={`tab ${activeTab === 'flow' ? 'active' : ''}`}
            onClick={() => setActiveTab('flow')}
          >
            Flow
          </button>
          <button
            className={`tab ${activeTab === 'map' ? 'active' : ''}`}
            onClick={() => setActiveTab('map')}
          >
            Map
          </button>
          <button
            className={`tab ${activeTab === 'context' ? 'active' : ''}`}
            onClick={() => setActiveTab('context')}
          >
            Context
          </button>
          <button
            className={`tab ${activeTab === 'performance' ? 'active' : ''}`}
            onClick={() => setActiveTab('performance')}
          >
            Performance
          </button>
          <button
            className={`tab ${activeTab === 'insights' ? 'active' : ''}`}
            onClick={() => setActiveTab('insights')}
          >
            Insights
          </button>
        </div>
      )}

      <div className="tab-content">
        {activeTab === 'steps' && (
          <StepsTab
            steps={timelineSteps}
            allSteps={flatSteps}
            subagents={session.subagents}
            mainEffort={session.effort}
            findings={session.analysis?.findings || []}
            highlightStep={highlightStep}
            defaultSortMode={stepsSortOrder}
            autoExpand={stepsAutoExpand}
            hideControls={searchCollapsed}
            onFilteredCountChange={setStepsFilteredCount}
            onRevealControls={revealSearch}
          />
        )}
        {activeTab === 'analysis' && (
          <AnalysisTab
            analysis={session.analysis}
            steps={mainSteps}
            subagents={session.subagents}
            flatSteps={analyticSteps}
            sessionTotalCost={session.totalCost}
            onGoToStep={goToStep}
          />
        )}
        {activeTab === 'cost' && (
          <CostTab
            steps={analyticSteps}
            subagents={session.subagents}
            analysis={session.analysis}
            onGoToStep={goToStep}
          />
        )}
        {activeTab === 'flow' && (
          <FlowTab
            steps={analyticSteps}
            onGoToStep={goToStep}
          />
        )}
        {activeTab === 'map' && (
          <MapTab
            steps={analyticSteps}
            cwd={mapCwd || session.project}
            topLevelEntries={mapEntries}
            onGoToStep={goToStep}
          />
        )}
        {activeTab === 'context' && (
          <ContextTab
            steps={analyticSteps}
            subagents={session.subagents}
            analysis={session.analysis}
            onGoToStep={goToStep}
          />
        )}
        {activeTab === 'performance' && (
          <PerformanceTab
            steps={mainFlatSteps}
            onGoToStep={goToStep}
          />
        )}
        {activeTab === 'insights' && (
          <InsightsTab
            steps={mainSteps}
            flatSteps={analyticSteps}
            analysis={session.analysis}
            filesRead={session.filesRead}
            filesWritten={session.filesWritten}
            onGoToStep={goToStep}
          />
        )}

        {/* Session Notes — hidden by argus.notes.hideNotes; saved notes stay in
            localStorage and come back when the setting is turned off again. */}
        {!hideNotes && <SessionNotes sessionId={session.sessionId} />}
      </div>
    </div>
  );
}

export default App;

declare global {
  interface Window {
    vscodeApi?: {
      postMessage: (message: any) => void;
      getState: () => any;
      setState: (state: any) => void;
    };
  }
}
