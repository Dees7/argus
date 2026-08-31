import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { ApiError, RawEvent } from '../types/parser';
import {
  Attachment,
  HistoryEntry,
  SessionDetail,
  Step,
  StepPermission,
  SubagentInfo,
  calculateCost,
  getModelPricing,
  isSystemStep,
} from '../types/models';
import { getClaudeConfigDir } from '../utils/claudePaths';

/**
 * Wrappers the harness injects into a user turn — IDE state, hook output,
 * reminders, agent notifications. A text block that is nothing but one of
 * these was not typed by anyone, so it never becomes a user step. Blocks the
 * person did produce, slash commands included, are kept.
 */
const INJECTED_BLOCK_TAGS = [
  'ide_opened_file',
  'ide_selection',
  'system-reminder',
  'local-command-caveat',
  'local-command-stdout',
  'task-notification',
];

const INJECTED_BLOCK_RE = new RegExp(
  `<(${INJECTED_BLOCK_TAGS.join('|')})>[\\s\\S]*?</\\1>`,
  'g'
);

// A slash command is stored as its own little XML document. Rendered raw it
// buries the one interesting part, so it collapses back to what was typed.
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_STDOUT_RE = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;

/**
 * How far into a transcript the metadata scan keeps looking for the pieces it
 * has not found yet. The first human prompt lands by line 8 and the first
 * `ai-title` by line 12 in every transcript we have seen, so the limit only
 * ever kicks in for sessions that carry none — VSCode/SDK entrypoints never
 * write `ai-title` — and stops those from being read end to end.
 */
const HEAD_SCAN_LINES = 200;

/**
 * Size of the window read from the end of a transcript to recover the final
 * `ai-title`. Claude Code rewrites the line after almost every step, so the
 * last one sits 4.5 KB from EOF at the median and under 256 KB in >99% of
 * sessions; anything past that falls back to the title seen in the head.
 */
const TAIL_SCAN_BYTES = 256 * 1024;

/**
 * File extension for an attachment's media type. The subtype is the name in
 * every case that matters (`image/png`, `application/pdf`), with the handful
 * of types whose subtype is not a usable extension spelled out.
 */
const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'text/plain': 'txt',
  'application/octet-stream': 'bin',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

function extensionFor(mediaType: string): string {
  const known = MEDIA_TYPE_EXTENSIONS[mediaType];
  if (known) {
    return known;
  }
  const subtype = mediaType.split('/')[1] ?? '';
  const cleaned = subtype.replace(/^x-/, '').replace(/[^a-z0-9]/gi, '');
  return cleaned || 'bin';
}

/** `JSON.parse` for text that is only maybe JSON: undefined instead of a throw. */
function tryParseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Decoded byte count of a base64 payload, without decoding it. */
function base64Size(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * The two node shapes a base64 payload is stored in, as `[data, media type]`:
 *
 *  - `{type: "base64", media_type, data}` — the API's own `source` object,
 *    used by `image`/`document` blocks wherever they appear;
 *  - `{base64, type: "image/png", …}` — what Claude Code writes under
 *    `toolUseResult` for a tool that returned an image.
 *
 * Anything else returns null and the walk keeps descending.
 */
function readBlobNode(node: any): [string, string | undefined] | null {
  if (node.type === 'base64' && typeof node.data === 'string') {
    return [node.data, typeof node.media_type === 'string' ? node.media_type : undefined];
  }
  if (typeof node.base64 === 'string') {
    return [node.base64, typeof node.type === 'string' ? node.type : undefined];
  }
  return null;
}

/**
 * Depth-first hunt for base64 payloads anywhere in an event, reporting the
 * dotted JSON path to each. Matching by payload shape instead of by the
 * message types we recognise is the point: an unparsed message still gives up
 * its images.
 */
function walkBlobs(
  value: any,
  path: string,
  emit: (path: string, data: string, mediaType?: string) => void
): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkBlobs(item, path ? `${path}.${i}` : String(i), emit));
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }

  const blob = readBlobNode(value);
  if (blob) {
    emit(path, blob[0], blob[1]);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    // Keys are plain identifiers in every transcript shape, so a dotted path
    // stays unambiguous; a key that did contain a dot would only make the
    // locator unresolvable, never point it somewhere else.
    walkBlobs(child, path ? `${path}.${key}` : key, emit);
  }
}

/**
 * The transcript reordered so a `tool_result` never precedes the `tool_use` it
 * answers. Ordinarily it cannot: the call is written, then the result. But a
 * tool the harness resolves in-process — ToolSearch above all — finishes in the
 * same millisecond it was requested, and the two lines occasionally reach the
 * file inverted. The parent chain still records which happened first; only the
 * byte order lies. Reading such a session forward, the result arrives before
 * any step exists to hang it on and is dropped, so the call renders with no
 * output at all.
 *
 * Inverted events are moved to just after their call. Everything else keeps
 * its place, and a transcript with nothing out of order comes back untouched.
 */
function orderToolResults(events: RawEvent[]): RawEvent[] {
  // Where each `tool_use` id was requested.
  const callAt = new Map<string, number>();
  events.forEach((event, i) => {
    const content = event.message?.content;
    if (!Array.isArray(content)) {
      return;
    }
    for (const block of content as any[]) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' && !callAt.has(block.id)) {
        callAt.set(block.id, i);
      }
    }
  });

  // Position to sort by: its own index, except for a result that ran ahead of
  // its call, which lands immediately behind the last call it answers. Ties
  // keep their relative order, so two results of one message stay paired with
  // it in the order the transcript wrote them.
  let inverted = false;
  const keyed = events.map((event, i) => {
    const content = event.message?.content;
    let key = i;
    if (Array.isArray(content)) {
      for (const block of content as any[]) {
        if (block?.type !== 'tool_result') {
          continue;
        }
        const at = callAt.get(block.tool_use_id);
        if (at !== undefined && at > i) {
          key = Math.max(key, at + 0.5);
          inverted = true;
        }
      }
    }
    return { event, key, i };
  });

  if (!inverted) {
    return events;
  }
  return keyed
    .sort((a, b) => (a.key === b.key ? a.i - b.i : a.key - b.key))
    .map(entry => entry.event);
}

/**
 * The same value with every base64 payload replaced by a one-line marker. A
 * result that carried a screenshot would otherwise be held twice — once as the
 * megabytes on `step.toolResult`, once as the attachment the webview fetches
 * on demand — and the raw view would be a wall of base64. The bytes stay
 * reachable: `collectEventAttachments` indexes them by path in the untouched
 * event.
 */
function withoutBlobBytes(value: any): any {
  if (Array.isArray(value)) {
    return value.map(withoutBlobBytes);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const blob = readBlobNode(value);
  if (blob) {
    const marker = `[base64 · ${base64Size(blob[0])} bytes]`;
    return typeof value.base64 === 'string'
      ? { ...value, base64: marker }
      : { ...value, data: marker };
  }
  const copy: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    copy[key] = withoutBlobBytes(child);
  }
  return copy;
}

/** A blob found in an event, with the path that leads back to its bytes. */
interface EventAttachment {
  path: string;
  attachment: Attachment;
}

/**
 * Take the blobs sitting at or below `prefix` out of an event's pool. Claiming
 * removes them, so each blob lands on exactly one step and whatever no step
 * wanted is still identifiable afterwards.
 */
function claimAttachments(pool: EventAttachment[], prefix: string): Attachment[] {
  const claimed: Attachment[] = [];
  for (let i = pool.length - 1; i >= 0; i--) {
    const { path } = pool[i];
    if (path === prefix || path.startsWith(`${prefix}.`)) {
      claimed.unshift(pool[i].attachment);
      pool.splice(i, 1);
    }
  }
  return claimed;
}

/**
 * Hang blobs off a step, naming them after their place in it — the name is
 * what the user sees in the save dialog, so it says which step it came from
 * rather than repeating the path through the JSON.
 */
function attachTo(step: Step, attachments: Attachment[]): void {
  if (attachments.length === 0) {
    return;
  }
  const list = step.attachments ?? [];
  for (const attachment of attachments) {
    attachment.name = `step-${step.index}-${list.length + 1}.${extensionFor(attachment.mediaType)}`;
    list.push(attachment);
  }
  step.attachments = list;
}

/**
 * `toolDenialKind` → who stopped the call. Every value Claude Code writes is
 * here; an unrecognised one still becomes a step permission (with the raw kind
 * as its label) rather than disappearing, because the fact that a call was
 * refused matters more than our knowing the word for it.
 */
const DENIAL_SOURCES: Record<string, { decidedBy: StepPermission['decidedBy']; label: string }> = {
  'user-rejected': { decidedBy: 'user', label: 'Denied by user' },
  'permission-rule': { decidedBy: 'rule', label: 'Denied by permission rule' },
  'automode-blocked': { decidedBy: 'automode', label: 'Blocked by auto mode' },
  'automode-unavailable': { decidedBy: 'automode', label: 'Auto mode unavailable' },
  cancelled: { decidedBy: 'user', label: 'Cancelled by user' },
};

// The reason travels inside the refusal text rather than a field of its own:
// what the person typed when they said no, and what the auto-mode classifier
// objected to. Both are the sentence after a fixed lead-in.
const USER_REASON_RE = /following reason for the rejection:\s*([\s\S]+)$/i;
const AUTOMODE_REASON_RE = /auto mode classifier\.\s*Reason:\s*([\s\S]*?)(?:\s*If you have other tasks|$)/i;

// Pre-2.1.198 transcripts have no `toolDenialKind`. This sentence is all that
// is left of a refusal there — it says a call was stopped, never by what.
const LEGACY_DENIAL_RE = /user doesn't want to proceed with this tool use/i;

/**
 * What a refusal says, as one line. Never the whole message: the full text is
 * already in the tool result below it, and the boilerplate about not working
 * around the denial is the same on every one of them.
 */
function denialReason(text: string): string | undefined {
  const reason = USER_REASON_RE.exec(text)?.[1] ?? AUTOMODE_REASON_RE.exec(text)?.[1];
  return reason?.trim() || undefined;
}

/** The refusal text, whatever shape `toolUseResult` took on this transcript. */
function denialText(result: any, fallback: string): string {
  if (typeof result === 'string') {
    return result;
  }
  if (result && typeof result === 'object' && typeof (result as any).content === 'string') {
    return (result as any).content;
  }
  return fallback;
}

/**
 * The decision a `PreToolUse` hook printed, or null when it printed nothing —
 * a hook that only observed the call, or one whose output is not the JSON
 * Claude Code reads. `ask` is a decision to not decide: it hands the call to
 * the person, so whatever happened next is off the record and the step is left
 * unmarked.
 */
function hookDecision(attachment: RawEvent['attachment']): StepPermission | null {
  const parsed = tryParseJson(attachment?.stdout ?? '');
  const output = parsed?.hookSpecificOutput;
  const decision = output?.permissionDecision;
  if (decision !== 'allow' && decision !== 'deny') {
    return null;
  }
  const hookName = typeof attachment?.hookName === 'string' ? attachment.hookName : undefined;
  const reason =
    typeof output.permissionDecisionReason === 'string'
      ? output.permissionDecisionReason.trim() || undefined
      : undefined;
  return {
    outcome: decision === 'allow' ? 'allowed' : 'denied',
    decidedBy: 'hook',
    label: decision === 'allow' ? 'Allowed by hook' : 'Denied by hook',
    reason,
    hookName,
  };
}

interface QuickMetadata {
  model: string;
  firstTimestamp: string;
  lastTimestamp: string;
  prompt: string;
  cwd: string;
  /**
   * Session title Claude Code generates and rewrites as a `{"type":"ai-title"}`
   * line. Empty when the session never got one.
   */
  aiTitle: string;
}

export class ParserService {
  /**
   * Parse a JSONL file and return all events
   */
  async parseFile(filePath: string): Promise<RawEvent[]> {
    const events: RawEvent[] = [];
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const event = JSON.parse(trimmed) as RawEvent;
        events.push(event);
      } catch (err) {
        // Skip unparseable lines
        continue;
      }
    }

    return events;
  }

  /**
   * Extract quick metadata from a session file without full parsing
   */
  async quickMetadataWithPrompt(filePath: string): Promise<QuickMetadata | null> {
    try {
      const fileStream = fs.createReadStream(filePath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      let model = '';
      let firstTimestamp = '';
      let lastTimestamp = '';
      let prompt = '';
      let cwd = '';
      let aiTitle = '';
      let foundFirst = false;
      let lines = 0;

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        lines++;

        try {
          const base: any = JSON.parse(trimmed);

          if (!base.type) {
            continue;
          }

          if (!foundFirst) {
            firstTimestamp = base.timestamp || '';
            foundFirst = true;
          }

          if (base.timestamp) {
            lastTimestamp = base.timestamp;
          }

          if (!cwd && base.cwd) {
            cwd = base.cwd;
          }

          // Extract model from assistant events
          if (!model && base.type === 'assistant' && base.message?.model) {
            if (base.message.model !== '<synthetic>') {
              model = base.message.model;
            }
          }

          if (!aiTitle && base.type === 'ai-title' && typeof base.aiTitle === 'string') {
            aiTitle = base.aiTitle.trim();
          }

          // Extract prompt from user events
          if (!prompt && base.type === 'user') {
            prompt = this.extractPromptFromEvent(base);
          }

          // Stop early once we have all the metadata we need, or once we are
          // deep enough that whatever is still missing is not coming.
          if ((model && prompt && cwd && aiTitle) || lines >= HEAD_SCAN_LINES) {
            rl.close();
            break;
          }
        } catch {
          continue;
        }
      }

      if (!foundFirst) {
        return null;
      }

      // The title seen in the head can be a draft that a later line replaces.
      const finalTitle = await this.readTailAiTitle(filePath);

      return {
        model,
        firstTimestamp,
        lastTimestamp,
        prompt,
        cwd,
        aiTitle: finalTitle || aiTitle,
      };
    } catch (err) {
      console.error('Error reading metadata from', filePath, err);
      return null;
    }
  }

  /**
   * Last `ai-title` written in the tail window of a transcript, or '' when the
   * window holds none. Reading the tail rather than the whole file keeps
   * discovery off multi-megabyte transcripts; the caller falls back to the
   * title from the head when this comes back empty.
   */
  private async readTailAiTitle(filePath: string): Promise<string> {
    try {
      const { size } = await fs.promises.stat(filePath);
      const start = Math.max(0, size - TAIL_SCAN_BYTES);

      const chunk = await new Promise<string>((resolve, reject) => {
        const parts: Buffer[] = [];
        const stream = fs.createReadStream(filePath, { start });
        stream.on('data', part => parts.push(part as Buffer));
        stream.on('end', () => resolve(Buffer.concat(parts).toString('utf-8')));
        stream.on('error', reject);
      });

      const lines = chunk.split('\n');
      // A window that starts mid-file opens on a partial line.
      const first = start > 0 ? 1 : 0;

      for (let i = lines.length - 1; i >= first; i--) {
        const line = lines[i];
        if (!line.includes('"ai-title"')) {
          continue;
        }
        try {
          const event: any = JSON.parse(line);
          if (event.type === 'ai-title' && typeof event.aiTitle === 'string') {
            return event.aiTitle.trim();
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Unreadable file: the head pass already reported what it could.
    }

    return '';
  }

  /**
   * Read history.jsonl and return a map of sessionId -> HistoryEntry
   */
  async readHistoryMap(): Promise<Map<string, HistoryEntry>> {
    const historyMap = new Map<string, HistoryEntry>();
    const historyPath = path.join(getClaudeConfigDir(), 'history.jsonl');

    if (!fs.existsSync(historyPath)) {
      return historyMap;
    }

    try {
      const fileStream = fs.createReadStream(historyPath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const entry = JSON.parse(trimmed) as HistoryEntry;
          // First entry wins: a session's later entries are whatever was typed
          // last, so keeping them would label sessions "/exit" or "/context".
          if (entry.sessionId && !historyMap.has(entry.sessionId)) {
            historyMap.set(entry.sessionId, entry);
          }
        } catch {
          continue;
        }
      }
    } catch (err) {
      console.error('Error reading history.jsonl:', err);
    }

    return historyMap;
  }

  /**
   * Build a SessionDetail from parsed events
   */
  buildSession(
    rawEvents: RawEvent[],
    sessionId: string,
    prompt: string,
    project: string
  ): SessionDetail {
    // A single forward pass reads each result against the calls seen so far,
    // so the few results a transcript records ahead of their call are put
    // back behind them first.
    const events = orderToolResults(rawEvents);
    const steps: Step[] = [];
    const filesRead = new Set<string>();
    const filesWritten = new Set<string>();
    const toolsUsed = new Map<string, number>();

    let model = '';
    let startTime = new Date();
    let endTime = new Date();
    let totalCost = 0;

    // Track tool calls and their results. Two indexes: by the assistant
    // event's UUID (what `sourceToolAssistantUUID` points at) and by the
    // `tool_use` block id (what a `tool_result` block points at).
    const toolCallMap = new Map<string, Partial<Step>>();
    const toolCallByUseId = new Map<string, Partial<Step>>();

    // One API response is written as several JSONL events — one per content
    // block — each repeating the same `message.id`. Charging every event would
    // multiply the bill by the block count, so a message is priced the first
    // time its id is seen and its siblings cost 0.
    const chargedMessages = new Set<string>();
    // Cost priced but not yet attached to a step, keyed by message id.
    const unbilled = new Map<string, number>();
    // The `usage` those events carry is *not* identical: input and cache counts
    // repeat, but `output_tokens` accumulates as the response streams, so early
    // events hold a partial count and only the last one is final. Pricing off
    // whichever event happens to come first therefore undercharges output.
    const finalUsage = this.findFinalUsage(events);
    // Messages that render to nothing. With thinking `display: "omitted"` —
    // the default on current models — a reasoning turn is recorded as a
    // `thinking` block with empty text, so a message can consist solely of
    // blocks that produce no step while still having been billed. Those get a
    // placeholder step rather than dropping the charge off the timeline.
    const blankMessages = this.findBlankMessages(events);
    // Which slash command each `local_command` invocation was, keyed by its
    // uuid, so the output event that follows can name the command it came from.
    const localCommands = new Map<string, string>();

    for (const event of events) {
      // Session-level model, for display only. Costs use each message's own
      // model — a session can switch models mid-way.
      if (!model && event.message?.model && event.message.model !== '<synthetic>') {
        model = event.message.model;
      }

      // Extract timestamps
      if (event.timestamp) {
        const ts = new Date(event.timestamp);
        if (!startTime || ts < startTime) {
          startTime = ts;
        }
        if (!endTime || ts > endTime) {
          endTime = ts;
        }
      }

      // Blobs the event carries, found by shape rather than by message type.
      // Each is claimed by whichever step turns out to own it; whatever is
      // left over gets a step of its own below, so an image can never be lost
      // just because the message around it renders to nothing.
      const blobs = this.collectEventAttachments(event);

      // What the user actually typed. Tool results ride on user events too,
      // so they are filtered out — by `toolUseResult` where it is present, and
      // by the content shape for the sub-agent transcripts that omit it.
      if (event.type === 'user' && !event.isCompactSummary && !event.isMeta && !event.toolUseResult) {
        const content = event.message?.content;
        const isToolResult =
          Array.isArray(content) && content.some((block: any) => block?.type === 'tool_result');

        if (!isToolResult) {
          const text = this.extractUserInput(content);
          // A pasted screenshot with no caption is a turn too: the message
          // carries an image block and nothing else, so keying the step off
          // the text alone would drop it from the timeline entirely.
          const attachments = claimAttachments(blobs, 'message.content');
          if (text || attachments.length > 0) {
            const step: Step = {
              index: steps.length,
              type: 'user',
              timestamp: new Date(event.timestamp),
              uuid: event.uuid,
              messageId: event.message?.id ?? '',
              content: text,
              cost: 0,
            };
            attachTo(step, attachments);
            steps.push(step);
          }
        }
      }

      // A message typed while a turn was still running. Claude Code absorbs it
      // mid-turn and never replays it as a user event, so this `attachment`
      // record is the only place it exists — without this the text is simply
      // missing from the timeline, image and all. The harness queues its own
      // commands the same way (background-task notifications), but those are
      // `<task-notification>` wrappers that clean away to nothing.
      if (event.type === 'attachment' && event.attachment?.type === 'queued_command') {
        const text = this.extractUserInput(event.attachment.prompt);
        const attachments = claimAttachments(blobs, 'attachment.prompt');
        if (text || attachments.length > 0) {
          const step: Step = {
            index: steps.length,
            type: 'user',
            timestamp: new Date(event.timestamp),
            uuid: event.uuid,
            messageId: '',
            content: text,
            cost: 0,
          };
          attachTo(step, attachments);
          steps.push(step);
        }
      }

      // A hook that refused a tool call. It has no message of its own — the
      // harness records it as a bare `attachment` event — so without a step of
      // its own the timeline shows a call whose result simply never arrives,
      // even though the model was handed the error and changed course over it.
      if (event.type === 'attachment' && event.attachment?.type === 'hook_blocking_error') {
        const step = this.buildHookErrorStep(event, steps.length);
        if (step) {
          steps.push(step);
        }
      }

      // A `PreToolUse` hook's verdict on the call it fired on. The transcript
      // writes it between the `tool_use` and its result, so the step it belongs
      // to is already built. This is the only place a permission that let a
      // call *through* is ever recorded — everything else on the record is a
      // refusal — so it is worth reading even though most of them are a
      // whitelist saying yes to a `git status`.
      if (event.type === 'attachment' && event.attachment?.hookEvent === 'PreToolUse') {
        const target = event.attachment.toolUseID
          ? toolCallByUseId.get(event.attachment.toolUseID)
          : undefined;
        if (target && typeof target.index === 'number') {
          const decision =
            event.attachment.type === 'hook_blocking_error'
              ? // A hook that blocked the call: it gets its own system step for
                // the error text, but the call itself should say why it never ran.
                ({
                  outcome: 'denied',
                  decidedBy: 'hook',
                  label: 'Denied by hook',
                  hookName:
                    typeof event.attachment.hookName === 'string'
                      ? event.attachment.hookName
                      : undefined,
                } as StepPermission)
              : hookDecision(event.attachment);
          // A refusal already on the step outranks a hook's yes: two hooks can
          // fire on one call, and the one that stopped it is the answer.
          if (decision && steps[target.index].permission?.outcome !== 'denied') {
            steps[target.index].permission = decision;
          }
        }
      }

      // A hook that failed and was let through anyway. Nothing downstream shows
      // it: the tool call went ahead, the turn ended, and the only trace that a
      // notification never fired or a formatter never ran is this event. They
      // repeat — the same unreadable script fails on every turn — which is the
      // point, so each one stays its own row.
      if (event.type === 'attachment' && event.attachment?.type === 'hook_non_blocking_error') {
        const step = this.buildHookNonBlockingErrorStep(event, steps.length);
        if (step) {
          steps.push(step);
        }
      }

      // A request that failed and was retried. The attempt that worked is
      // written as an ordinary assistant message, so without these the minute a
      // turn spent on ten 429s reads as the model having been slow.
      if (event.type === 'system' && event.subtype === 'api_error') {
        const step = this.buildApiErrorStep(event, steps.length);
        if (step) {
          steps.push(step);
        }
      }

      // A slash command the CLI answered by itself — /resume, /model, /mcp. It
      // never reaches the model, so the timeline otherwise shows the session
      // pausing for no reason, and for the commands that print something the
      // output is the only explanation of what the person just read.
      if (event.type === 'system' && event.subtype === 'local_command') {
        const step = this.buildLocalCommandStep(event, steps.length, localCommands);
        if (step) {
          steps.push(step);
        }
      }

      // What the Stop hooks did when a turn ended.
      if (event.type === 'system' && event.subtype === 'stop_hook_summary') {
        const step = this.buildStopHookStep(event, steps.length);
        if (step) {
          steps.push(step);
        }
      }

      // Context compaction. Claude Code records it as a user event carrying
      // the hand-off summary that replaces the dropped history — there is no
      // assistant message for it, so give it a step of its own to keep the
      // boundary visible in the timeline.
      if (event.type === 'user' && event.isCompactSummary === true) {
        const step: Step = {
          index: steps.length,
          type: 'compact',
          timestamp: new Date(event.timestamp),
          uuid: event.uuid,
          messageId: event.message?.id ?? '',
          content: this.extractTextContent(event.message?.content),
          cost: 0,
        };
        attachTo(step, claimAttachments(blobs, 'message.content'));
        steps.push(step);
      }

      // Process assistant messages
      if (event.type === 'assistant' && event.message) {
        // Always the message's final counts, never this event's partial ones,
        // so every step of a response reports the same usage and any consumer
        // that de-duplicates by message id agrees with the total.
        const usage =
          (event.message.id ? finalUsage.get(event.message.id) : undefined) ??
          event.message.usage;
        const eventModel =
          event.message.model && event.message.model !== '<synthetic>'
            ? event.message.model
            : model;

        // Charge this message once, on whichever of its blocks lands first.
        const messageId = event.message.id ?? '';
        const priced = messageId !== '' && chargedMessages.has(messageId);
        if (!priced && usage) {
          const c = calculateCost(usage, eventModel);
          totalCost += c;
          unbilled.set(messageId, c);
        }
        if (messageId !== '') {
          chargedMessages.add(messageId);
        }
        const costIsEstimate =
          !!usage && getModelPricing(eventModel).isFallback;

        // Drains on first read, so the charge lands on the first step the
        // message actually produces — blocks that yield no step (empty text,
        // unrecognised types) must not swallow it.
        const cost = () => {
          const c = unbilled.get(messageId) ?? 0;
          unbilled.delete(messageId);
          return c;
        };

        // Ensure content is an array
        const content = Array.isArray(event.message.content) ? event.message.content : [];

        if (blankMessages.has(messageId) && unbilled.has(messageId)) {
          steps.push({
            index: steps.length,
            type: 'thinking',
            timestamp: new Date(event.timestamp),
            uuid: event.uuid,
            messageId,
            content: '(reasoning not recorded — thinking display is omitted)',
            usage,
            cost: cost(),
            costIsEstimate,
            model: eventModel,
          });
        }

        for (const block of content) {
          if (block.type === 'thinking' && block.thinking) {
            steps.push({
              index: steps.length,
              type: 'thinking',
              timestamp: new Date(event.timestamp),
              uuid: event.uuid,
              messageId: event.message.id,
              content: block.thinking,
              usage,
              cost: cost(),
              costIsEstimate,
              model: eventModel,
            });
          } else if (block.type === 'text' && block.text) {
            steps.push({
              index: steps.length,
              type: 'text',
              timestamp: new Date(event.timestamp),
              uuid: event.uuid,
              messageId: event.message.id,
              content: block.text,
              usage,
              cost: cost(),
              costIsEstimate,
              model: eventModel,
            });
          } else if (block.type === 'tool_use' && block.name) {
            const toolStep: Partial<Step> = {
              index: steps.length,
              type: 'tool_call',
              timestamp: new Date(event.timestamp),
              uuid: event.uuid,
              messageId: event.message.id,
              content: '',
              toolName: block.name,
              toolInput: block.input,
              // Block-level id (`toolu_…`). Sub-agent meta.json references it
              // as `toolUseId`, which is the only way to locate the Task step
              // that spawned a nested agent.
              toolUseId: block.id,
              usage,
              cost: cost(),
              costIsEstimate,
              model: eventModel,
            };

            // Key by assistant event UUID — sourceToolAssistantUUID in
            // user events references this, not the tool_use block id.
            toolCallMap.set(event.uuid, toolStep);
            if (block.id) {
              toolCallByUseId.set(block.id, toolStep);
            }

            steps.push(toolStep as Step);

            // Track tool usage
            toolsUsed.set(block.name, (toolsUsed.get(block.name) || 0) + 1);

            // Track files from tool input
            if (block.name === 'Read' && block.input?.file_path) {
              filesRead.add(block.input.file_path);
            } else if (
              (block.name === 'Write' || block.name === 'Edit') &&
              block.input?.file_path
            ) {
              filesWritten.add(block.input.file_path);
            }
          }
        }

        // An image the assistant itself put in a message: no block type of
        // ours renders it, so it rides along with the last step this message
        // produced. When the message produced no step at all, it stays in the
        // pool and gets one of its own below.
        const last = steps[steps.length - 1];
        if (last && last.uuid === event.uuid) {
          attachTo(last, claimAttachments(blobs, 'message.content'));
        }
      }

      // Process tool results. Two transcript shapes carry them:
      //  - main sessions put the structured body on `event.toolUseResult`
      //    (`{stdout, stderr, …}`, `{file: {content, …}}`, …) — the shape the
      //    per-tool renderers expect;
      //  - sub-agent transcripts omit `toolUseResult` entirely and keep the
      //    body only inside the `tool_result` content blocks, as plain text.
      // Without the second path every tool call inside an agent renders with
      // no output at all.
      // The error flag (`is_error: true`) always lives on the content block,
      // never on `toolUseResult` (which is often just a preview string), with
      // a string-prefix fallback for older sessions that stored the result as
      // a plain "Error: ..." string.
      if (event.type === 'user') {
        const blocks: any[] = Array.isArray(event.message?.content)
          ? (event.message!.content as any[])
          : [];
        // Positions are carried along with the blocks: an attachment locator
        // has to index into `message.content` as it sits on disk, not into
        // the filtered list.
        const resultBlocks = blocks
          .map((block, at) => ({ block, at }))
          .filter(({ block }) => block && block.type === 'tool_result');
        const hasLegacyResult =
          event.toolUseResult !== undefined && !!event.sourceToolAssistantUUID;

        if (resultBlocks.length > 0 || hasLegacyResult) {
          // No blocks at all → one pass driven by `toolUseResult` alone.
          const entries = resultBlocks.length > 0 ? resultBlocks : [{ block: null as any, at: -1 }];
          // `toolUseResult` describes the turn as a whole, so it can only be
          // attributed when the turn carries a single result.
          const legacyApplies = hasLegacyResult && entries.length === 1;

          for (const { block, at } of entries) {
            const toolStep =
              (block?.tool_use_id ? toolCallByUseId.get(block.tool_use_id) : undefined) ??
              (event.sourceToolAssistantUUID
                ? toolCallMap.get(event.sourceToolAssistantUUID)
                : undefined);
            if (!toolStep || typeof toolStep.index !== 'number') {
              continue;
            }

            const result = legacyApplies
              ? withoutBlobBytes(event.toolUseResult)
              : this.extractToolResultBody(block);
            if (result !== undefined) {
              steps[toolStep.index].toolResult = JSON.stringify(result);
            }

            let isError = block?.is_error === true;
            if (!isError && typeof result === 'object' && result !== null && (result as any).is_error === true) {
              isError = true;
            }
            if (!isError && typeof result === 'string' && /^error\b/i.test(result.trim())) {
              isError = true;
            }
            steps[toolStep.index].toolSuccess = !isError;

            // Why the call never ran, when it did not. `toolDenialKind` names
            // the source outright; older transcripts only have the sentence the
            // model was shown, which says a call was refused but not by whom —
            // recorded as `unknown` rather than guessed at.
            if (isError) {
              const text = denialText(result, typeof block?.content === 'string' ? block.content : '');
              const kind = event.toolDenialKind;
              if (typeof kind === 'string' && kind) {
                const known = DENIAL_SOURCES[kind];
                steps[toolStep.index].permission = {
                  outcome: 'denied',
                  decidedBy: known?.decidedBy ?? 'unknown',
                  label: known?.label ?? `Denied (${kind})`,
                  reason: denialReason(text),
                };
              } else if (LEGACY_DENIAL_RE.test(text)) {
                steps[toolStep.index].permission = {
                  outcome: 'denied',
                  decidedBy: 'unknown',
                  label: 'Denied — source not recorded',
                  reason: denialReason(text),
                };
              }
            }

            // Screenshots and other blobs a tool handed back. They belong to
            // the call that produced them, so they hang off the tool step
            // rather than the user event that transported them. A turn with a
            // single result also owns whatever sits outside the blocks —
            // `toolUseResult` for tools whose output never became a block.
            attachTo(steps[toolStep.index], claimAttachments(blobs, `message.content.${at}`));
            if (entries.length === 1) {
              attachTo(steps[toolStep.index], claimAttachments(blobs, 'toolUseResult'));
            }
          }
        }
      }

      // Blobs from an event no step claimed — a queued paste (`attachment`
      // events), an image on a message the timeline skips, a result shape
      // nobody could attribute. They get a step of their own so the picture is
      // still reachable, even though the message around it stays unrendered.
      if (blobs.length > 0) {
        const step: Step = {
          index: steps.length,
          type: 'attachment',
          timestamp: new Date(event.timestamp),
          uuid: event.uuid,
          messageId: event.message?.id ?? '',
          content: '',
          cost: 0,
        };
        attachTo(step, blobs.splice(0).map(entry => entry.attachment));
        steps.push(step);
      }
    }

    const durationMs = endTime.getTime() - startTime.getTime();

    return {
      sessionId,
      prompt,
      project,
      model,
      startTime,
      endTime,
      durationMs,
      totalCost,
      steps,
      subagents: [],
      filesRead: Array.from(filesRead),
      filesWritten: Array.from(filesWritten),
      toolsUsed: Object.fromEntries(toolsUsed),
    };
  }

  /**
   * Step for an `attachment/hook_blocking_error` event — a hook that blocked a
   * tool call.
   *
   * `blockingError` holds the message the model was shown plus the command that
   * produced it. The message already quotes the command in every transcript we
   * have (`[<command>]: <stderr>`), so the command is only prepended where it
   * does not, rather than printed twice.
   */
  private buildHookErrorStep(event: RawEvent, index: number): Step | null {
    const attachment = event.attachment ?? {};
    const raw = attachment.blockingError;
    const detail = typeof raw === 'string' ? { blockingError: raw, command: '' } : raw ?? {};
    const message = typeof detail.blockingError === 'string' ? detail.blockingError.trim() : '';
    const command = typeof detail.command === 'string' ? detail.command.trim() : '';
    // A shape we don't recognise still reaches the timeline as its own JSON —
    // an unreadable step beats a missing one.
    const text = message || (raw !== undefined ? JSON.stringify(raw) : '');
    if (!text) {
      return null;
    }

    return {
      index,
      type: 'system',
      systemKind: 'hook_blocking_error',
      systemSeverity: 'error',
      systemSource: typeof attachment.hookName === 'string' ? attachment.hookName : undefined,
      timestamp: new Date(event.timestamp),
      uuid: event.uuid,
      messageId: '',
      content: command && !text.includes(command) ? `$ ${command}\n\n${text}` : text,
      cost: 0,
    };
  }

  /**
   * Step for an `attachment/hook_non_blocking_error` event — a hook that failed
   * without stopping anything.
   *
   * Read as a shell would report it: the command, what it printed, then how it
   * ended. `stderr` carries the failure in every transcript we have and `stdout`
   * is empty, but both are shown when both are there — a hook that logged its
   * way up to the failure is exactly the one being read.
   *
   * The event names what the hook fired on in `toolUseID`; it is kept on the
   * step so a `PostToolUse` failure can be tied back to its tool call. For a
   * `Stop` hook, which fires on no tool, it is the uuid of the message that
   * ended the turn.
   */
  private buildHookNonBlockingErrorStep(event: RawEvent, index: number): Step | null {
    const attachment = event.attachment ?? {};
    const command = typeof attachment.command === 'string' ? attachment.command.trim() : '';
    const stderr = typeof attachment.stderr === 'string' ? attachment.stderr.trim() : '';
    const stdout = typeof attachment.stdout === 'string' ? attachment.stdout.trim() : '';
    const exitCode = typeof attachment.exitCode === 'number' ? attachment.exitCode : undefined;
    const durationMs =
      typeof attachment.durationMs === 'number' ? attachment.durationMs : undefined;

    // The status line is the one part that is always knowable, so a hook that
    // printed nothing still reaches the timeline saying it failed.
    const status = [
      exitCode !== undefined ? `exit ${exitCode}` : '',
      durationMs !== undefined ? `${durationMs}ms` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const body = [command ? `$ ${command}` : '', stderr, stdout, status]
      .filter(Boolean)
      .join('\n\n');
    if (!body) {
      return null;
    }

    return {
      index,
      type: 'system',
      systemKind: 'hook_non_blocking_error',
      systemSeverity: 'error',
      systemSource: typeof attachment.hookName === 'string' ? attachment.hookName : undefined,
      timestamp: new Date(event.timestamp),
      uuid: event.uuid,
      messageId: '',
      toolUseId: typeof attachment.toolUseID === 'string' ? attachment.toolUseID : undefined,
      content: body,
      cost: 0,
    };
  }

  /**
   * Step for a `system/api_error` event — a request that failed and was retried.
   *
   * One step per event, so a burst of retries reads as the burst it was: the
   * rows sit between the same two steps the wait happened between, and their
   * timestamps show how long the backoff actually took. Nothing is folded
   * together — ten identical 429s are ten attempts, and collapsing them would
   * hide the one number worth having.
   */
  private buildApiErrorStep(event: RawEvent, index: number): Step | null {
    const error = event.error;
    if (error === undefined || error === null) {
      return null;
    }

    // The whole object follows the headline, so a shape we read wrongly still
    // hands over everything the transcript had — request ids and proxy headers
    // included, which is what a support ticket ends up needing.
    const detail =
      typeof error === 'object' ? `\n\n\`\`\`json\n${JSON.stringify(error, null, 2)}\n\`\`\`` : '';

    return {
      index,
      type: 'system',
      systemKind: 'api_error',
      systemSeverity: 'error',
      systemSource: this.apiErrorSource(event),
      timestamp: new Date(event.timestamp),
      uuid: event.uuid,
      messageId: '',
      content: `${this.apiErrorHeadline(error) || 'API request failed'}${detail}`,
      cost: 0,
    };
  }

  /**
   * Step for a `system/local_command` event — a slash command the CLI ran
   * without asking the model.
   *
   * One command is two events sharing the subtype: the invocation, then its
   * output. They stay two rows, because they are two things that happened and
   * a long `/status` dump under the row that asked for it is exactly what a
   * user would then have to fold away again. The invocation records its name in
   * `commands` so the output can be labelled `/status · output` instead of
   * standing there anonymous — the two events are only linked by `parentUuid`.
   */
  private buildLocalCommandStep(
    event: RawEvent,
    index: number,
    commands: Map<string, string>
  ): Step | null {
    const raw = typeof event.content === 'string' ? event.content : '';
    if (raw.trim() === '') {
      return null;
    }

    const step = (source: string | undefined, content: string): Step => ({
      index,
      type: 'system',
      systemKind: 'local_command',
      // The CLI answering a slash command is the CLI working.
      systemSeverity: 'notice',
      systemSource: source,
      timestamp: new Date(event.timestamp),
      uuid: event.uuid,
      messageId: '',
      content,
      cost: 0,
    });

    const name = raw.match(COMMAND_NAME_RE)?.[1].trim() ?? '';
    if (name) {
      commands.set(event.uuid, name);
      // `<command-message>` is the name without its slash in every transcript
      // we have, so it is dropped rather than printed beside it.
      const args = raw.match(COMMAND_ARGS_RE)?.[1].trim() ?? '';
      return step(name, args);
    }

    const stdout = raw.match(COMMAND_STDOUT_RE)?.[1] ?? '';
    // Neither shape: kept whole rather than guessed at, so a format we have not
    // seen still reaches the timeline.
    const text = (stdout || raw).trim();
    if (text === '') {
      return null;
    }
    const from = event.parentUuid ? commands.get(event.parentUuid) : undefined;
    return step(from ? `${from} · output` : 'output', text);
  }

  /**
   * Step for a `system/stop_hook_summary` event — the Stop hooks that ran when
   * a turn ended.
   *
   * Written after every turn, so most of these say nothing but "one hook ran,
   * it took 7ms". They are still one row each: the count in the header button
   * is how often the hooks fired, and the rows worth finding — a hook that
   * errored, or one that refused to let the turn end — are found by reading
   * down the same list rather than by trusting this parser's idea of dull.
   */
  private buildStopHookStep(event: RawEvent, index: number): Step | null {
    const hooks = Array.isArray(event.hookInfos) ? event.hookInfos : [];
    const errors = (Array.isArray(event.hookErrors) ? event.hookErrors : [])
      .map(error => (typeof error === 'string' ? error.trim() : ''))
      .filter(Boolean);
    const added = (Array.isArray(event.hookAdditionalContext) ? event.hookAdditionalContext : [])
      .map(text => (typeof text === 'string' ? text.trim() : ''))
      .filter(Boolean);
    const count = typeof event.hookCount === 'number' ? event.hookCount : hooks.length;
    if (count === 0 && errors.length === 0) {
      return null;
    }

    const stopReason = typeof event.stopReason === 'string' ? event.stopReason.trim() : '';
    const blocked = event.preventedContinuation === true;

    const lines: string[] = hooks.map(hook => {
      const command = typeof hook?.command === 'string' ? hook.command.trim() : '(unnamed hook)';
      const ms = typeof hook?.durationMs === 'number' ? ` (${hook.durationMs}ms)` : '';
      return `$ ${command}${ms}`;
    });
    if (blocked) {
      // The one outcome that changed the run: the turn did not end here.
      lines.push('', `continuation blocked${stopReason ? `: ${stopReason}` : ''}`);
    }
    for (const error of errors) {
      lines.push('', error);
    }
    for (const text of added) {
      lines.push('', text);
    }

    return {
      index,
      type: 'system',
      systemKind: 'stop_hook_summary',
      // Hooks having run is not a failure; a hook that fell over, or one that
      // sent the model back to work, is.
      systemSeverity: errors.length > 0 || blocked ? 'error' : 'notice',
      systemSource: this.stopHookSource(count, errors.length, blocked),
      timestamp: new Date(event.timestamp),
      uuid: event.uuid,
      messageId: '',
      content: lines.join('\n').trim(),
      cost: 0,
    };
  }

  /**
   * What is shown ahead of a stop-hook row: how many hooks ran and whether
   * anything came of it — `2 hooks · 1 error`, `1 hook · blocked`.
   */
  private stopHookSource(count: number, errors: number, blocked: boolean): string {
    const ran = `${count} hook${count === 1 ? '' : 's'}`;
    const failed = errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : '';
    return [ran, blocked ? 'blocked' : '', failed].filter(Boolean).join(' · ');
  }

  /**
   * What is shown ahead of the message on an API error row: what came back and
   * which attempt this was — `429 · retry 1/10`. A request that never reached
   * the API has no status, so the socket's code stands in for one.
   */
  private apiErrorSource(event: RawEvent): string | undefined {
    const error = typeof event.error === 'object' && event.error ? event.error : {};
    const code = error.connection?.code ?? error.cause?.code;
    const what =
      (typeof error.status === 'number' ? String(error.status) : '') ||
      (typeof code === 'string' ? code : '') ||
      'api error';
    const attempt =
      typeof event.retryAttempt === 'number'
        ? `retry ${event.retryAttempt}${
            typeof event.maxRetries === 'number' ? `/${event.maxRetries}` : ''
          }`
        : '';
    return [what, attempt].filter(Boolean).join(' · ');
  }

  /**
   * The one line an API error is worth. `ApiError` documents the shapes; here
   * they collapse to a sentence, with the status left out because
   * `apiErrorSource` already carries it.
   */
  private apiErrorHeadline(error: ApiError | string): string {
    if (typeof error === 'string') {
      return error.trim();
    }

    const parts: string[] = [];
    const message = typeof error.message === 'string' ? error.message.trim() : '';
    // "429 {…}" — the JSON body after the status says what the status alone
    // cannot ("daily cost limit exceeded: 30.09 >= 30.00").
    const brace = message.indexOf('{');
    const body = brace >= 0 ? tryParseJson(message.slice(brace)) : undefined;
    if (body !== undefined) {
      parts.push(this.describeErrorBody(body) || message);
    } else if (message) {
      parts.push(message);
    } else {
      parts.push(this.describeErrorBody(error.error));
    }

    // A transport failure has no body at all, only the socket that gave up —
    // and where there is both, "Connection error." alone names neither.
    const connection = error.connection ?? error.cause;
    if (connection) {
      const code = typeof connection.code === 'string' ? connection.code : '';
      // The older events carry no sentence, only the URL that was being called.
      const detail =
        (typeof connection.message === 'string' ? connection.message.trim() : '') ||
        (typeof connection.path === 'string' ? connection.path.trim() : '');
      parts.push([code, detail].filter(Boolean).join(': '));
    }

    const headline = parts.filter(Boolean).join(' — ');
    // Nothing recognised: the raw line the harness formatted beats an empty row.
    return headline || (typeof error.formatted === 'string' ? error.formatted.trim() : '');
  }

  /**
   * The sentence inside an error body. A proxy wraps the real body in another
   * `error` — twice, for the LiteLLM gateway — and a quota refusal splits
   * itself between a headline (`error`) and the numbers behind it
   * (`stats.message`), so both are followed and joined.
   */
  private describeErrorBody(body: any, depth = 0): string {
    if (typeof body === 'string') {
      return body.trim();
    }
    if (!body || typeof body !== 'object' || depth > 3) {
      return '';
    }
    const own =
      this.describeErrorBody(body.error, depth + 1) ||
      (typeof body.message === 'string' ? body.message.trim() : '');
    const stats = body.stats;
    const numbers =
      stats && typeof stats === 'object' && typeof stats.message === 'string'
        ? stats.message.trim()
        : '';
    return [own, numbers].filter(Boolean).join(' — ');
  }

  /**
   * The body of a `tool_result` content block. The `content` field is either a
   * plain string or a list of blocks — `text`, `image`, `tool_reference`,
   * `search_result`, `document`, plus the MCP-only `audio`, `resource` and
   * `resource_link` that a server can hand back.
   *
   * A list of nothing but text is flattened, because that is what it is and it
   * keeps the step searchable as prose. Any other list is kept block by block:
   * flattening it used to mean silently dropping every type this method had no
   * branch for, and the renderer can only lay out what reaches it. Base64
   * payloads are dropped on the way through — the attachment carries them.
   */
  private extractToolResultBody(block: any): string | any[] | undefined {
    if (!block) {
      return undefined;
    }
    const content = block.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      const textOnly = content.every(
        c => typeof c === 'string' || (c?.type === 'text' && typeof c.text === 'string')
      );
      if (!textOnly) {
        return withoutBlobBytes(content);
      }
      return content.map(c => (typeof c === 'string' ? c : c.text)).join('\n');
    }
    if (content === undefined || content === null) {
      return undefined;
    }
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  /**
   * Every base64 blob an event carries, wherever it sits. Deliberately shape-
   * agnostic: the walk keys off the payload itself rather than off a list of
   * block types we know about, so a screenshot from an MCP server whose
   * result shape we have never seen still turns up. Bytes are not copied —
   * only the path back to them.
   */
  private collectEventAttachments(event: any): EventAttachment[] {
    const found: EventAttachment[] = [];
    // A blob duplicated inside one event is one attachment: Claude Code
    // writes a tool's screenshot twice, once as the block the model saw and
    // again under `toolUseResult`. Keyed on a prefix rather than a hash of
    // the whole payload, which would mean digesting megabytes per session.
    const seen = new Map<string, EventAttachment>();

    walkBlobs(event, '', (path, data, mediaType) => {
      const type = mediaType || 'application/octet-stream';
      const key = `${data.length}:${data.slice(0, 64)}`;
      const existing = seen.get(key);
      // The canonical copy is the one in `message.content`: it is what the
      // model was shown, and it survives when a result shape changes.
      if (existing) {
        if (path.startsWith('message.content') && !existing.path.startsWith('message.content')) {
          existing.path = path;
          existing.attachment.id = `${event.uuid}#${path}`;
        }
        return;
      }

      const attachment: Attachment = {
        id: `${event.uuid}#${path}`,
        kind: type.startsWith('image/') ? 'image' : 'file',
        mediaType: type,
        size: base64Size(data),
        // Provisional: renamed after the blob is attached to a step, which is
        // where a name the user will see in a save dialog can be built.
        name: `attachment.${extensionFor(type)}`,
      };
      const entry: EventAttachment = { path, attachment };
      seen.set(key, entry);
      found.push(entry);
    });

    return found;
  }

  /**
   * Fetch one attachment's bytes back out of a transcript, given the locator
   * `collectAttachments` handed the webview. Returns null when the line is
   * gone or the path no longer points at a base64 block.
   */
  async readAttachment(
    filePath: string,
    id: string
  ): Promise<{ mediaType: string; data: string } | null> {
    const hash = id.lastIndexOf('#');
    if (hash < 0) {
      return null;
    }
    const uuid = id.slice(0, hash);
    const path = id.slice(hash + 1).split('.');
    if (path.length === 0 || path.some(segment => segment === '')) {
      return null;
    }

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        // Cheap reject: parsing every line of a multi-megabyte transcript to
        // find one event costs far more than the substring scan.
        if (!line.includes(`"${uuid}"`)) {
          continue;
        }

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event?.uuid !== uuid) {
          continue;
        }

        // The path is a plain JSON walk from the event root, so it resolves
        // the same whether the blob sat in a message block, in a tool result,
        // or somewhere neither we nor the renderer understands.
        let node: any = event;
        for (const segment of path) {
          if (!node || typeof node !== 'object') {
            return null;
          }
          node = Array.isArray(node) ? node[Number(segment)] : node[segment];
        }

        const blob = node && typeof node === 'object' ? readBlobNode(node) : null;
        if (!blob) {
          return null;
        }
        return { mediaType: blob[1] || 'application/octet-stream', data: blob[0] };
      }
    } finally {
      rl.close();
      fileStream.destroy();
    }

    return null;
  }

  /**
   * Resolve the directory Claude Code writes sub-agent JSONLs into for a given
   * session. Layout is `<projectDir>/<sessionId>/subagents/`.
   */
  getSubagentsDir(projectDir: string, sessionId: string): string {
    return path.join(projectDir, sessionId, 'subagents');
  }

  /**
   * Transcript of one sub-agent. The file keeps the `agent-` prefix that the
   * canonical id stored internally does not.
   */
  getSubagentFilePath(projectDir: string, sessionId: string, agentId: string): string {
    return path.join(this.getSubagentsDir(projectDir, sessionId), `agent-${agentId}.jsonl`);
  }

  /**
   * Parse all sub-agent JSONLs for a session. Each agent's steps are tagged
   * with its agentId so they can be threaded into the parent session timeline.
   */
  async parseSubagents(projectDir: string, sessionId: string): Promise<SubagentInfo[]> {
    const subagentsDir = this.getSubagentsDir(projectDir, sessionId);

    if (!fs.existsSync(subagentsDir)) {
      return [];
    }

    const subagents: SubagentInfo[] = [];

    try {
      const files = fs.readdirSync(subagentsDir);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) {
          continue;
        }

        // Filenames carry an `agent-` prefix that the JSONL contents and the
        // spawning tool's `toolUseResult.agentId` do not. Strip it so the
        // canonical id matches across all three sources.
        const agentId = file.replace(/^agent-/, '').replace(/\.jsonl$/, '');
        const filePath = path.join(subagentsDir, file);
        const events = await this.parseFile(filePath);

        if (events.length === 0) {
          continue;
        }

        // Extract prompt from first user event
        let prompt = '';
        for (const event of events) {
          if (event.type === 'user') {
            prompt = this.extractPromptFromEvent(event);
            break;
          }
        }

        const session = this.buildSession(events, agentId, prompt, '');

        // Tag every step with its owning agentId so the flatten helper and
        // downstream tabs can distinguish agent activity from main session.
        for (const step of session.steps) {
          step.agentId = agentId;
        }

        // meta.json is written next to the JSONL with agentType + description.
        // The file keeps the `agent-` prefix even though the canonical id we
        // store internally does not.
        let agentType: string | undefined;
        let description: string | undefined;
        let parentAgentId: string | undefined;
        let toolUseId: string | undefined;
        let spawnDepth: number | undefined;
        const metaPath = path.join(subagentsDir, `agent-${agentId}.meta.json`);
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            agentType = typeof meta.agentType === 'string' ? meta.agentType : undefined;
            description = typeof meta.description === 'string' ? meta.description : undefined;
            // Present only for agents spawned from inside another agent.
            parentAgentId = typeof meta.parentAgentId === 'string' ? meta.parentAgentId : undefined;
            toolUseId = typeof meta.toolUseId === 'string' ? meta.toolUseId : undefined;
            spawnDepth = typeof meta.spawnDepth === 'number' ? meta.spawnDepth : undefined;
          } catch {
            // ignore malformed meta
          }
        }

        subagents.push({
          agentId,
          prompt,
          model: session.model,
          agentType,
          description,
          parentAgentId,
          toolUseId,
          spawnDepth,
          startTime: session.startTime,
          endTime: session.endTime,
          durationMs: session.durationMs,
          filesRead: session.filesRead,
          filesWritten: session.filesWritten,
          toolsUsed: session.toolsUsed,
          // What the agent did, so harness events are left out — this is the
          // number the "N agent steps" toggle shows next to the spawning Task.
          stepCount: session.steps.filter(step => !isSystemStep(step)).length,
          totalCost: session.totalCost,
          steps: session.steps,
        });
      }
    } catch (err) {
      console.error('Error parsing subagents:', err);
    }

    return subagents;
  }

  /**
   * Link every sub-agent to the step that spawned it via `parentStepIndex`
   * (plus `parentAgentId` when the spawner is another agent rather than the
   * main session).
   *
   * Two sources, in order of reliability:
   *  1. `meta.json`'s `toolUseId` — matches the `tool_use` block id and works
   *     at any nesting depth. Nested spawns have no `toolUseResult.agentId`
   *     in the parent transcript at all, so this is the only way to place them.
   *  2. `toolUseResult.agentId` echoed by the main session's Task step — the
   *     fallback for older sessions written without meta.json. Claude Code has
   *     used both "Task" and "Agent" as the tool name for the same primitive.
   */
  linkSubagentsToParents(steps: Step[], subagents: SubagentInfo[]): void {
    if (subagents.length === 0) return;
    const byId = new Map<string, SubagentInfo>();
    for (const s of subagents) byId.set(s.agentId, s);

    for (const sub of subagents) {
      if (!sub.toolUseId) continue;
      const parentSteps = sub.parentAgentId ? byId.get(sub.parentAgentId)?.steps : steps;
      const spawner = parentSteps?.find(st => st.toolUseId === sub.toolUseId);
      if (spawner) sub.parentStepIndex = spawner.index;
    }

    for (const step of steps) {
      if (step.toolName !== 'Task' && step.toolName !== 'Agent') continue;
      if (!step.toolResult) continue;
      try {
        const result = JSON.parse(step.toolResult);
        const agentId = result?.agentId;
        if (typeof agentId !== 'string') continue;
        const sub = byId.get(agentId);
        if (sub && typeof sub.parentStepIndex !== 'number') sub.parentStepIndex = step.index;
      } catch {
        // ignore unparseable results
      }
    }
  }

  // Helper methods

  /**
   * Headline text of a user turn: what the person typed, with the harness's
   * injected wrappers stripped. Turns that are nothing but an
   * `<ide_opened_file>` notice or a compaction caveat return '', so the caller
   * keeps looking and does not label a session with an IDE event.
   */
  private extractPromptFromEvent(event: any): string {
    try {
      if (!event.message?.content || event.isMeta || event.isCompactSummary) {
        return '';
      }

      const input = this.extractUserInput(event.message.content);
      return input ? this.truncatePrompt(input, 200) : '';
    } catch {
      // ignore
    }

    return '';
  }

  /**
   * The typed part of a user turn: every text block, minus the injected ones,
   * joined in order. A turn is often split across blocks — an
   * `<ide_opened_file>` wrapper followed by the actual message — so taking the
   * first block alone would miss the message entirely.
   */
  private extractUserInput(content: any): string {
    const texts: string[] =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content)
          ? content
              .filter(block => block?.type === 'text' && typeof block.text === 'string')
              .map(block => block.text)
          : [];

    return texts
      .map(text => this.cleanUserText(text))
      .filter(text => text !== '')
      .join('\n\n');
  }

  /**
   * Strip injected wrappers and unwrap a slash command. The wrappers are cut
   * wherever they sit, not just when they make up the whole block — the IDE
   * ones are frequently glued to the front of the message itself.
   */
  private cleanUserText(text: string): string {
    const stripped = text.replace(INJECTED_BLOCK_RE, '').trim();

    const name = stripped.match(COMMAND_NAME_RE);
    if (name) {
      const args = stripped.match(COMMAND_ARGS_RE);
      return [name[1].trim(), args?.[1].trim()].filter(Boolean).join(' ');
    }

    return stripped;
  }

  /**
   * Whole text of a message body, untruncated. Compaction summaries arrive as
   * a plain string, but the block-array shape is handled too so the step keeps
   * its content if the format changes.
   */
  private extractTextContent(content: any): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n');
    }
    return '';
  }

  /**
   * Final `usage` of every assistant message, keyed by message id.
   *
   * A response is spread over one event per content block, and `output_tokens`
   * grows across them as the response streams — 4, 4, 330 for one message is a
   * real sequence from a transcript. Only the last event carries the complete
   * count, so it is the one that must be priced; the earlier ones are
   * snapshots taken mid-stream. Input and cache counts are settled before the
   * first block and repeat unchanged, so taking the whole last object rather
   * than merging field by field loses nothing.
   *
   * Requires a pass of its own because the last event of a message is only
   * knowable after the walk has passed it.
   */
  private findFinalUsage(events: RawEvent[]): Map<string, any> {
    const final = new Map<string, any>();

    for (const event of events) {
      if (event.type !== 'assistant' || !event.message?.usage) {
        continue;
      }
      const id = event.message.id ?? '';
      if (id === '') {
        continue;
      }
      final.set(id, event.message.usage);
    }

    return final;
  }

  /**
   * Ids of assistant messages none of whose content blocks becomes a step.
   * Requires a pass of its own because a message is spread over several
   * events, so whether any of them renders is only knowable up front.
   */
  private findBlankMessages(events: RawEvent[]): Set<string> {
    const seen = new Set<string>();
    const renders = new Set<string>();

    for (const event of events) {
      if (event.type !== 'assistant' || !event.message) {
        continue;
      }
      const id = event.message.id ?? '';
      if (id === '') {
        continue;
      }
      seen.add(id);

      const content = Array.isArray(event.message.content) ? event.message.content : [];
      const rendersHere = content.some(
        (block: any) =>
          (block?.type === 'thinking' && block.thinking) ||
          (block?.type === 'text' && block.text) ||
          (block?.type === 'tool_use' && block.name)
      );
      if (rendersHere) {
        renders.add(id);
      }
    }

    for (const id of renders) {
      seen.delete(id);
    }
    return seen;
  }

  private truncatePrompt(text: string, maxLen: number): string {
    if (text.length <= maxLen) {
      return text;
    }
    return text.substring(0, maxLen) + '...';
  }

}
