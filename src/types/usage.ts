// How to count tokens without counting them twice. Dependency-free so the
// extension host and the webview can share one implementation, same as
// pricing.ts.
//
// The transcript writes one JSONL event per content block of an API response,
// and every one of them repeats that response's `usage`. A step is built per
// block, so a response with a thinking block and two tool calls yields three
// steps all carrying the same counts. Summing `usage` across steps therefore
// multiplies the totals by the block count — measured at 2.0x for input and
// 1.7x for output on a real corpus.

/**
 * Minimal shape the de-duplication needs. Both the host's `Step` and the
 * webview's satisfy it structurally, so neither has to be imported here.
 */
interface ResponseStep {
  index: number;
  messageId?: string;
  usage?: unknown;
}

/**
 * The steps that carry usage, one per API response: for each `messageId` the
 * first step that has it, in order. Iterate this instead of `steps` whenever
 * `usage` is being summed or averaged.
 *
 * Costs do not need it — the parser already charges a response once and gives
 * its siblings `cost: 0` — but every raw token count does.
 *
 * A step without a `messageId` is kept as-is rather than grouped: ids are
 * absent only where there is nothing to group by, and collapsing them all into
 * one bucket would drop real usage.
 */
export function oncePerResponse<T extends ResponseStep>(steps: T[]): T[] {
  const seen = new Set<string>();
  const responses: T[] = [];

  for (const step of steps) {
    if (!step.usage) {
      continue;
    }
    if (!step.messageId) {
      responses.push(step);
      continue;
    }
    if (seen.has(step.messageId)) {
      continue;
    }
    seen.add(step.messageId);
    responses.push(step);
  }

  return responses;
}
