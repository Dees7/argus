import type { CostUsage } from './pricing';

// Filter & grouping types

export type GroupMode = 'none' | 'project' | 'model' | 'date';
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
  | 'user';

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

export interface Usage extends CostUsage {}

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
