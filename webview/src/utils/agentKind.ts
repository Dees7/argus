import { Subagent } from '../types/session';

/**
 * What kind of agent a row belongs to, as its badge reads. Agents a `Workflow`
 * script ran all share the type `workflow-subagent`, which says nothing; they
 * are labelled as workflow agents instead.
 */
export const agentKindLabel = (sub: Subagent): string =>
  sub.workflow ? 'workflow' : sub.agentType || 'agent';

/**
 * Badge text that tells one agent from its siblings where it can: a workflow
 * agent carries the label its script gave it (`gen 001`).
 */
export const agentBadgeLabel = (sub: Subagent): string =>
  sub.workflow && sub.description ? `workflow: ${sub.description}` : agentKindLabel(sub);

/** Transcript path of the agent, relative to `<session>/subagents/`. */
export const agentFileName = (sub: Pick<Subagent, 'agentId' | 'workflow'>): string =>
  sub.workflow
    ? `workflows/${sub.workflow.runId}/agent-${sub.agentId}.jsonl`
    : `agent-${sub.agentId}.jsonl`;

/** Hover text for a workflow agent: which run and phase it belonged to. */
export const workflowTitle = (sub: Subagent): string | undefined =>
  sub.workflow
    ? [
        sub.description,
        sub.workflow.phase && `phase ${sub.workflow.phase}`,
        `run ${sub.workflow.runId}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined;
