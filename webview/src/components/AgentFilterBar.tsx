import { Subagent } from '../types/session';
import { TOTAL_FILTER, MAIN_FILTER, AgentFilter } from '../utils/agentFilter';
import { agentKindLabel } from '../utils/agentKind';
import './AgentFilterBar.css';

interface Props {
  subagents: Subagent[];
  value: AgentFilter;
  onChange: (filter: AgentFilter) => void;
}

// Disambiguates same-typed agents ("explore 1", "explore 2", …) without
// needing anything beyond the order they're already listed in. A workflow
// agent has a label of its own from the script (`gen 001`), which says more.
function agentLabel(sub: Subagent, subagents: Subagent[]): string {
  if (sub.workflow && sub.description) return `workflow: ${sub.description}`;
  const base = agentKindLabel(sub);
  const sameType = subagents.filter(s => agentKindLabel(s) === base);
  return sameType.length > 1 ? `${base} ${sameType.indexOf(sub) + 1}` : base;
}

const AgentFilterBar = ({ subagents, value, onChange }: Props) => {
  if (subagents.length === 0) return null;

  return (
    <div className="agent-filter-bar">
      <button
        className={`agent-filter-btn ${value === TOTAL_FILTER ? 'active' : ''}`}
        onClick={() => onChange(TOTAL_FILTER)}
      >
        Total
      </button>
      <button
        className={`agent-filter-btn ${value === MAIN_FILTER ? 'active' : ''}`}
        onClick={() => onChange(MAIN_FILTER)}
      >
        Main
      </button>
      {subagents.map(sub => (
        <button
          key={sub.agentId}
          className={`agent-filter-btn ${value === sub.agentId ? 'active' : ''}`}
          title={sub.description || sub.prompt}
          onClick={() => onChange(sub.agentId)}
        >
          {agentLabel(sub, subagents)}
        </button>
      ))}
    </div>
  );
};

export default AgentFilterBar;
