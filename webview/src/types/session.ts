export interface SessionDetail {
  sessionId: string;
  prompt: string;
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

export interface Step {
  index: number;
  type: string;
  toolName?: string;
  toolInput?: any;
  toolResult?: string;
  toolSuccess?: boolean;
  toolUseId?: string;
  content?: string;
  timestamp?: string;
  cost: number;
  usage?: TokenUsage;
  agentId?: string;
  globalIndex?: number;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
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

export interface Finding {
  rule?: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  description: string;
  wastedCost?: number;
  toolName?: string;
  // The analyzer emits `steps`; older/derived shapes use `affectedSteps`.
  steps?: number[];
  affectedSteps?: number[];
}

export type ViewMode = 'overview' | 'steps' | 'findings' | 'files' | 'subagents' | 'cost' | 'context';
