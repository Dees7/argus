import { useMemo, useState } from 'react';
import { Step, AnalysisResult, Subagent, stepKey } from '../types/session';
import { oncePerResponse } from '../../../src/types/usage';
import { filterStepsByAgent, TOTAL_FILTER, MAIN_FILTER, AgentFilter } from '../utils/agentFilter';
import AgentFilterBar from './AgentFilterBar';
import ContextTimeline from './ContextTimeline';
import RequestWeight from './RequestWeight';
import './ContextTab.css';

interface Props {
  /** Main session and every sub-agent, flattened — see `flattenSessionSteps`. */
  steps: Step[];
  subagents: Subagent[];
  analysis?: AnalysisResult;
  onGoToStep?: (index: number) => void;
}

const ContextTab = ({ steps, subagents, analysis, onGoToStep }: Props) => {
  const [filter, setFilter] = useState<AgentFilter>(TOTAL_FILTER);

  const filteredSteps = useMemo(() => filterStepsByAgent(steps, filter), [steps, filter]);

  // Token metrics, counted once per API response: `usage` is repeated on every
  // step a response produced, so reducing over `steps` inflates every total.
  const responses = oncePerResponse(filteredSteps);

  const totalInputTokens = responses.reduce((sum, s) =>
    sum + (s.usage?.input_tokens || 0) + (s.usage?.cache_creation_input_tokens || 0), 0);
  const totalOutputTokens = responses.reduce((sum, s) =>
    sum + (s.usage?.output_tokens || 0), 0);
  const totalCacheRead = responses.reduce((sum, s) =>
    sum + (s.usage?.cache_read_input_tokens || 0), 0);
  const totalCacheCreate = responses.reduce((sum, s) =>
    sum + (s.usage?.cache_creation_input_tokens || 0), 0);

  // Per response, matching the totals above. Dividing by `steps.length` would
  // spread a per-response sum over steps that never carried usage.
  const avgInputPerResponse = responses.length > 0
    ? Math.round(totalInputTokens / responses.length)
    : 0;
  const cacheEfficiency = totalCacheRead > 0
    ? ((totalCacheRead / (totalInputTokens + totalCacheRead)) * 100).toFixed(1)
    : '0.0';

  // Find peak token step
  const peakStep = filteredSteps.reduce((max, s) => {
    const tokens = (s.usage?.input_tokens || 0) + (s.usage?.output_tokens || 0);
    const maxTokens = (max.usage?.input_tokens || 0) + (max.usage?.output_tokens || 0);
    return tokens > maxTokens ? s : max;
  }, filteredSteps[0]);

  const peakTokens = (peakStep?.usage?.input_tokens || 0) + (peakStep?.usage?.output_tokens || 0);

  // Compaction/pressure markers are indices local to whichever transcript the
  // analyzer read — the main session's own, or one agent's. There's no single
  // combined index space for "total", so no markers are drawn there.
  const contextMetrics =
    filter === MAIN_FILTER
      ? analysis?.contextMetrics
      : filter === TOTAL_FILTER
      ? undefined
      : subagents.find(s => s.agentId === filter)?.analysis?.contextMetrics;

  return (
    <div className="context-tab">
      <AgentFilterBar subagents={subagents} value={filter} onChange={setFilter} />

      <div className="context-metrics">
        <div className="metric-card">
          <div className="metric-label">Total Input</div>
          <div className="metric-value">{totalInputTokens.toLocaleString()}</div>
          <div className="metric-sub">{avgInputPerResponse.toLocaleString()} avg/response</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Total Output</div>
          <div className="metric-value">{totalOutputTokens.toLocaleString()}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Cache Read</div>
          <div className="metric-value">{totalCacheRead.toLocaleString()}</div>
          <div className="metric-sub">{cacheEfficiency}% efficiency</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Cache Write</div>
          <div className="metric-value">{totalCacheCreate.toLocaleString()}</div>
        </div>
      </div>

      <ContextTimeline
        steps={filteredSteps}
        compactionPoints={contextMetrics?.compactionPoints}
        pressureZones={contextMetrics?.contextPressureZones}
        onGoToStep={onGoToStep}
      />

      <RequestWeight
        steps={filteredSteps}
        compactionPoints={contextMetrics?.compactionPoints}
        onGoToStep={onGoToStep}
      />

      <div className="usage-bars-section">
        <h3>Token Distribution</h3>
        <div className="usage-bars">
          <div className="usage-bar-item">
            <div className="usage-bar-label">
              <span>Input Tokens</span>
              <strong>{totalInputTokens.toLocaleString()}</strong>
            </div>
            <div className="usage-bar-track">
              <div className="usage-bar-fill input" style={{ width: '100%' }} />
            </div>
          </div>
          <div className="usage-bar-item">
            <div className="usage-bar-label">
              <span>Output Tokens</span>
              <strong>{totalOutputTokens.toLocaleString()}</strong>
            </div>
            <div className="usage-bar-track">
              <div
                className="usage-bar-fill output"
                style={{ width: `${Math.min((totalOutputTokens / totalInputTokens) * 100, 100)}%` }}
              />
            </div>
          </div>
          <div className="usage-bar-item">
            <div className="usage-bar-label">
              <span>Cache Read</span>
              <strong>{totalCacheRead.toLocaleString()}</strong>
            </div>
            <div className="usage-bar-track">
              <div
                className="usage-bar-fill cache"
                style={{ width: `${Math.min((totalCacheRead / totalInputTokens) * 100, 100)}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="peak-usage-section">
        <h3>Peak Usage</h3>
        <div className="peak-info">
          <div className="peak-stat">
            <span>Highest Step:</span>
            <code>#{peakStep ? stepKey(peakStep) : ''}</code>
          </div>
          <div className="peak-stat">
            <span>Total Tokens:</span>
            <strong>{peakTokens.toLocaleString()}</strong>
          </div>
          {peakStep?.toolName && (
            <div className="peak-stat">
              <span>Tool:</span>
              <code>{peakStep.toolName}</code>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ContextTab;
