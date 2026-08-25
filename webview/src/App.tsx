import { useState, useEffect, useMemo } from 'react';
import { SessionDetail, flattenSessionSteps } from './types/session';
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
  const [idCopied, setIdCopied] = useState(false);

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
  const flatSteps = useMemo(
    () => (session ? flattenSessionSteps(session) : []),
    [session]
  );

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

  const formatModel = (model: string): string => {
    if (!model) return '';
    if (model.includes('opus')) return 'Opus';
    if (model.includes('sonnet')) return 'Sonnet';
    if (model.includes('haiku')) return 'Haiku';
    return model;
  };

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
        <h2 title={session.prompt}>{session.aiTitle || session.prompt}</h2>
        <div className="detail-meta">
          <span>{session.project}</span>
          <span className="meta-badge">{formatModel(session.model)}</span>
          <span>{formatDuration(session.durationMs)}</span>
          <span className="meta-dim">
            {flatSteps.length} steps
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
        </div>
      </div>

      <div className="tab-bar">
        <button
          className={`tab ${activeTab === 'steps' ? 'active' : ''}`}
          onClick={() => setActiveTab('steps')}
        >
          Steps ({flatSteps.length})
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

      <div className="tab-content">
        {activeTab === 'steps' && (
          <StepsTab
            steps={flatSteps}
            subagents={session.subagents}
            findings={session.analysis?.findings || []}
            highlightStep={highlightStep}
            defaultSortMode={stepsSortOrder}
            autoExpand={stepsAutoExpand}
          />
        )}
        {activeTab === 'analysis' && (
          <AnalysisTab
            analysis={session.analysis}
            steps={session.steps}
            subagents={session.subagents}
            flatSteps={flatSteps}
            sessionTotalCost={session.totalCost}
            onGoToStep={goToStep}
          />
        )}
        {activeTab === 'cost' && (
          <CostTab
            steps={session.steps}
            analysis={session.analysis}
            sessionTotalCost={session.totalCost}
            onGoToStep={goToStep}
          />
        )}
        {activeTab === 'flow' && (
          <FlowTab
            steps={flatSteps}
            onGoToStep={goToStep}
          />
        )}
        {activeTab === 'map' && (
          <MapTab
            steps={flatSteps}
            cwd={mapCwd || session.project}
            topLevelEntries={mapEntries}
            onGoToStep={goToStep}
          />
        )}
        {activeTab === 'context' && (
          <ContextTab
            steps={session.steps}
            analysis={session.analysis}
            onGoToStep={goToStep}
          />
        )}
        {activeTab === 'performance' && (
          <PerformanceTab
            steps={session.steps}
            onGoToStep={goToStep}
          />
        )}
        {activeTab === 'insights' && (
          <InsightsTab
            steps={session.steps}
            analysis={session.analysis}
            filesRead={session.filesRead}
            filesWritten={session.filesWritten}
            onGoToStep={goToStep}
          />
        )}

        {/* Session Notes */}
        <SessionNotes sessionId={session.sessionId} />
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
