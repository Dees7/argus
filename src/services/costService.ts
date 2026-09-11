import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as readline from 'readline';
import { calculateCost } from '../types/pricing';

/** One session and every transcript file that belongs to it (sub-agents included). */
export interface CostTarget {
  sessionId: string;
  files: string[];
}

/**
 * How long a computed price stays good for. Pricing a session means reading its
 * whole transcript, so the figures are kept rather than recomputed on every
 * render — but they are a snapshot, and the Sessions view drops the whole
 * column once they are this old rather than showing numbers nobody checked.
 */
export const COST_TTL_MS = 3 * 60 * 60 * 1000;

// Transcripts are streamed line by line, so a file in flight costs a line
// rather than its size — but the JSON parsing is CPU-bound, and the extension
// host is shared with everything else in the window.
const CONCURRENCY = 4;

interface CacheEntry {
  cost: number;
  /** Sizes and mtimes of the session's files — a cheap "did anything change". */
  stamp: string;
  computedAt: number;
}

/**
 * Price of a session, computed from its transcripts.
 *
 * Only the assistant messages matter, so lines without a `usage` field are
 * never parsed: that is the difference between reading a transcript and parsing
 * one, and here we read every session the user has.
 *
 * The arithmetic deliberately mirrors `ParserService.buildSession`: a response
 * is written to the transcript once per content block, each repeating the same
 * usage, so a message is charged once — on its final counts, at the model its
 * first event named.
 */
export class CostService {
  private cache = new Map<string, CacheEntry>();

  /** Cached price for a session, if one was computed and is still fresh. */
  getCached(sessionId: string): number | undefined {
    const entry = this.cache.get(sessionId);
    if (!entry || Date.now() - entry.computedAt > COST_TTL_MS) {
      return undefined;
    }
    return entry.cost;
  }

  /** Forget everything — the user turned the column off, or the TTL ran out. */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Price every target, reusing cached figures for sessions whose files have
   * not changed since. `report` is called once per finished session with the
   * running total, and `isCancelled` is polled between sessions so a long scan
   * can be abandoned from the progress dialog.
   */
  async computeAll(
    targets: CostTarget[],
    report?: (done: number, total: number, runningTotal: number) => void,
    isCancelled?: () => boolean
  ): Promise<Map<string, number>> {
    const costs = new Map<string, number>();
    let next = 0;
    let done = 0;
    let runningTotal = 0;

    const worker = async () => {
      for (let idx = next++; idx < targets.length; idx = next++) {
        if (isCancelled?.()) {
          return;
        }
        const target = targets[idx];
        const cost = await this.costFor(target);
        costs.set(target.sessionId, cost);
        done++;
        runningTotal += cost;
        report?.(done, targets.length, runningTotal);
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    return costs;
  }

  /** Price one session, from cache when its transcripts are unchanged. */
  async costFor(target: CostTarget): Promise<number> {
    const stamp = await this.stampOf(target.files);
    const cached = this.cache.get(target.sessionId);
    if (cached && cached.stamp === stamp && Date.now() - cached.computedAt <= COST_TTL_MS) {
      return cached.cost;
    }

    let cost = 0;
    for (const file of target.files) {
      cost += await this.fileCost(file);
    }

    this.cache.set(target.sessionId, { cost, stamp, computedAt: Date.now() });
    return cost;
  }

  /**
   * Size and mtime of every file of the session. A transcript is only ever
   * appended to, so this changing is the same thing as the price changing.
   */
  private async stampOf(files: string[]): Promise<string> {
    const parts: string[] = [];
    for (const file of files) {
      try {
        const stat = await fsp.stat(file);
        parts.push(`${stat.size}:${stat.mtimeMs}`);
      } catch {
        parts.push('-'); // Deleted since discovery; priced as nothing.
      }
    }
    return parts.join('|');
  }

  private async fileCost(file: string): Promise<number> {
    // Charged messages, keyed by id. A message with no id (older transcripts)
    // cannot be de-duplicated and is charged per event, exactly as the parser
    // does it.
    const byId = new Map<string, { usage: any; model: string }>();
    const anonymous: Array<{ usage: any; model: string }> = [];
    // Falls in for messages that name no model of their own, mirroring the
    // parser's session-level default.
    let sessionModel = '';

    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(file);
    } catch {
      return 0;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        // Everything billed carries usage; skipping the rest avoids parsing the
        // tool results and file contents that make up most of a transcript.
        if (!line.includes('"usage"')) {
          continue;
        }

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (event.type !== 'assistant' || !event.message) {
          continue;
        }

        const named = event.message.model;
        const model = named && named !== '<synthetic>' ? named : '';
        if (!sessionModel && model) {
          sessionModel = model;
        }

        const usage = event.message.usage;
        if (!usage) {
          continue;
        }

        const id = event.message.id ?? '';
        if (id === '') {
          anonymous.push({ usage, model });
          continue;
        }

        // Last usage wins — the final event of a message carries its complete
        // counts — while the model stays the one the message opened with.
        const prev = byId.get(id);
        byId.set(id, { usage, model: prev?.model || model });
      }
    } catch {
      // Unreadable or deleted mid-scan: price what we managed to read.
    } finally {
      rl.close();
      stream.destroy();
    }

    let total = 0;
    for (const charge of [...byId.values(), ...anonymous]) {
      total += calculateCost(charge.usage, charge.model || sessionModel);
    }
    return total;
  }
}
