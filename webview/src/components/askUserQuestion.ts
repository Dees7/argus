/**
 * AskUserQuestion — the shape the transcript records, and how to read the
 * user's pick back out of it.
 *
 * The tool input holds the questions as they were put to the user, option
 * previews included. The result echoes the same questions back *without* the
 * previews and adds `answers`: one string per question, keyed by the question
 * text verbatim. Two things make that string worth parsing rather than
 * printing:
 *
 *  - a multi-select answer is its chosen labels joined with ", ";
 *  - anything the user typed themselves ("Other") is appended to that same
 *    string, with no marker separating it from the labels.
 *
 * So the only way to tell a pick from free text is to match the option labels
 * back off the front of the answer — which is what `splitAnswer` does.
 */

export interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: AskOption[];
}

export interface AskAnswer {
  /** Option labels the user ticked, in the order the answer listed them. */
  picked: string[];
  /** What the user typed instead of — or on top of — the offered options. */
  custom: string;
  /** False when this question never got an answer (a rejected or aborted ask). */
  answered: boolean;
  /** Free-text note the user attached to their choice, via `annotations`. */
  note: string;
}

export interface AskUserQuestionCall {
  questions: AskQuestion[];
  /** Parallel to `questions` — index i answers question i. */
  answers: AskAnswer[];
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const normalizeOptions = (raw: unknown): AskOption[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
    .map(o => ({
      label: asString(o.label),
      description: asString(o.description),
      preview: asString(o.preview),
    }));
};

/**
 * Pull the labels the user ticked off the front of their answer, longest label
 * first so a label that itself contains ", " still resolves. Whatever is left
 * over never matched an option, which makes it the user's own text.
 */
export const splitAnswer = (
  answer: string,
  options: AskOption[],
  multiSelect: boolean
): { picked: string[]; custom: string } => {
  const labels = options.map(o => o.label).filter(l => l.length > 0);

  // Single-select is all-or-nothing: the answer is a label, or it is the text
  // the user typed under "Other".
  if (!multiSelect) {
    return labels.includes(answer)
      ? { picked: [answer], custom: '' }
      : { picked: [], custom: answer };
  }

  const remaining = new Set(labels);
  const picked: string[] = [];
  let rest = answer;
  for (;;) {
    const hit = [...remaining]
      .sort((a, b) => b.length - a.length)
      .find(l => rest === l || rest.startsWith(`${l}, `));
    if (!hit) break;
    picked.push(hit);
    remaining.delete(hit);
    rest = rest === hit ? '' : rest.slice(hit.length + 2);
  }
  return { picked, custom: rest };
};

/**
 * Answers recovered from the human-readable summary the tool hands back to the
 * model ("Your questions have been answered: "Q"="A", …"). Only a fallback:
 * transcripts that carry the structured `answers` map are read from that
 * instead. The questions are known up front, so each answer is bounded by the
 * next question's quoted text rather than by guessing where the quoting ends —
 * an answer may itself contain quotes and commas.
 */
const answersFromSummary = (text: string, questions: AskQuestion[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    const head = `"${questions[i].question}"="`;
    const at = text.indexOf(head);
    if (at < 0) continue;
    const from = at + head.length;
    const next = questions[i + 1]?.question;
    let end = next ? text.indexOf(`", "${next}"="`, from) : -1;
    if (end < 0) {
      const tail = text.lastIndexOf('". ');
      end = tail > from ? tail : text.length;
    }
    out[questions[i].question] = text.slice(from, end);
  }
  return out;
};

/**
 * Merge a call's input and result into one view. Either side may be missing:
 * the result is absent while the ask is still on screen, and a transcript that
 * lost the input still describes the questions in its result.
 */
export const parseAskUserQuestion = (input: unknown, result: unknown): AskUserQuestionCall => {
  const inputObj = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const resultObj = (result && typeof result === 'object' && !Array.isArray(result)
    ? result
    : {}) as Record<string, any>;

  const fromInput = Array.isArray(inputObj.questions) ? inputObj.questions : [];
  const fromResult = Array.isArray(resultObj.questions) ? resultObj.questions : [];
  // Prefer the input: it is the only side carrying option previews.
  const source: any[] = fromInput.length > 0 ? fromInput : fromResult;

  // `multiSelect` is optional in the input and always present in the result's
  // echo, so fall back to the echo, matched on the question text.
  const echoed = new Map<string, any>();
  for (const q of fromResult) {
    if (q && typeof q.question === 'string') echoed.set(q.question, q);
  }

  const questions: AskQuestion[] = source
    .filter(q => !!q && typeof q === 'object')
    .map(q => ({
      question: asString(q.question),
      header: asString(q.header),
      multiSelect: !!(q.multiSelect ?? echoed.get(asString(q.question))?.multiSelect),
      options: normalizeOptions(q.options?.length ? q.options : echoed.get(asString(q.question))?.options),
    }));

  const rawAnswers: Record<string, string> =
    resultObj.answers && typeof resultObj.answers === 'object'
      ? resultObj.answers
      : typeof result === 'string'
        ? answersFromSummary(result, questions)
        : {};
  const annotations: Record<string, any> =
    resultObj.annotations && typeof resultObj.annotations === 'object' ? resultObj.annotations : {};

  const answers: AskAnswer[] = questions.map(q => {
    const raw = rawAnswers[q.question];
    if (typeof raw !== 'string') {
      return { picked: [], custom: '', answered: false, note: '' };
    }
    const { picked, custom } = splitAnswer(raw, q.options, q.multiSelect);
    return {
      picked,
      custom,
      answered: true,
      note: asString(annotations[q.question]?.notes),
    };
  });

  return { questions, answers };
};

/**
 * The one-line form for a collapsed step row: what the user actually chose,
 * labelled by each question's short header. Unanswered questions fall back to
 * the question itself, so a rejected ask still says what was asked.
 */
export const askUserQuestionSummary = (call: AskUserQuestionCall): string => {
  const flatten = (s: string) => s.replace(/\s+/g, ' ').trim();
  const parts = call.questions.map((q, i) => {
    const a = call.answers[i];
    const chosen = [...a.picked, ...(a.custom ? [a.custom] : [])].join(', ');
    if (!chosen) return flatten(q.question);
    const value = flatten(chosen);
    const capped = value.length > 120 ? `${value.slice(0, 120)}…` : value;
    return q.header ? `${flatten(q.header)}: ${capped}` : capped;
  });
  return parts.filter(Boolean).join(' · ');
};
