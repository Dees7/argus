import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { RawEvent } from '../types/parser';
import {
  HistoryEntry,
  SessionDetail,
  Step,
  SubagentInfo,
  calculateCost,
  getModelPricing,
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
    events: RawEvent[],
    sessionId: string,
    prompt: string,
    project: string
  ): SessionDetail {
    const steps: Step[] = [];
    const filesRead = new Set<string>();
    const filesWritten = new Set<string>();
    const toolsUsed = new Map<string, number>();

    let model = '';
    let startTime = new Date();
    let endTime = new Date();
    let totalCost = 0;

    // Track tool calls and their results
    const toolCallMap = new Map<string, Partial<Step>>();

    // One API response is written as several JSONL events — one per content
    // block — each repeating the same `message.id` and the same `usage`.
    // Charging every event would multiply the bill by the block count, so a
    // message is priced the first time its id is seen and its siblings cost 0.
    const chargedMessages = new Set<string>();
    // Cost priced but not yet attached to a step, keyed by message id.
    const unbilled = new Map<string, number>();
    // Messages that render to nothing. With thinking `display: "omitted"` —
    // the default on current models — a reasoning turn is recorded as a
    // `thinking` block with empty text, so a message can consist solely of
    // blocks that produce no step while still having been billed. Those get a
    // placeholder step rather than dropping the charge off the timeline.
    const blankMessages = this.findBlankMessages(events);

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

      // What the user actually typed. Tool results ride on user events too,
      // so they are filtered out — by `toolUseResult` where it is present, and
      // by the content shape for the sub-agent transcripts that omit it.
      if (event.type === 'user' && !event.isCompactSummary && !event.isMeta && !event.toolUseResult) {
        const content = event.message?.content;
        const isToolResult =
          Array.isArray(content) && content.some((block: any) => block?.type === 'tool_result');

        if (!isToolResult) {
          const text = this.extractUserInput(content);
          if (text) {
            steps.push({
              index: steps.length,
              type: 'user',
              timestamp: new Date(event.timestamp),
              uuid: event.uuid,
              messageId: event.message?.id ?? '',
              content: text,
              cost: 0,
            });
          }
        }
      }

      // Context compaction. Claude Code records it as a user event carrying
      // the hand-off summary that replaces the dropped history — there is no
      // assistant message for it, so give it a step of its own to keep the
      // boundary visible in the timeline.
      if (event.type === 'user' && event.isCompactSummary === true) {
        steps.push({
          index: steps.length,
          type: 'compact',
          timestamp: new Date(event.timestamp),
          uuid: event.uuid,
          messageId: event.message?.id ?? '',
          content: this.extractTextContent(event.message?.content),
          cost: 0,
        });
      }

      // Process assistant messages
      if (event.type === 'assistant' && event.message) {
        const usage = event.message.usage;
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
      }

      // Process tool results. The error flag (`is_error: true`) lives on
      // the tool_result content block inside `event.message.content`, not
      // on `event.toolUseResult` (which is often just a string preview of
      // the result body). Resolve the source-tool's UUID against the
      // tool_result blocks to find the matching one. Fall back to a
      // string-prefix check on `toolUseResult` for older session formats
      // that stored the result as a plain "Error: ..." string.
      if (event.type === 'user' && event.toolUseResult && event.sourceToolAssistantUUID) {
        const toolStep = toolCallMap.get(event.sourceToolAssistantUUID);
        if (toolStep && typeof toolStep.index === 'number') {
          const result = event.toolUseResult;
          steps[toolStep.index].toolResult = JSON.stringify(result);

          let isError = false;
          const blocks = event.message?.content;
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b && b.type === 'tool_result' && b.is_error === true) {
                isError = true;
                break;
              }
            }
          }
          if (!isError && typeof result === 'object' && result !== null && (result as any).is_error === true) {
            isError = true;
          }
          if (!isError && typeof result === 'string' && /^error\b/i.test(result.trim())) {
            isError = true;
          }
          steps[toolStep.index].toolSuccess = !isError;
        }
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
   * Resolve the directory Claude Code writes sub-agent JSONLs into for a given
   * session. Layout is `<projectDir>/<sessionId>/subagents/`.
   */
  getSubagentsDir(projectDir: string, sessionId: string): string {
    return path.join(projectDir, sessionId, 'subagents');
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
          stepCount: session.steps.length,
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
