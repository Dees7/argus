import * as fsp from 'fs/promises';

/** One session and every transcript file that belongs to it (sub-agents included). */
export interface SearchTarget {
  sessionId: string;
  files: string[];
}

// Transcripts are read whole, so each in-flight file costs roughly 3x its size
// (buffer + UTF-16 string + lower-cased copy). Keep the pool small enough that a
// handful of multi-megabyte transcripts can't spike the extension host.
const CONCURRENCY = 4;
const CACHE_LIMIT = 20;

/**
 * Full-text search over raw session transcripts.
 *
 * Matching is done on the raw JSONL rather than parsed events: it is an order of
 * magnitude cheaper and lets a query hit anything in the file — message text,
 * tool arguments, or metadata keys such as `isCompactSummary`. The trade-off is
 * that content is matched as it is *encoded*, so a phrase spanning a line break
 * (stored as a literal `\n`) will not be found.
 */
export class SearchService {
  private cache = new Map<string, Set<string>>();
  private generation = 0;

  /** Drop cached results — call whenever the session index is rebuilt. */
  invalidate(): void {
    this.cache.clear();
    // Also abandon any scan in flight; its results describe the old index.
    this.generation++;
  }

  /** Abandon the scan in flight, if any, without touching cached results. */
  cancel(): void {
    this.generation++;
  }

  /**
   * Session ids whose transcripts contain `query` (case-insensitive).
   * Resolves to `null` if a newer call superseded this one — callers should
   * discard the result rather than render it.
   */
  async search(query: string, targets: SearchTarget[]): Promise<Set<string> | null> {
    const needle = query.toLowerCase().trim();
    if (!needle) {
      return new Set(targets.map(t => t.sessionId));
    }

    const cached = this.cache.get(needle);
    if (cached) {
      return cached;
    }

    const gen = ++this.generation;

    // Typing narrows the result set monotonically: anything matching "foobar"
    // must already match "foo", so a cached prefix result bounds the work.
    const scope = this.narrowByCache(needle, targets);

    const matched = new Set<string>();
    let next = 0;

    const worker = async () => {
      for (let idx = next++; idx < scope.length; idx = next++) {
        if (gen !== this.generation) {
          return; // Superseded — stop reading files nobody will look at.
        }
        const target = scope[idx];
        if (await this.targetMatches(target, needle)) {
          matched.add(target.sessionId);
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (gen !== this.generation) {
      return null;
    }

    this.remember(needle, matched);
    return matched;
  }

  /**
   * Smallest cached candidate set that is guaranteed to contain every match for
   * `needle`, i.e. the result for the longest cached substring of it.
   */
  private narrowByCache(needle: string, targets: SearchTarget[]): SearchTarget[] {
    let best: Set<string> | undefined;
    let bestLen = 0;

    for (const [key, ids] of this.cache) {
      if (key.length > bestLen && needle.includes(key)) {
        best = ids;
        bestLen = key.length;
      }
    }

    return best ? targets.filter(t => best.has(t.sessionId)) : targets;
  }

  private async targetMatches(target: SearchTarget, needle: string): Promise<boolean> {
    for (const file of target.files) {
      let buf: Buffer;
      try {
        buf = await fsp.readFile(file);
      } catch {
        continue; // Session may have been deleted since discovery.
      }

      // Fast path: an exact-case hit needs no decoding at all.
      if (buf.includes(needle)) {
        return true;
      }
      if (buf.toString('utf8').toLowerCase().includes(needle)) {
        return true;
      }
    }
    return false;
  }

  private remember(needle: string, matched: Set<string>): void {
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(needle, matched);
  }
}
