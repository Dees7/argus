import { Step } from '../types/session';

/** Every step, main session and every sub-agent alike. */
export const TOTAL_FILTER = 'total';
/** Only the main session's own steps (`step.agentId` unset). */
export const MAIN_FILTER = 'main';

/** Any other value is a `Subagent.agentId` — that agent's steps alone. */
export type AgentFilter = typeof TOTAL_FILTER | typeof MAIN_FILTER | string;

export function filterStepsByAgent(steps: Step[], filter: AgentFilter): Step[] {
  if (filter === TOTAL_FILTER) return steps;
  if (filter === MAIN_FILTER) return steps.filter(s => !s.agentId);
  return steps.filter(s => s.agentId === filter);
}
