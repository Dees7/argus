/**
 * ExitPlanMode — the plan the agent put up for approval, and what the user did
 * with it.
 *
 * The input carries the plan as markdown and the path of the plan file it was
 * written to. That file is rewritten on every round of planning, so the input
 * is the only record of the plan *as the user saw it* at this step.
 *
 * The result is where the user's side lands, in one of a few shapes:
 *
 *  - approved: `toolUseResult` is an object holding the plan again; the
 *    tool_result text starts "User has approved your plan";
 *  - kept planning: "User chose to stay in plan mode and continue planning",
 *    optionally followed by the comments the user left on the plan;
 *  - rejected: "User rejected tool use" / "The user doesn't want to proceed…",
 *    optionally with what the user said instead;
 *  - aborted: the permission prompt went away before anyone answered.
 *
 * Comments come as text, one per `[Re: "<quote>"] <comment>` entry. The quote
 * is the passage the user selected in the *rendered* plan, so it carries no
 * markdown — `tags.yaml: поле scope` for a source line that reads
 * `` `tags.yaml`: поле `scope` `` — and a comment may run over several lines,
 * up to the next `[Re: "`.
 */

export type PlanOutcome = 'approved' | 'kept-planning' | 'rejected' | 'aborted' | 'pending' | 'unknown';

export interface PlanComment {
  /** The passage the user selected; empty for a comment on the plan as a whole. */
  quote: string;
  text: string;
  /** 1-based line range of the quote in the plan source; absent when not found. */
  lines?: { start: number; end: number };
}

export interface ExitPlanModeCall {
  plan: string;
  planFilePath: string;
  outcome: PlanOutcome;
  /** What the user said besides line comments — a rejection's reason, say. */
  feedback: string;
  comments: PlanComment[];
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The result as text: the tool_result body, or `toolUseResult` when it is a string. */
const resultText = (result: unknown): string => {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result.map(b => (b && typeof b === 'object' ? asString((b as any).text) : '')).join('\n');
  }
  if (result && typeof result === 'object') {
    return asString((result as any).content) || asString((result as any).text);
  }
  return '';
};

const COMMENTS_HEAD = 'Comments on the plan:';

/** Split the comments block into `[Re: "…"] …` entries. */
export const parsePlanComments = (block: string): PlanComment[] => {
  const out: PlanComment[] = [];
  // Every entry opens a line with `[Re: "`; anything before the first one is a
  // comment on the plan as a whole.
  const parts = block.split(/^(?=\[Re: ")/m);
  for (const part of parts) {
    const body = part.replace(/\s+$/, '');
    if (!body.trim()) continue;
    if (!body.startsWith('[Re: "')) {
      out.push({ quote: '', text: body.trim() });
      continue;
    }
    // The quote is selected text and may hold quotes of its own, so it ends at
    // the first `"]`, not the first `"`.
    const close = body.indexOf('"]', 6);
    if (close < 0) {
      out.push({ quote: '', text: body.trim() });
      continue;
    }
    out.push({ quote: body.slice(6, close), text: body.slice(close + 2).trim() });
  }
  return out;
};

const outcomeOf = (text: string, result: unknown): PlanOutcome => {
  if (result && typeof result === 'object' && !Array.isArray(result) && typeof (result as any).plan === 'string') {
    return 'approved';
  }
  if (!text) return result === undefined || result === null ? 'pending' : 'unknown';
  if (/User has approved your plan/i.test(text)) return 'approved';
  if (/chose to stay in plan mode/i.test(text)) return 'kept-planning';
  if (/User rejected tool use|doesn't want to proceed|tool use was rejected/i.test(text)) return 'rejected';
  if (/AbortError|permission (request|stream)/i.test(text)) return 'aborted';
  return 'unknown';
};

/**
 * What the user said outside the line comments. Rejections quote it after
 * "the user said:"; a kept-planning result may carry text between its first
 * line and the comments block.
 */
const feedbackOf = (text: string, outcome: PlanOutcome): string => {
  const said = /the user said:\s*\n([\s\S]*)$/i.exec(text);
  if (said) return said[1].split(COMMENTS_HEAD)[0].trim();
  if (outcome !== 'kept-planning') return '';
  const body = text.replace(/^Error:\s*/, '').split(COMMENTS_HEAD)[0];
  return body.replace(/^.*chose to stay in plan mode[^\n]*\n?/i, '').trim();
};

// ─── Locating a quote in the plan source ─────────────────────────────────

// Markup that never makes it into the rendered text the quote was copied from.
const INLINE_MARKUP = /[`*_~|]/g;

/** One source line as it reads once rendered, minus markup and whitespace. */
const plainLine = (line: string): string =>
  line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(>\s*)+/, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(INLINE_MARKUP, '')
    .replace(/\s+/g, '');

const plainQuote = (quote: string): string => quote.replace(INLINE_MARKUP, '').replace(/\s+/g, '');

/**
 * Where a quote sits in the plan, as a 1-based line range. Both sides are
 * compared with markup and whitespace stripped: the quote was selected in the
 * rendered plan, where neither backticks nor soft line breaks survive.
 */
export const locateQuote = (plan: string, quote: string): { start: number; end: number } | undefined => {
  const needle = plainQuote(quote);
  if (!needle) return undefined;

  let hay = '';
  const lineAt: number[] = [];
  plan.split('\n').forEach((line, i) => {
    const plain = plainLine(line);
    hay += plain;
    for (let k = 0; k < plain.length; k++) lineAt.push(i + 1);
  });

  let at = hay.indexOf(needle);
  if (at < 0) at = hay.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return undefined;
  return { start: lineAt[at], end: lineAt[at + needle.length - 1] };
};

export const parseExitPlanMode = (input: unknown, result: unknown): ExitPlanModeCall => {
  const inputObj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const resultObj = (result && typeof result === 'object' && !Array.isArray(result)
    ? result
    : {}) as Record<string, unknown>;

  // An approved call echoes the plan back; the input is the fallback for one
  // that lost it, and vice versa.
  const plan = asString(inputObj.plan) || asString(resultObj.plan);
  const planFilePath = asString(inputObj.planFilePath) || asString(resultObj.filePath);

  const text = resultText(result);
  const outcome = outcomeOf(text, result);
  const at = text.indexOf(COMMENTS_HEAD);
  const comments = at < 0
    ? []
    : parsePlanComments(text.slice(at + COMMENTS_HEAD.length).replace(/^\s*\n/, '')).map(c => ({
        ...c,
        lines: c.quote ? locateQuote(plan, c.quote) : undefined,
      }));

  return { plan, planFilePath, outcome, feedback: feedbackOf(text, outcome), comments };
};

/** First `# ` heading of the plan, the name it goes by. */
export const planTitle = (plan: string): string => {
  const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(plan);
  return m ? m[1] : '';
};

const OUTCOME_WORD: Record<PlanOutcome, string> = {
  approved: 'approved',
  'kept-planning': 'kept planning',
  rejected: 'rejected',
  aborted: 'aborted',
  pending: 'waiting',
  unknown: '',
};

/** The one-line form for a collapsed step row: title, outcome, comment count. */
export const exitPlanModeSummary = (call: ExitPlanModeCall): string => {
  const parts = [planTitle(call.plan), OUTCOME_WORD[call.outcome]];
  const n = call.comments.length;
  if (n > 0) parts.push(`${n} comment${n === 1 ? '' : 's'}`);
  return parts.filter(Boolean).join(' · ');
};
