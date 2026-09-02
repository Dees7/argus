import { useMemo } from 'react';
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { Step } from '../types/session';
import { oncePerResponse } from '../../../src/types/usage';

interface Props {
  steps: Step[];
  compactionPoints?: number[];
  onGoToStep?: (index: number) => void;
}

interface Point {
  index: number;
  step: string;
  cacheRead: number;
  freshInput: number;
  cacheWrite: number;
  prompt: number;
  output: number;
}

const COLOR_CACHE_READ = '#5eead4';
const COLOR_INPUT = '#06b6d4';
const COLOR_CACHE_WRITE = '#fbbf24';
const COLOR_OUTPUT = '#8b5cf6';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

function RequestTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p: Point = payload[0].payload;

  const rows: [string, number, string][] = [
    ['Cache read', p.cacheRead, COLOR_CACHE_READ],
    ['Fresh input', p.freshInput, COLOR_INPUT],
    ['Cache write', p.cacheWrite, COLOR_CACHE_WRITE],
    ['Output', p.output, COLOR_OUTPUT]
  ];

  return (
    <div className="request-weight-tooltip">
      <div className="request-weight-tooltip-title">Step #{p.index}</div>
      <div className="request-weight-tooltip-total">{p.prompt.toLocaleString()} tokens in prompt</div>
      {rows.map(([label, value, color]) => (
        <div className="request-weight-tooltip-row" key={label}>
          <span className="token-dot" style={{ background: color }} />
          <span>{label}</span>
          <strong>{value.toLocaleString()}</strong>
        </div>
      ))}
    </div>
  );
}

/**
 * What one API call costs at this point in the session, as opposed to what the
 * session has cost so far. The prompt is stacked from its three billed parts —
 * their sum is the context actually sent — so the curve climbs as history
 * accumulates and drops on a compaction, which the cumulative timeline cannot
 * show.
 */
export default function RequestWeight({ steps, compactionPoints, onGoToStep }: Props) {
  const data = useMemo<Point[]>(() => {
    const entries: Point[] = [];

    // One point per API response, same rule the cumulative timeline uses: the
    // transcript repeats `usage` on every content block of a response.
    for (const step of oncePerResponse(steps)) {
      if (!step.usage) continue;
      const cacheRead = step.usage.cache_read_input_tokens ?? 0;
      const freshInput = step.usage.input_tokens ?? 0;
      const cacheWrite = step.usage.cache_creation_input_tokens ?? 0;
      entries.push({
        index: step.index,
        step: `#${step.index}`,
        cacheRead,
        freshInput,
        cacheWrite,
        prompt: cacheRead + freshInput + cacheWrite,
        output: step.usage.output_tokens ?? 0
      });
    }
    return entries;
  }, [steps]);

  if (data.length < 2) {
    return null;
  }

  const compactionSet = new Set(compactionPoints ?? []);

  const handleClick = (state: any) => {
    const point: Point | undefined = state?.activePayload?.[0]?.payload;
    if (point) onGoToStep?.(point.index);
  };

  return (
    <div className="context-timeline-container">
      <h3 className="section-title">Request Weight</h3>
      <div className="section-subtitle">Context sent per API call — how much heavier each next request gets</div>
      <div className="context-timeline-chart">
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={data} margin={{ top: 20, right: 10, left: 10, bottom: 20 }} onClick={handleClick}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="step"
              stroke="rgba(255,255,255,0.4)"
              style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace" }}
            />
            <YAxis
              yAxisId="prompt"
              tickFormatter={formatTokens}
              stroke="rgba(255,255,255,0.4)"
              style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace" }}
            />
            {/* Output is one to two orders of magnitude smaller than the prompt
                and would sit flat on the shared axis, so it gets its own. */}
            <YAxis
              yAxisId="output"
              orientation="right"
              tickFormatter={formatTokens}
              stroke={COLOR_OUTPUT}
              style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace" }}
            />
            <Tooltip content={<RequestTooltip />} />

            {data.map((d) =>
              compactionSet.has(d.index) ? (
                <ReferenceLine
                  key={`comp-${d.index}`}
                  yAxisId="prompt"
                  x={d.step}
                  stroke="#f87171"
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  opacity={0.7}
                />
              ) : null
            )}

            <Area
              yAxisId="prompt"
              type="monotone"
              dataKey="cacheRead"
              stackId="prompt"
              stroke={COLOR_CACHE_READ}
              fill={COLOR_CACHE_READ}
              fillOpacity={0.35}
              strokeWidth={1.5}
              name="Cache read"
            />
            <Area
              yAxisId="prompt"
              type="monotone"
              dataKey="freshInput"
              stackId="prompt"
              stroke={COLOR_INPUT}
              fill={COLOR_INPUT}
              fillOpacity={0.45}
              strokeWidth={1.5}
              name="Fresh input"
            />
            <Area
              yAxisId="prompt"
              type="monotone"
              dataKey="cacheWrite"
              stackId="prompt"
              stroke={COLOR_CACHE_WRITE}
              fill={COLOR_CACHE_WRITE}
              fillOpacity={0.45}
              strokeWidth={1.5}
              name="Cache write"
            />
            <Line
              yAxisId="output"
              type="monotone"
              dataKey="output"
              stroke={COLOR_OUTPUT}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 5 }}
              name="Output"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="token-legend">
        <span className="token-legend-item"><span className="token-dot" style={{ background: COLOR_CACHE_READ }} />Cache read</span>
        <span className="token-legend-item"><span className="token-dot" style={{ background: COLOR_INPUT }} />Fresh input</span>
        <span className="token-legend-item"><span className="token-dot" style={{ background: COLOR_CACHE_WRITE }} />Cache write</span>
        <span className="token-legend-item"><span className="token-dot" style={{ background: COLOR_OUTPUT }} />Output (right axis)</span>
        {(compactionPoints?.length ?? 0) > 0 && (
          <span className="token-legend-item"><span className="token-dot" style={{ background: '#f87171' }} />Compactions</span>
        )}
      </div>
    </div>
  );
}
