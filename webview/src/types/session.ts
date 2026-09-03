export interface SessionDetail {
  sessionId: string;
  prompt: string;
  /**
   * Title Claude Code generated for the session. Absent for sessions it never
   * titled, where `prompt` is all we have.
   */
  aiTitle?: string;
  /**
   * Title the user renamed the session to in Claude Code. Wins over `aiTitle`:
   * a name a person chose beats a name a model guessed.
   */
  customTitle?: string;
  /**
   * The user archived this session in Claude Code. Argus shows it either way;
   * the header just says so.
   */
  isArchived?: boolean;
  project: string;
  model: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  totalCost: number;
  steps: Step[];
  subagents: Subagent[];
  filesRead: string[];
  filesWritten: string[];
  toolsUsed: Record<string, number>;
  analysis?: AnalysisResult;
}

/**
 * A blob stored inline in the transcript — a pasted screenshot, an image a
 * tool returned, any other base64 block. Only this description reaches the
 * webview; the bytes are fetched from the host when a badge is opened.
 */
export interface Attachment {
  /** Locator back into the transcript: `<event uuid>#<block path>`. */
  id: string;
  kind: 'image' | 'file';
  mediaType: string;
  /** Decoded size in bytes. */
  size: number;
  /** Suggested file name for saving/opening. */
  name: string;
}

/**
 * Who allowed or refused a tool call. Set only where the transcript says so —
 * a refusal (which names its source since CLI 2.1.198) or a `PreToolUse` hook
 * that decided out loud. A call that simply ran carries nothing: a person
 * clicking "allow", an allow-rule and the auto-mode classifier all look the
 * same afterwards, so the UI says nothing rather than guessing.
 */
export interface StepPermission {
  outcome: 'allowed' | 'denied';
  /** `unknown` — an older transcript that recorded the refusal but not its source. */
  decidedBy: 'user' | 'rule' | 'automode' | 'hook' | 'unknown';
  label: string;
  reason?: string;
  hookName?: string;
}

export interface Step {
  index: number;
  type: string;
  attachments?: Attachment[];
  // Identifies the API response a step came from; several steps share one.
  messageId?: string;
  toolName?: string;
  toolInput?: any;
  toolResult?: string;
  toolSuccess?: boolean;
  toolUseId?: string;
  // Who let this call run, or stopped it. Absent on most calls: only a refusal
  // and a `PreToolUse` hook's verdict are on the record — see `StepPermission`.
  permission?: StepPermission;
  // Set on steps of type `system` — which harness event the step stands for,
  // and where it came from (a hook's name, …). See `components/systemSteps`.
  systemKind?: string;
  systemSource?: string;
  // Set on steps of type `system` — whether the event was something going
  // wrong (`error`, painted red) or merely something that happened
  // (`notice`, painted neutral). Absent on kinds parsed before it existed.
  systemSeverity?: 'error' | 'notice';
  content?: string;
  timestamp?: string;
  // Charged once per API response: the first step of a message carries the
  // whole cost, its siblings carry 0. Sum over steps = session total.
  cost: number;
  // Cost came from fallback pricing because the model id was not recognised.
  costIsEstimate?: boolean;
  model?: string;
  usage?: TokenUsage;
  agentId?: string;
  globalIndex?: number;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  // Part of `output_tokens`, not extra on top of it: the reasoning tokens are
  // already billed in the output count. Missing on older transcripts.
  output_tokens_details?: {
    thinking_tokens?: number;
  };
  speed?: string;
}

export interface Subagent {
  agentId: string;
  prompt: string;
  model: string;
  agentType?: string;
  description?: string;
  // Undefined for agents launched from the main session; otherwise
  // `parentStepIndex` points into that parent agent's own step list.
  parentAgentId?: string;
  parentStepIndex?: number;
  toolUseId?: string;
  spawnDepth?: number;
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  filesRead?: string[];
  filesWritten?: string[];
  toolsUsed?: Record<string, number>;
  stepCount: number;
  totalCost: number;
  steps: Step[];
  analysis?: AnalysisResult;
}

/**
 * A step that records something the harness did — a hook that blocked a call,
 * and the other kinds as they get parsed — rather than an action the model
 * took. They are hidden until their button in the session header is pressed,
 * and every tab that measures the session leaves them out.
 */
export function isSystemStep(step: Step): boolean {
  return step.type === 'system';
}

/**
 * Build a chronologically interleaved list of main + sub-agent steps. Each
 * agent's steps follow the Task step that spawned them, and every step gets a
 * stable `globalIndex` for cross-tab navigation.
 */
export function flattenSessionSteps(session: SessionDetail): Step[] {
  const spawnedAt = new Map<string, Subagent[]>();
  for (const sub of session.subagents) {
    if (typeof sub.parentStepIndex === 'number') {
      const k = spawnKey(sub.parentAgentId, sub.parentStepIndex);
      const arr = spawnedAt.get(k) ?? [];
      arr.push(sub);
      spawnedAt.set(k, arr);
    }
  }

  const out: Step[] = [];
  const push = (s: Step, agentId?: string) => {
    out.push({ ...s, agentId: agentId ?? s.agentId, globalIndex: out.length });
  };

  // Recursive: an agent's steps can spawn further agents, each inlined right
  // after its own Task step. `emitted` also guards against parent-link cycles.
  const emitted = new Set<string>();
  const emit = (steps: Step[], agentId?: string) => {
    for (const s of steps) {
      push(s, agentId);
      const children = spawnedAt.get(spawnKey(agentId, s.index));
      if (!children) continue;
      for (const child of children) {
        if (emitted.has(child.agentId)) continue;
        emitted.add(child.agentId);
        emit(child.steps, child.agentId);
      }
    }
  };
  emit(session.steps);

  // Agents whose spawning step couldn't be resolved go to the tail rather than
  // disappearing; unparented ones first so their children nest under them.
  for (const sub of session.subagents) {
    if (emitted.has(sub.agentId) || typeof sub.parentStepIndex === 'number') continue;
    emitted.add(sub.agentId);
    emit(sub.steps, sub.agentId);
  }
  for (const sub of session.subagents) {
    if (emitted.has(sub.agentId)) continue;
    emitted.add(sub.agentId);
    emit(sub.steps, sub.agentId);
  }
  return out;
}

/** Key for "agents spawned by step N of agent X" (X empty = main session). */
export function spawnKey(agentId: string | undefined, stepIndex: number): string {
  return `${agentId ?? ''}:${stepIndex}`;
}

export interface AnalysisResult {
  findings: Finding[];
  totalCost: number;
  wastedCost: number;
  efficiency: number;
  contextMetrics?: ContextMetrics;
}

export interface ContextMetrics {
  peakInputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  cacheHitRatio: number;
  compactionCount: number;
  avgTokensPerStep: number;
  tokenBurnRate: number;
  contextPressureZones: number[];
  compactionPoints: number[];
}

/**
 * The number a step is shown and navigated by across tabs: its `globalIndex`,
 * falling back to the local index for steps that never went through
 * `flattenSessionSteps`. Anything that renders "#N" or calls `onGoToStep` has
 * to agree on this, or the highlight lands on the wrong row.
 */
export const stepKey = (step: Step): number => step.globalIndex ?? step.index;

export interface Finding {
  rule?: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  description: string;
  wastedCost?: number;
  toolName?: string;
  // Local step indices within the session the finding was analyzed against —
  // resolve them to `globalIndex` before navigating.
  steps?: number[];
}

export type ViewMode = 'overview' | 'steps' | 'findings' | 'files' | 'subagents' | 'cost' | 'context';
