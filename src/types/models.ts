import type { CostUsage } from './pricing';

// Filter & grouping types

export const GROUP_MODES = ['none', 'project', 'model', 'date'] as const;
export type GroupMode = (typeof GROUP_MODES)[number];
export type DatePreset = 'all' | '1h' | '3h' | '6h' | '24h' | '7d' | '30d' | 'custom';

export interface FilterState {
  searchQuery: string;
  /**
   * Match the query against full transcript contents instead of just the
   * session title, project and id. Session-scoped only — never persisted.
   */
  searchAllContent: boolean;
  selectedModels: string[];
  datePreset: DatePreset;
  customDateFrom?: number;
  customDateTo?: number;
  /**
   * How the list is split into headings. Persisted in the extension's global
   * state, so the choice follows the user across windows and workspaces.
   */
  groupMode: GroupMode;
  /**
   * Keep only sessions whose working directory belongs to a folder of the
   * open workspace. Persisted in the extension's global state, so the choice
   * follows the user across windows and workspaces.
   */
  onlyCurrentProject: boolean;
}

export const DEFAULT_FILTER_STATE: FilterState = {
  searchQuery: '',
  searchAllContent: false,
  selectedModels: [],
  datePreset: 'all',
  groupMode: 'none',
  onlyCurrentProject: false,
};

// Core data models ported from Go

export interface HistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
}

export interface SessionSummary {
  sessionId: string;
  prompt: string;
  /**
   * Title Claude Code generated for the session. Absent for sessions it never
   * titled — VSCode/SDK entrypoints among them — where `prompt` is all we have.
   */
  aiTitle?: string;
  /**
   * Title the user renamed the session to in Claude Code. Takes precedence over
   * `aiTitle`: it is the name a person chose, over a name a model guessed.
   */
  customTitle?: string;
  project: string;
  /**
   * Absolute working directory the session ran in, when it can be recovered
   * from history or the transcript. Empty when only the display name is known.
   */
  projectPath: string;
  model: string;
  timestamp: Date;
  lastModified: Date;
  isActive: boolean;
}

export interface DashboardStats {
  totalSessions: number;
  activeSessions: number;
  totalCost: number;
  costByModel: Record<string, number>;
  costByProject: Record<string, number>;
  modelUsage: Record<string, number>;
  recentSessions: SessionSummary[];
}

export interface SessionDetail {
  sessionId: string;
  prompt: string;
  /** See `SessionSummary.aiTitle`. */
  aiTitle?: string;
  /** See `SessionSummary.customTitle`. */
  customTitle?: string;
  project: string;
  model: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  totalCost: number;
  steps: Step[];
  subagents: SubagentInfo[];
  filesRead: string[];
  filesWritten: string[];
  toolsUsed: Record<string, number>;
  analysis?: AnalysisResult;
}

export type StepType =
  | 'thinking'
  | 'tool_call'
  | 'text'
  | 'error'
  | 'subagent'
  | 'compact'
  | 'user'
  // An event that carries a blob and nothing the timeline renders — a queued
  // paste, an unrecognised message shape. The step exists to keep the
  // attachment reachable.
  | 'attachment'
  // Something the harness did rather than the model: a hook that blocked a
  // call, a request that had to be retried, and — as they get parsed — model
  // fallbacks and the rest. See `SystemStepKind`.
  | 'system';

/**
 * Which harness event a `system` step stands for. Each kind is hidden until the
 * user turns it on from its own button in the session header, so a timeline
 * stays a record of what the model did unless asked otherwise. Adding a kind
 * means a branch in the parser and an entry in the webview's registry
 * (`webview/src/components/systemSteps.tsx`) — nothing else.
 */
export type SystemStepKind =
  | 'hook_blocking_error'
  | 'hook_non_blocking_error'
  | 'api_error'
  | 'local_command'
  | 'stop_hook_summary';

/**
 * A binary blob a transcript carries inline — a pasted screenshot, an image a
 * tool returned, anything else stored as a base64 `image`/`document` block.
 *
 * Only the description travels to the webview; the bytes stay on disk until
 * the user opens the badge, because a single screenshot is ~200 KB of base64
 * and a browser-driving session can hold dozens.
 */
export interface Attachment {
  /**
   * Locator, not a hash: `<event uuid>#<block path>`, where the path indexes
   * into `message.content` and, for a blob inside a tool result, into that
   * block's own `content` (`"3.1"`). Re-resolved against the file on demand.
   */
  id: string;
  /** Images can be previewed inline; everything else can only be saved. */
  kind: 'image' | 'file';
  mediaType: string;
  /** Decoded size, derived from the base64 length. */
  size: number;
  /** Suggested file name, used for the save dialog and the temp file. */
  name: string;
}

/**
 * Who let a tool call run, or stopped it — set on a `tool_call` step only when
 * the transcript actually says. It is silent far more often than not: a call
 * that simply went ahead carries nothing, because a person clicking "allow", an
 * allow-rule in settings and the auto-mode classifier are indistinguishable
 * once the call has run. Only two things are on the record — a refusal
 * (`toolDenialKind`, which names its source) and a `PreToolUse` hook that
 * decided out loud.
 */
export interface StepPermission {
  outcome: 'allowed' | 'denied';
  /**
   * `unknown` is for pre-2.1.198 transcripts, which recorded that a call was
   * refused but not by what.
   */
  decidedBy: 'user' | 'rule' | 'automode' | 'hook' | 'unknown';
  /** One line for the UI — "Denied by user", "Allowed by hook". */
  label: string;
  /** What the decider said: a hook's reason, or the one a person typed. */
  reason?: string;
  /** `PreToolUse:Bash`, when a hook decided. */
  hookName?: string;
}

export interface Step {
  index: number;
  type: StepType;
  timestamp: Date;
  uuid: string;
  messageId: string;
  content: string;
  /** Blobs carried by this step's message — see `Attachment`. */
  attachments?: Attachment[];
  toolName?: string;
  toolInput?: any;
  toolResult?: string;
  toolSuccess?: boolean;
  toolUseId?: string;
  /** Who allowed or refused this call, when the transcript says — see `StepPermission`. */
  permission?: StepPermission;
  /** Set on `system` steps only — which harness event this one stands for. */
  systemKind?: SystemStepKind;
  /**
   * Set on `system` steps only — whether this one records something going
   * wrong. A hook running is not an event: the timeline paints an `error` red
   * and leaves a `notice` in the neutral grey it deserves, so a red row in a
   * session means a red row worth reading. Not a property of the kind — the
   * stop hooks are a `notice` on most turns and an `error` on the turn one of
   * them fell over.
   */
  systemSeverity?: 'error' | 'notice';
  /**
   * Where a `system` step came from, shown ahead of its text in the row: the
   * hook's name for a blocked call (`PostToolUse:Bash`), and whatever names the
   * source for the kinds added later.
   */
  systemSource?: string;
  usage?: Usage;
  // Cost of the API response this step came from, charged once per message:
  // the first step of a message carries it, its siblings carry 0. Summing
  // `cost` over all steps therefore yields the session total without
  // double-counting.
  cost: number;
  // Set when `cost` was derived from fallback pricing (unrecognised model id).
  costIsEstimate?: boolean;
  model?: string;
  agentId?: string;
  globalIndex?: number;
}

export interface Usage extends CostUsage {
  // How many of the billed output tokens the model spent on internal
  // reasoning. A breakdown of `output_tokens`, never an addition to it —
  // always <= output_tokens — so it stays out of `CostUsage` and out of every
  // cost calculation. Absent on transcripts written before the field existed,
  // and on messages that did no thinking.
  output_tokens_details?: {
    thinking_tokens?: number;
  };
}

export interface SubagentInfo {
  agentId: string;
  prompt: string;
  model: string;
  agentType?: string;
  description?: string;
  // Agents can spawn agents. `parentAgentId` is undefined for agents launched
  // from the main session; otherwise `parentStepIndex` refers to a step inside
  // that parent agent's own transcript.
  parentAgentId?: string;
  parentStepIndex?: number;
  toolUseId?: string;
  spawnDepth?: number;
  startTime?: Date;
  endTime?: Date;
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
 * A step that records a harness event rather than an action the model took.
 * Everything that measures the session — the analysis rules, cost, context and
 * performance — works on the list without them: they are billed to nobody, and
 * a synthetic row sitting between two real ones would split the gap that gives
 * a step its duration.
 */
export function isSystemStep(step: Step): boolean {
  return step.type === 'system';
}

/**
 * Build a single chronological step list combining the main session and any
 * sub-agents. Each agent's steps are inserted right after the Task tool_use
 * that spawned them. `globalIndex` is assigned in iteration order so callers
 * have a stable, unique identifier for navigation/highlighting.
 */
export function flattenSessionSteps(session: SessionDetail): Step[] {
  const spawnedAt = new Map<string, SubagentInfo[]>();
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

  // Emitting is recursive: an agent's own steps can themselves spawn agents,
  // so each nested run is inlined right after the Task step that started it.
  // `emitted` doubles as a cycle guard against malformed parent links.
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

  // Orphan agents (no resolvable parent step) — append at the tail so they
  // remain visible rather than disappearing entirely. Unparented ones go
  // first so any of their own children stay nested under them.
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
  efficiency: number; // percentage
  stepCosts: StepCost[];
  dependencies?: StepDependency[];
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

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  rule: string;
  severity: Severity;
  title: string;
  description: string;
  steps: number[];
  wastedCost: number;
  details?: any;
  confidence?: number;
  category?: string;
  // Set by rules that are about one specific tool, so the UI can show it as a
  // badge instead of relying on the tool name being buried in `description`.
  toolName?: string;
}

export interface StepDependency {
  fromStep: number;
  toStep: number;
  filePath: string;
  type: string;
}

export interface StepCost {
  stepIndex: number;
  cost: number;
}

// Pricing lives in its own dependency-free module so the webview can import
// the same implementation instead of keeping a second copy.
export {
  MODEL_PRICES,
  CACHE_READ_RATIO,
  CACHE_WRITE_5M_RATIO,
  CACHE_WRITE_1H_RATIO,
  getModelPricing,
  calculateCost,
  calculateCostBreakdown,
} from './pricing';
export type { ModelPricing, ResolvedPricing, CostBreakdown } from './pricing';
