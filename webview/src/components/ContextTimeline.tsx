import { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { Step, stepKey } from '../types/session';
import { oncePerResponse } from '../../../src/types/usage';

interface Props {
  steps: Step[];
  compactionPoints?: number[];
  pressureZones?: number[];
  onGoToStep?: (index: number) => void;
}

type SeriesKey = 'cumInput' | 'cumOutput' | 'cumCache';

interface Point {
  /** `globalIndex`: what the Steps tab shows and navigates by. */
  index: number;
  /** Index within the main session: what the analyzer's findings refer to. */
  localIndex: number;
  step: string;
  cumInput: number;
  cumOutput: number;
  cumCache: number;
  isPressure?: boolean;
}

const SERIES: { key: SeriesKey; label: string; color: string }[] = [
  { key: 'cumInput', label: 'Input', color: '#06b6d4' },
  { key: 'cumOutput', label: 'Output', color: '#8b5cf6' },
  { key: 'cumCache', label: 'Cache', color: '#5eead4' }
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

export default function ContextTimeline({ steps, compactionPoints, pressureZones, onGoToStep }: Props) {
  // Hidden series are left unrendered rather than given `hide`, so recharts
  // drops them from the axis domain and whatever is left rescales to fill the
  // chart — cache dwarfs the other two and flattens them otherwise.
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
    let cumInput = 0, cumOutput = 0, cumCache = 0;
    const pressureSet = new Set(pressureZones ?? []);

    // One point per API response: plotting every step would step the curve up
    // once per content block and end the session at an inflated total.
    for (const step of oncePerResponse(steps)) {
      if (!step.usage) continue;
      cumInput += (step.usage.input_tokens ?? 0) + (step.usage.cache_creation_input_tokens ?? 0);
      cumOutput += step.usage.output_tokens ?? 0;
      cumCache += step.usage.cache_read_input_tokens ?? 0;
      // Numbered the way the Steps tab numbers rows, which is what
      // `onGoToStep` highlights by.
      const key = stepKey(step);
      entries.push({
        index: key,
        localIndex: step.index,
        step: `#${key}`,
        cumInput,
        cumOutput,
        cumCache,
        isPressure: pressureSet.has(step.index)
      });
    }
    return entries;
  }, [steps, pressureZones]);

  if (data.length < 2) {
    return <div className="context-timeline-empty">Not enough data to display timeline</div>;
  }

  const compactionSet = new Set(compactionPoints ?? []);
  const visible = SERIES.filter(s => !hidden.has(s.key));

  // recharts 3 dropped `activePayload` from the chart mouse-event object — it
  // hands over the active tick's position only, so the datum is looked up by
  // index. Chart-level rather than per-dot: the whole plot area is clickable.
  const handleClick = (state: any) => {
    const idx = state?.activeTooltipIndex ?? state?.activeIndex;
    if (typeof idx !== 'number') return;
    const point = data[idx];
    if (point) onGoToStep?.(point.index);
  };

  return (
    <div className="context-timeline-container">
      <h3 className="section-title">Token Timeline</h3>
      <div className="section-subtitle">Running total for the session — every line only ever climbs</div>
      <div className="context-timeline-chart">
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data} margin={{ top: 20, right: 10, left: 10, bottom: 20 }} onClick={handleClick}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="step"
              stroke="rgba(255,255,255,0.4)"
              style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace" }}
            />
            <YAxis
              hide={visible.length === 0}
              tickFormatter={formatTokens}
              stroke="rgba(255,255,255,0.4)"
              style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace" }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                fontSize: '12px'
              }}
              labelStyle={{ color: 'var(--text-bright)', fontWeight: 600 }}
              formatter={(value) => [formatTokens(typeof value === 'number' ? value : 0), '']}
            />

            {/* Compaction lines */}
            {/* Matched on the local index: the analyzer numbers findings within
                the main session, not by `globalIndex`. */}
            {data.map((d) =>
              compactionSet.has(d.localIndex) ? (
                <ReferenceLine
                  key={`comp-${d.index}`}
                  x={d.step}
                  stroke="#f87171"
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  opacity={0.7}
                />
              ) : null
            )}

            {visible.map(s => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={2.5}
                dot={{ fill: s.color, r: 4 }}
                activeDot={{ r: 6 }}
                name={s.label}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="token-legend">
        {SERIES.map(s => (
          <button
            key={s.key}
            type="button"
            className={`token-legend-item token-legend-toggle${hidden.has(s.key) ? ' is-hidden' : ''}`}
            onClick={() => toggle(s.key)}
            aria-pressed={!hidden.has(s.key)}
            title={`${hidden.has(s.key) ? 'Show' : 'Hide'} ${s.label}`}
          >
            <span className="token-dot" style={{ background: s.color }} />
            {s.label}
          </button>
        ))}
        {(compactionPoints?.length ?? 0) > 0 && (
          <span className="token-legend-item"><span className="token-dot" style={{ background: '#f87171' }} />Compactions</span>
        )}
      </div>
      <div className="token-legend-note">Click a series to hide it and rescale the axis. Click the chart to jump to that step.</div>
    </div>
  );
}
