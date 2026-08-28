/**
 * How long a step took, measured as the gap to whatever happened next.
 *
 * Two tabs ask this question and they mean different things by it, so the
 * difference lives in the options rather than in two copies of the arithmetic:
 *
 *  - the Steps tab asks "how much time passed until the next thing happened" —
 *    a description of the timeline, where a pause while the user reads is a
 *    real part of the story and belongs in the number;
 *  - the Performance tab asks "how long did this operation take" — a metric,
 *    where that same pause is noise that buries every real operation under
 *    "the user went to lunch".
 *
 * `boundaries` is what makes a harness event count without becoming a row of
 * its own: a retry storm or a blocked hook ends the pause it sits in, so the
 * tool call before it stops being credited with the wait, but nothing about it
 * shows up in a "slowest operations" list where it would only be noise.
 */

import type { Step } from '../types/session';

export interface DurationOptions {
  /**
   * Drop negative gaps instead of recording them. Transcripts do contain
   * out-of-order timestamps — harness events are occasionally written with a
   * time earlier than the line before them — and a negative duration silently
   * eats into any sum built from these numbers.
   */
  clampNegative?: boolean;
  /**
   * Skip the gap that ends in the user typing. That time was the human's, not
   * the model's, and left in it dominates every ranking: sessions routinely
   * show a 14-hour "step" that is someone sleeping.
   */
  dropBeforeUserPrompt?: boolean;
  /**
   * End a gap at whatever happened next *in time*, rather than at the next
   * step in transcript order.
   *
   * The two differ because the transcript's order is not always its chronology:
   * a retry storm is written as a block sitting after the reply that eventually
   * came while carrying times from minutes before it, and a message typed into
   * the queue mid-turn is written before the tool call that was still running.
   * Ordering by position hides those events behind the very step whose pause
   * they explain — which is what a ranking of slow operations must not do, and
   * what a timeline reading "time until the next row" may legitimately do.
   */
  chronologicalBoundaries?: boolean;
}

/** Position in the flattened timeline; steps without one cannot be ordered. */
interface Positioned {
  at: number;
  order: number;
  step: Step;
}

/**
 * Steps with their times resolved once. Both callers hand us flattened steps,
 * where `globalIndex` is unique and orders the transcript; anything without one
 * is left out rather than guessed at, since a made-up position would reorder
 * the timeline and produce durations that belong to no step.
 */
function positioned(steps: Step[]): Positioned[] {
  const out: Positioned[] = [];
  for (const step of steps) {
    if (!step.timestamp || step.globalIndex === undefined) {
      continue;
    }
    const at = new Date(step.timestamp).getTime();
    if (Number.isNaN(at)) {
      continue;
    }
    out.push({ at, order: step.globalIndex, step });
  }
  return out;
}

/** Index of the first entry ranking after `key`, or -1. `list` is sorted by `rank`. */
function firstAfter(list: Positioned[], key: number, rank: (entry: Positioned) => number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rank(list[mid]) > key) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo < list.length ? lo : -1;
}

/**
 * Duration of each step in `subjects`, keyed by `globalIndex`.
 *
 * `boundaries` is everything that can end a gap — including steps the caller
 * does not want measured, such as hidden harness events. A step whose gap has
 * no end, or that an option excludes, is absent from the map rather than
 * present as zero, so callers can tell "took no time" from "not measured".
 */
export function computeStepDurations(
  subjects: Step[],
  boundaries: Step[],
  options: DurationOptions = {}
): Map<number, number> {
  const {
    clampNegative = false,
    dropBeforeUserPrompt = false,
    chronologicalBoundaries = false,
  } = options;
  // Subjects always keep transcript order — "the next step" is a fact about the
  // timeline. Boundaries are ranked by whichever notion of "next" the caller
  // asked for.
  const rank = chronologicalBoundaries
    ? (entry: Positioned) => entry.at
    : (entry: Positioned) => entry.order;
  const subs = positioned(subjects).sort((a, b) => a.order - b.order);
  const bounds = positioned(boundaries).sort((a, b) => rank(a) - rank(b));
  const durations = new Map<number, number>();

  for (let i = 0; i < subs.length; i++) {
    const from = subs[i];
    const nextSubject = subs[i + 1];
    // The last step has nothing to be measured against: whatever came after it
    // was not recorded, so its duration is unknown rather than zero.
    if (!nextSubject) {
      continue;
    }
    if (dropBeforeUserPrompt && nextSubject.step.type === 'user') {
      continue;
    }

    const found = firstAfter(bounds, chronologicalBoundaries ? from.at : from.order, rank);
    const boundary = found === -1 ? undefined : bounds[found];
    // Whichever comes first in time. A boundary later than the next subject
    // tells us nothing new, and the next subject alone would miss everything
    // the harness recorded out of order in between.
    const end = boundary && boundary.at < nextSubject.at ? boundary.at : nextSubject.at;
    const diff = end - from.at;
    if (clampNegative && diff < 0) {
      continue;
    }
    durations.set(from.order, diff);
  }

  return durations;
}
