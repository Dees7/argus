import { MouseEvent, useCallback, useRef } from 'react';

/**
 * Click-to-navigate for a recharts categorical chart.
 *
 * Not built on the chart's own `onClick`: recharts 3 hands its mouse handlers a
 * `MouseHandlerDataParam` that carries the active tick's position and nothing
 * else — no `activePayload` — and which of those handlers actually receives a
 * populated index varies. What is reliable is `onMouseMove`, since the tooltip
 * is driven by it, so the active index is latched there and a plain DOM click on
 * the wrapping element consumes it.
 *
 * The effect is that the whole plot area is a click target: the tooltip already
 * snaps to the nearest step, and clicking navigates to whichever step it is
 * showing. No aiming at a 4px dot.
 */
export function useChartStepClick(
  points: readonly { index: number }[],
  onGoToStep?: (index: number) => void
) {
  const activeRef = useRef<number | null>(null);
  const pointsRef = useRef(points);
  pointsRef.current = points;

  const latch = useCallback((state: any) => {
    activeRef.current = readActiveIndex(state);
  }, []);

  const onMouseLeave = useCallback(() => {
    activeRef.current = null;
  }, []);

  const onClick = useCallback(
    (_event: MouseEvent<HTMLDivElement>) => {
      const idx = activeRef.current;
      if (idx === null) return;
      const point = pointsRef.current[idx];
      if (point) onGoToStep?.(point.index);
    },
    [onGoToStep]
  );

  return {
    /** Spread onto the recharts chart element. */
    chartHandlers: { onMouseMove: latch, onMouseDown: latch, onMouseLeave },
    /** Spread onto the element wrapping the ResponsiveContainer. */
    wrapperHandlers: { onClick }
  };
}

/**
 * The active index out of a recharts mouse-event state.
 *
 * `selectActiveTooltipIndex` is typed `TooltipIndex = string | null`, so the
 * index arrives as `"3"` rather than `3` — a `typeof === 'number'` guard drops
 * every event. Both fields are read because recharts populates
 * `activeTooltipIndex` and its `activeIndex` alias from the same selector.
 */
function readActiveIndex(state: any): number | null {
  const raw = state?.activeTooltipIndex ?? state?.activeIndex;
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  if (typeof raw === 'string' && raw !== '') {
    const parsed = Number(raw);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}
