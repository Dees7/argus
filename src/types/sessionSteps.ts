// Flattening main + sub-agent steps into one chronological list, shared by
// the extension host and the webview — same reasoning as pricing.ts/usage.ts:
// dependency-free and structural, so neither side's `Step`/`SessionDetail`
// (which genuinely differ — Date vs the string it becomes after postMessage)
// has to be imported here.

interface FlattenStep {
  index: number;
  type: string;
  uuid?: string;
  toolUseId?: string;
  agentId?: string;
  globalIndex?: number;
  stepId?: string;
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
 * have a unique number for navigation/highlighting — but it shifts whenever a
 * running agent inserts steps above. `stepId` is the one that doesn't: it
 * names the transcript event the step came from, so state kept per step (what
 * the user has expanded) stays on its step while a live session grows.
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
  const seen = new Map<string, number>();
  const push = (s: TStep, agentId?: string) => {
    const owner = agentId ?? s.agentId ?? '';
    // One event can yield several steps of the same kind (two text blocks);
    // they arrive together and only ever get appended to, so a running count
    // tells them apart the same way on every rebuild.
    let stepId = `${owner}:${s.index}`;
    if (s.uuid) {
      const base = `${owner}|${s.uuid}|${s.type}|${s.toolUseId ?? ''}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      stepId = n === 0 ? base : `${base}#${n}`;
    }
    out.push({ ...s, agentId: agentId ?? s.agentId, globalIndex: out.length, stepId });
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
