// Flattening main + sub-agent steps into one chronological list, shared by
// the extension host and the webview — same reasoning as pricing.ts/usage.ts:
// dependency-free and structural, so neither side's `Step`/`SessionDetail`
// (which genuinely differ — Date vs the string it becomes after postMessage)
// has to be imported here.

interface FlattenStep {
  index: number;
  agentId?: string;
  globalIndex?: number;
}

interface FlattenSubagent<TStep> {
  agentId: string;
  parentAgentId?: string;
  parentStepIndex?: number;
  steps: TStep[];
}

interface FlattenSession<TStep, TSub> {
  steps: TStep[];
  subagents: TSub[];
}

/**
 * A step that records a harness event rather than an action the model took.
 * Everything that measures the session — the analysis rules, cost, context and
 * performance — works on the list without them: they are billed to nobody, and
 * a synthetic row sitting between two real ones would split the gap that gives
 * a step its duration.
 */
export function isSystemStep(step: { type: string }): boolean {
  return step.type === 'system';
}

/** Key for "agents spawned by step N of agent X" (X empty = main session). */
export function spawnKey(agentId: string | undefined, stepIndex: number): string {
  return `${agentId ?? ''}:${stepIndex}`;
}

/**
 * Build a single chronological step list combining the main session and any
 * sub-agents. Each agent's steps are inserted right after the Task tool_use
 * that spawned them. `globalIndex` is assigned in iteration order so callers
 * have a stable, unique identifier for navigation/highlighting.
 */
export function flattenSessionSteps<TStep extends FlattenStep, TSub extends FlattenSubagent<TStep>>(
  session: FlattenSession<TStep, TSub>
): TStep[] {
  const spawnedAt = new Map<string, TSub[]>();
  for (const sub of session.subagents) {
    if (typeof sub.parentStepIndex === 'number') {
      const k = spawnKey(sub.parentAgentId, sub.parentStepIndex);
      const arr = spawnedAt.get(k) ?? [];
      arr.push(sub);
      spawnedAt.set(k, arr);
    }
  }

  const out: TStep[] = [];
  const push = (s: TStep, agentId?: string) => {
    out.push({ ...s, agentId: agentId ?? s.agentId, globalIndex: out.length });
  };

  // Emitting is recursive: an agent's own steps can themselves spawn agents,
  // so each nested run is inlined right after the Task step that started it.
  // `emitted` doubles as a cycle guard against malformed parent links.
  const emitted = new Set<string>();
  const emit = (steps: TStep[], agentId?: string) => {
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
