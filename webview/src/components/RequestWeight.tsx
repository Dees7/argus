import { useMemo, useState } from 'react';
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { Step, stepKey } from '../types/session';
import { oncePerResponse } from '../../../src/types/usage';

interface Props {
  steps: Step[];
  compactionPoints?: number[];
  onGoToStep?: (index: number) => void;
}

type SeriesKey = 'cacheRead' | 'freshInput' | 'cacheWrite' | 'output';

interface Point {
  /** `globalIndex`: what the Steps tab shows and navigates by. */
  index: number;
  /** Index within the main session: what the analyzer's findings refer to. */
  localIndex: number;
  step: string;
  cacheRead: number;
  freshInput: number;
  cacheWrite: number;
  prompt: number;
  output: number;
}

interface Series {
  key: SeriesKey;
  label: string;
  color: string;
  /** Billed rate as a multiple of the model's base input rate, see pricing.ts. */
  rate: string;
}

// Nothing here is free: cache reads bill at CACHE_READ_RATIO of the input rate,
// cache writes at 1.25x (5m TTL) or 2x (1h), and every model in the price table
// charges output at 5x its input rate.
const PROMPT_SERIES: Series[] = [
  { key: 'cacheRead', label: 'Cache read', color: '#5eead4', rate: '0.1×' },
  { key: 'freshInput', label: 'Fresh input', color: '#06b6d4', rate: '1×' },
  { key: 'cacheWrite', label: 'Cache write', color: '#fbbf24', rate: '1.25–2×' }
];

const OUTPUT_SERIES: Series = { key: 'output', label: 'Output', color: '#8b5cf6', rate: '5×' };

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

function RequestTooltip({ active, payload, hidden }: any) {
  if (!active || !payload?.length) return null;
  const p: Point = payload[0].payload;

  const visible = [...PROMPT_SERIES, OUTPUT_SERIES].filter(s => !hidden.has(s.key));
  const promptTotal = PROMPT_SERIES
    .filter(s => !hidden.has(s.key))
    .reduce((sum, s) => sum + p[s.key], 0);

  return (
    <div className="request-weight-tooltip">
      <div className="request-weight-tooltip-title">Step #{p.index}</div>
      <div className="request-weight-tooltip-total">{promptTotal.toLocaleString()} tokens in prompt</div>
      {visible.map(s => (
        <div className="request-weight-tooltip-row" key={s.key}>
          <span className="token-dot" style={{ background: s.color }} />
          <span>{s.label}</span>
          <strong>{p[s.key].toLocaleString()}</strong>
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
  // Hidden series are not rendered at all rather than passed `hide`, so recharts
  // drops them from the axis domain and the remaining ones rescale to fill the
  // chart — the point of toggling cache off is to finally see the rest.
  const [hidden, setHidden] = useState<Set<SeriesKey>>(new Set());

  const toggle = (key: SeriesKey) => {
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const data = useMemo<Point[]>(() => {
    const entries: Point[] = [];

    // One point per API response, same rule the cumulative timeline uses: the
    // transcript repeats `usage` on every content block of a response.
    for (const step of oncePerResponse(steps)) {
      if (!step.usage) continue;
      const cacheRead = step.usage.cache_read_input_tokens ?? 0;
      const freshInput = step.usage.input_tokens ?? 0;
      const cacheWrite = step.usage.cache_creation_input_tokens ?? 0;
      const key = stepKey(step);
      entries.push({
        index: key,
        localIndex: step.index,
        step: `#${key}`,
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
  const visiblePrompt = PROMPT_SERIES.filter(s => !hidden.has(s.key));
  const outputVisible = !hidden.has('output');

  // recharts 3 dropped `activePayload` from the chart mouse-event object — it
  // hands over the active tick's position only (`MouseHandlerDataParam`), so
  // the datum is looked up by index instead. Chart-level rather than per-dot:
  // the whole plot area is then clickable, dots included.
  const handleClick = (state: any) => {
    const idx = state?.activeTooltipIndex ?? state?.activeIndex;
    if (typeof idx !== 'number') return;
    const point = data[idx];
    if (point) onGoToStep?.(point.index);
  };

  const legendItem = (s: Series, suffix?: string) => (
    <button
      key={s.key}
      type="button"
      className={`token-legend-item token-legend-toggle${hidden.has(s.key) ? ' is-hidden' : ''}`}
      onClick={() => toggle(s.key)}
      aria-pressed={!hidden.has(s.key)}
      title={`${hidden.has(s.key) ? 'Show' : 'Hide'} ${s.label} — billed at ${s.rate} the base input rate`}
    >
      <span className="token-dot" style={{ background: s.color }} />
      {s.label}{suffix}
      <span className="token-legend-rate">{s.rate}</span>
    </button>
  );

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
            {/* Both axes stay mounted even when empty: recharts needs the id a
                series references to exist, and `hide` keeps the layout stable. */}
            <YAxis
              yAxisId="prompt"
              hide={visiblePrompt.length === 0}
              tickFormatter={formatTokens}
              stroke="rgba(255,255,255,0.4)"
              style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace" }}
            />
            {/* Output is one to two orders of magnitude smaller than the prompt
                and would sit flat on the shared axis, so it gets its own. */}
            <YAxis
              yAxisId="output"
              orientation="right"
              hide={!outputVisible}
              tickFormatter={formatTokens}
              stroke={OUTPUT_SERIES.color}
              style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace" }}
            />
            <Tooltip content={<RequestTooltip hidden={hidden} />} />

            {/* Matched on the local index: the analyzer numbers findings within
                the main session, not by `globalIndex`. */}
            {data.map((d) =>
              compactionSet.has(d.localIndex) ? (
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

            {visiblePrompt.map(s => (
              <Area
                key={s.key}
                yAxisId="prompt"
                type="monotone"
                dataKey={s.key}
                stackId="prompt"
                stroke={s.color}
                fill={s.color}
                fillOpacity={0.4}
                strokeWidth={1.5}
                name={s.label}
              />
            ))}

            {outputVisible && (
              <Line
                yAxisId="output"
                type="monotone"
                dataKey="output"
                stroke={OUTPUT_SERIES.color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 5 }}
                name={OUTPUT_SERIES.label}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="token-legend">
        {PROMPT_SERIES.map(s => legendItem(s))}
        {legendItem(OUTPUT_SERIES, ' (right axis)')}
        {(compactionPoints?.length ?? 0) > 0 && (
          <span className="token-legend-item"><span className="token-dot" style={{ background: '#f87171' }} />Compactions</span>
        )}
      </div>
      <div className="token-legend-note">
        Click a series to hide it and rescale the axis. ×N is the billed rate relative to the model's base input rate.
      </div>
    </div>
  );
}
