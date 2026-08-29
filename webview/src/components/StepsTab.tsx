import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Step, Subagent, Finding, TokenUsage, spawnKey } from '../types/session';
import ToolRenderer from './ToolRenderer';
import ContentRenderer from './ContentRenderer';
import Attachments from './Attachments';
import RendererErrorBoundary from './RendererErrorBoundary';
import { isSystemFailure, systemKindInfo } from './systemSteps';
import { computeStepDurations } from '../utils/stepDurations';
import { stripAnsi } from '../utils/ansi';
import { askUserQuestionSummary, parseAskUserQuestion } from './askUserQuestion';
import './StepsTab.css';

interface Props {
  steps: Step[];
  // Every step the transcript produced, including the harness events the header
  // buttons are currently hiding. Only durations read this: a gap is a fact
  // about the session, not about what is on screen, so it must not grow when a
  // button folds the step that filled it away. Optional — callers without it
  // fall back to measuring what they render.
  allSteps?: Step[];
  subagents: Subagent[];
  findings: Finding[];
  highlightStep: number | null;
  // Sort order from settings (argus.steps.sortOrder); also what "Clear
  // filters" resets to. Defaults to 'newest' for callers without a config.
  defaultSortMode?: string;
  // Patterns from settings (argus.steps.autoExpand) — steps whose tool name or
  // type matches start expanded instead of collapsed.
  autoExpand?: string[];
  // Fold the search/filter bar away (the header's search toggle). The filters
  // themselves keep their values, so a hidden bar can still be narrowing the
  // list — the "13/55" tab label is what gives that away.
  hideControls?: boolean;
  // How many steps survive the current search/filters, reported up so the tab
  // header can show "Steps (13/55)". null while the tab is unmounted.
  onFilteredCountChange?: (count: number | null) => void;
  // Unfold the search/filter bar. A cost link puts a message id in the search
  // box, and a query the user cannot see or clear is worse than no filter at
  // all — so the bar comes back on its own when that happens.
  onRevealControls?: () => void;
}

/* ── SVG icons ── */
const SearchIcon = () => (
  <svg className="steps-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z" />
  </svg>
);

/* Stacked plates for the cost links: one API response, several blocks. Three
   horizontal slabs rather than an arrow or a funnel — both of those are
   triangles at this size and blur into the row's own ▶ expander. */
const CostGroupIcon = () => (
  <svg className="step-cost-group-icon" width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M5 1h10l-4 3.2H1z" />
    <path d="M5 6.4h10l-4 3.2H1z" />
    <path d="M5 11.8h10l-4 3.2H1z" />
  </svg>
);

const ChevronIcon = () => (
  <svg className="steps-dropdown-chevron" width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
    <path d="M7.976 10.072l4.357-4.357.619.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" />
  </svg>
);

const CheckIcon = () => (
  <svg className="steps-dropdown-check" viewBox="0 0 16 16" fill="currentColor">
    <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z" />
  </svg>
);

/**
 * What the tool/type dropdown counts and filters on. A tool goes by its name and
 * everything else by its step type — except a harness event, which goes by its
 * kind: the header buttons bring those in one kind at a time, so a single
 * "System" entry would offer to filter on a mixture of things the user never
 * asked to see. The prefix keeps a kind from colliding with a tool of the same
 * name; `filterKeyLabel` turns it back into something readable.
 */
const SYSTEM_FILTER_PREFIX = 'system:';

const filterKeyOf = (step: Step): string =>
  step.toolName ||
  (step.type === 'system' && step.systemKind
    ? `${SYSTEM_FILTER_PREFIX}${step.systemKind}`
    : step.type);

/**
 * A filter key as it is shown. Tool names are already their own label; a
 * `system:<kind>` becomes its header button's wording, capitalised.
 */
const filterKeyLabel = (key: string): string => {
  if (!key.startsWith(SYSTEM_FILTER_PREFIX)) {
    return key;
  }
  const kind = key.slice(SYSTEM_FILTER_PREFIX.length);
  // A kind this build doesn't know still gets a row, spelled out of its own name.
  const text = systemKindInfo(kind)?.plural ?? kind.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/* ── Step icons per tool/type ── */
const stepIconProps = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

const StepIcon = ({ step }: { step: Step }) => {
  // Harness events carry the icon of their kind — the same glyph as the header
  // button that brought them in, so the two read as one thing. Red only where
  // something went wrong; the hooks that merely ran stay neutral.
  const systemInfo = systemKindInfo(step.systemKind);
  if (systemInfo) {
    return (
      <systemInfo.Icon
        className={`step-icon ${isSystemFailure(step) ? 'step-icon-system' : 'step-icon-system-notice'}`}
        size={15}
      />
    );
  }

  const key = step.toolName || step.type;
  switch (key) {
    case 'Read':
      return (
        <svg className="step-icon step-icon-read" {...stepIconProps} stroke="currentColor">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 13H8" /><path d="M16 17H8" /><path d="M16 13h-2" />
        </svg>
      );
    case 'Write':
      return (
        <svg className="step-icon step-icon-write" {...stepIconProps} stroke="currentColor">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M12 18v-6" /><path d="m9 15 3-3 3 3" />
        </svg>
      );
    case 'Edit':
      return (
        <svg className="step-icon step-icon-edit" {...stepIconProps} stroke="currentColor">
          <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
        </svg>
      );
    case 'Bash':
      return (
        <svg className="step-icon step-icon-bash" {...stepIconProps} stroke="currentColor">
          <polyline points="4 17 10 11 4 5" /><line x1="12" x2="20" y1="19" y2="19" />
        </svg>
      );
    case 'Grep':
      return (
        <svg className="step-icon step-icon-grep" {...stepIconProps} stroke="currentColor">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /><path d="M8 11h6" />
        </svg>
      );
    case 'Glob':
      return (
        <svg className="step-icon step-icon-glob" {...stepIconProps} stroke="currentColor">
          <circle cx="17" cy="17" r="3" /><path d="m21 21-1.9-1.9" /><path d="M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1" />
        </svg>
      );
    case 'Agent':
      return (
        <svg className="step-icon step-icon-agent" {...stepIconProps} stroke="currentColor">
          <path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />
        </svg>
      );
    case 'AskUserQuestion':
      // A speech bubble with a tick: the harness asked, the user answered.
      return (
        <svg className="step-icon step-icon-ask" {...stepIconProps} stroke="currentColor">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" /><path d="m9 11.5 2 2 4-4" />
        </svg>
      );
    case 'thinking':
      return (
        <svg className="step-icon step-icon-thinking" {...stepIconProps} stroke="currentColor">
          <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" /><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" /><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" /><path d="M17.599 6.5a3 3 0 0 0 .399-1.375" /><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" /><path d="M3.477 10.896a4 4 0 0 1 .585-.396" /><path d="M19.938 10.5a4 4 0 0 1 .585.396" /><path d="M6 18a4 4 0 0 1-1.967-.516" /><path d="M19.967 17.484A4 4 0 0 1 18 18" />
        </svg>
      );
    case 'text':
      return (
        <svg className="step-icon step-icon-text" {...stepIconProps} stroke="currentColor">
          <path d="M7 10h10" /><path d="M7 14h4" /><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case 'error':
      return (
        <svg className="step-icon step-icon-error" {...stepIconProps} stroke="currentColor">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" />
        </svg>
      );
    case 'user':
      return (
        <svg className="step-icon step-icon-user" {...stepIconProps} stroke="currentColor">
          <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
        </svg>
      );
    case 'attachment':
      // Paperclip: a step that exists only to carry what the message brought.
      return (
        <svg className="step-icon step-icon-attachment" {...stepIconProps} stroke="currentColor">
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      );
    case 'compact':
      // Arrows folding inward — the history collapsing into a summary.
      return (
        <svg className="step-icon step-icon-compact" {...stepIconProps} stroke="currentColor">
          <path d="M4 9h6V3" /><path d="M20 9h-6V3" /><path d="M4 15h6v6" /><path d="M20 15h-6v6" />
        </svg>
      );
    default:
      return (
        <svg className="step-icon step-icon-default" {...stepIconProps} stroke="currentColor">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      );
  }
};

// Dropdown trigger icons
const FilterIcon = () => (
  <svg className="steps-dropdown-trigger-icon" viewBox="0 0 16 16" fill="currentColor">
    <path d="M6 12v-1h4v1H6zM4 8v-1h8v1H4zM2 4v-1h12v1H2z" />
  </svg>
);

const StatusIcon = () => (
  <svg className="steps-dropdown-trigger-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="m9 11 3 3L22 4" />
  </svg>
);

const SortIcon = () => (
  <svg className="steps-dropdown-trigger-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m3 16 4 4 4-4" /><path d="M7 20V4" /><path d="m21 8-4-4-4 4" /><path d="M17 4v16" />
  </svg>
);

/* ── Token usage ── */
// Rendered into the pretty/raw toolbar of whichever renderer the step uses,
// so the counts sit on one line with the controls instead of trailing the
// expanded body.
const StepTokenUsage = ({ usage }: { usage: TokenUsage }) => {
  // Reasoning tokens are a slice of `out`, not a fifth bucket, so they trail
  // it as a sub-item. Shown only when the model actually reasoned: the field
  // is absent on older transcripts and zero on most messages, and "think 0"
  // on every row is noise.
  const thinking = usage.output_tokens_details?.thinking_tokens ?? 0;

  const items: [string, number, string, boolean][] = [
    ['in', usage.input_tokens, 'Input tokens', false],
    ['out', usage.output_tokens, 'Output tokens', false],
    ...(thinking > 0
      ? ([['think', thinking, 'Reasoning tokens — part of the output count, not billed on top of it', true]] as [
        string,
        number,
        string,
        boolean,
      ][])
      : []),
    ['cache r', usage.cache_read_input_tokens, 'Cache read tokens', false],
    ['cache w', usage.cache_creation_input_tokens, 'Cache creation tokens', false],
  ];
  return (
    <span className="step-usage">
      {items.map(([label, value, title, isSub]) => (
        <span
          key={label}
          className={isSub ? 'step-usage-item step-usage-item-sub' : 'step-usage-item'}
          title={title}
        >
          <span className="step-usage-label">{label}</span>
          <span className="step-usage-value">{(value ?? 0).toLocaleString()}</span>
        </span>
      ))}
    </span>
  );
};

/* ── Dropdown component ── */
interface DropdownItem {
  value: string;
  label: string;
  count?: number;
}

interface DropdownProps {
  id: string;
  icon: React.ReactNode;
  label: string;
  items: (DropdownItem | 'separator')[];
  selected: string | Set<string>;
  onSelect: (value: string) => void;
  isActive: boolean;
  multiSelect?: boolean;
  openDropdown: string | null;
  setOpenDropdown: (id: string | null) => void;
}

const Dropdown = ({ id, icon, label, items, selected, onSelect, isActive, multiSelect, openDropdown, setOpenDropdown }: DropdownProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const isOpen = openDropdown === id;

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenDropdown(isOpen ? null : id);
  }, [id, isOpen, setOpenDropdown]);

  const isSelected = (value: string) => {
    if (selected instanceof Set) return selected.has(value);
    return selected === value;
  };

  return (
    <div className={`steps-dropdown${isOpen ? ' open' : ''}`} ref={ref}>
      <button
        className={`steps-dropdown-trigger${isActive ? ' active' : ''}${isOpen ? ' open' : ''}`}
        onClick={toggle}
      >
        {icon}
        <span className="steps-dropdown-trigger-label">{label}</span>
        <ChevronIcon />
      </button>
      {isOpen && (
        <div className="steps-dropdown-menu" onClick={e => e.stopPropagation()}>
          {items.map((item, i) => {
            if (item === 'separator') return <div key={`sep-${i}`} className="steps-dropdown-separator" />;
            return (
              <button
                key={item.value}
                className={`steps-dropdown-item${isSelected(item.value) ? ' selected' : ''}`}
                onClick={() => { onSelect(item.value); if (!multiSelect) setOpenDropdown(null); }}
              >
                <CheckIcon />
                <span className="steps-dropdown-item-label">{item.label}</span>
                {item.count !== undefined && <span className="steps-dropdown-item-count">{item.count}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

/* ── Sort labels ── */
const SORT_LABELS: Record<string, string> = {
  newest: 'Newest',
  oldest: 'Oldest',
  'cost-desc': 'Cost ↓',
  'cost-asc': 'Cost ↑',
};

/* ── auto-expand patterns ── */
// MCP tools arrive as `mcp__server__tool`; collapsing underscore runs lets a
// pattern be written either way (`mcp_chromium*` or `mcp__chromium*`).
const normalizeToolKey = (value: string): string =>
  value.trim().toLowerCase().replace(/_+/g, '_');

// Compiles argus.steps.autoExpand into a single predicate. `*` is the only
// wildcard; everything else is matched literally over the whole name.
const compileAutoExpand = (patterns: string[]): ((key: string) => boolean) => {
  const regexes = patterns
    .map(normalizeToolKey)
    .filter(Boolean)
    .map(p => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, m => (m === '*' ? '.*' : `\\${m}`))}$`));
  if (regexes.length === 0) return () => false;
  return (key: string) => {
    const k = normalizeToolKey(key);
    return regexes.some(re => re.test(k));
  };
};

/* ── Main component ── */
// In a flattened (main + sub-agent) timeline, every step has a unique
// globalIndex. We fall back to the local index for legacy callers that may
// hand us un-flattened arrays.
const keyOf = (step: Step): number => step.globalIndex ?? step.index;

const StepsTab = ({ steps, allSteps, subagents, findings, highlightStep, defaultSortMode = 'newest', autoExpand = [], hideControls = false, onFilteredCountChange, onRevealControls }: Props) => {
  // Steps the user has clicked, i.e. the ones whose state differs from the
  // default that autoExpand gives them. Storing the flips rather than the
  // expanded set means steps appended by a live session pick the setting up
  // on arrival, and a changed setting doesn't strand stale expansions.
  const [toggledSteps, setToggledSteps] = useState<Set<number>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [toolFilter, setToolFilter] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortMode, setSortMode] = useState(defaultSortMode);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(new Set());

  // The settings message normally arrives before the session data, so the
  // state above is already correct. If it lands late, adopt it — unless the
  // user has meanwhile picked a sort order by hand.
  const sortTouched = useRef(false);
  useEffect(() => {
    if (!sortTouched.current) setSortMode(defaultSortMode);
  }, [defaultSortMode]);

  const selectSortMode = useCallback((mode: string) => {
    sortTouched.current = true;
    setSortMode(mode);
  }, []);

  const matchesAutoExpand = useMemo(() => compileAutoExpand(autoExpand), [autoExpand]);

  const isAutoExpanded = useCallback(
    (step: Step) => matchesAutoExpand(step.toolName || step.type),
    [matchesAutoExpand]
  );

  const isStepExpanded = useCallback(
    (step: Step) => isAutoExpanded(step) !== toggledSteps.has(keyOf(step)),
    [isAutoExpanded, toggledSteps]
  );

  // agentId → Subagent for quick lookup
  const subagentById = useMemo(() => {
    const m = new Map<string, Subagent>();
    for (const s of subagents) m.set(s.agentId, s);
    return m;
  }, [subagents]);

  // spawnKey(parentAgentId, local step index) → agents spawned there (for the
  // collapse toggle on Task tool_use rows). Keyed by owning agent too, since a
  // Task row can live inside another agent's transcript.
  const agentsByParent = useMemo(() => {
    const m = new Map<string, Subagent[]>();
    for (const s of subagents) {
      if (typeof s.parentStepIndex !== 'number') continue;
      const k = spawnKey(s.parentAgentId, s.parentStepIndex);
      const arr = m.get(k) ?? [];
      arr.push(s);
      m.set(k, arr);
    }
    return m;
  }, [subagents]);

  // agentId → itself + all ancestors, so collapsing an agent also hides the
  // agents it spawned.
  const agentChain = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of subagents) {
      const chain: string[] = [];
      let cur: Subagent | undefined = s;
      while (cur && !chain.includes(cur.agentId)) {
        chain.push(cur.agentId);
        cur = cur.parentAgentId ? subagentById.get(cur.parentAgentId) : undefined;
      }
      m.set(s.agentId, chain);
    }
    return m;
  }, [subagents, subagentById]);

  const toggleAgent = useCallback((agentId: string) => {
    setCollapsedAgents(prev => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);

  const toggleToolFilter = useCallback((value: string) => {
    setToolFilter(prev => {
      if (value === 'all') return new Set();
      const next = new Set(prev);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    const close = () => setOpenDropdown(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  // Auto-expand highlighted step. If the step belongs to a sub-agent that the
  // user previously collapsed, also reveal it so the highlight isn't filtered
  // out of the rendered list.
  useEffect(() => {
    if (highlightStep !== null) {
      const target = steps.find(s => keyOf(s) === highlightStep);
      // Force the step open: drop the flip if it is auto-expanded already,
      // add one otherwise.
      setToggledSteps(prev => {
        const next = new Set(prev);
        if (target && isAutoExpanded(target)) next.delete(highlightStep);
        else next.add(highlightStep);
        return next;
      });
      if (target?.agentId && collapsedAgents.has(target.agentId)) {
        setCollapsedAgents(prev => {
          const next = new Set(prev);
          next.delete(target.agentId!);
          return next;
        });
      }
      // Align the step's top edge with the top of the scroll area rather than
      // centring it — an expanded step (a compaction summary especially) can be
      // taller than the viewport, and centring would land mid-text.
      setTimeout(() => {
        const element = document.querySelector('.step-item.highlight');
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 100);
    }
  }, [highlightStep, steps, collapsedAgents, isAutoExpanded]);

  const toggleStep = (index: number) => {
    setToggledSteps(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  // Map findings to globalIndex of the matching main-session steps. The
  // analyzer reports findings against local step indices within its session,
  // so we resolve those to the unique globalIndex used for highlighting.
  const stepFindings = useMemo(() => {
    const mainByIndex = new Map<number, number>();
    for (const s of steps) {
      if (!s.agentId) mainByIndex.set(s.index, keyOf(s));
    }
    const map = new Map<number, Finding[]>();
    findings.forEach(f => {
      f.steps?.forEach(idx => {
        const gi = mainByIndex.get(idx);
        if (gi === undefined) return;
        if (!map.has(gi)) map.set(gi, []);
        map.get(gi)!.push(f);
      });
    });
    return map;
  }, [findings, steps]);

  // Where each API response was charged, keyed by message id.
  //
  // The transcript writes one event per content block and the parser bills a
  // response once, on the first step it produced, so every other block of that
  // response carries `cost: 0`. "The price is on the row above" is not a rule
  // that holds: harness events interleave with a response's blocks (on a local
  // corpus of ~13.7k responses, ~0.8% end up split apart), and any sort other
  // than chronological moves the charged row somewhere else entirely.
  //
  // Built over the whole timeline rather than the filtered list, so the charged
  // row stays findable when the view has been narrowed to a single block.
  const billing = useMemo(() => {
    const m = new Map<string, { key: number; cost: number; estimate: boolean; blocks: number }>();
    for (const s of allSteps ?? steps) {
      if (!s.messageId) continue;
      const entry = m.get(s.messageId);
      if (!entry) {
        m.set(s.messageId, {
          key: keyOf(s),
          cost: s.cost,
          estimate: !!s.costIsEstimate,
          blocks: 1,
        });
        continue;
      }
      entry.blocks++;
      // A response has exactly one charged step; the first one seen with a
      // cost wins, so an untaxed block never claims the entry.
      if (entry.cost === 0 && s.cost > 0) {
        entry.key = keyOf(s);
        entry.cost = s.cost;
        entry.estimate = !!s.costIsEstimate;
      }
    }
    return m;
  }, [allSteps, steps]);

  // Narrow the timeline to one API response. The message id goes into the
  // search box rather than into a filter of its own: it is visible, it is
  // cleared the same way every other query is, and nothing new has to be
  // remembered to undo it.
  const showResponse = useCallback((messageId: string) => {
    setSearchQuery(messageId);
    setOpenDropdown(null);
    onRevealControls?.();
  }, [onRevealControls]);

  // Dynamic tool/type counts
  const toolCounts = useMemo(() => {
    const counts = new Map<string, number>();
    steps.forEach(s => {
      const key = filterKeyOf(s);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
  }, [steps]);

  // A filter for something the timeline no longer holds hides every row and
  // says nothing about why — which is exactly what turning a harness kind back
  // off would do while its kind was the selected filter. So a selection lasts
  // only as long as the thing it selects.
  useEffect(() => {
    setToolFilter(prev => {
      const next = new Set([...prev].filter(key => toolCounts.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [toolCounts]);

  // Status counts
  const statusCounts = useMemo(() => {
    let success = 0, failed = 0, issues = 0;
    steps.forEach(s => {
      if (s.toolSuccess === true) success++;
      if (s.toolSuccess === false) failed++;
      if (stepFindings.has(keyOf(s))) issues++;
    });
    return { success, failed, issues };
  }, [steps, stepFindings]);

  // Build tool dropdown items
  const toolItems = useMemo((): (DropdownItem | 'separator')[] => {
    const types: DropdownItem[] = [];
    const tools: DropdownItem[] = [];

    toolCounts.forEach((count, key) => {
      // Only the kinds currently on screen are in `toolCounts`, so a kind
      // appears among the types exactly while its header button is lit.
      if (key.startsWith(SYSTEM_FILTER_PREFIX)) {
        types.push({ value: key, label: filterKeyLabel(key), count });
      } else if (
        key === 'thinking' ||
        key === 'text' ||
        key === 'compact' ||
        key === 'user' ||
        key === 'attachment' ||
        key === 'system'
      ) {
        types.push({ value: key, label: key.charAt(0).toUpperCase() + key.slice(1), count });
      } else {
        tools.push({ value: key, label: key, count });
      }
    });

    // Sort tools alphabetically
    tools.sort((a, b) => a.label.localeCompare(b.label));

    const items: (DropdownItem | 'separator')[] = [
      { value: 'all', label: 'All Steps', count: steps.length },
    ];
    if (types.length > 0) {
      items.push('separator', ...types);
    }
    if (tools.length > 0) {
      items.push('separator', ...tools);
    }
    return items;
  }, [toolCounts, steps.length]);

  // Build status dropdown items
  const statusItems: (DropdownItem | 'separator')[] = useMemo(() => [
    { value: 'all', label: 'All', count: steps.length },
    'separator',
    { value: 'success', label: 'Success', count: statusCounts.success },
    { value: 'failed', label: 'Failed', count: statusCounts.failed },
    { value: 'issues', label: 'Has Issues', count: statusCounts.issues },
  ], [steps.length, statusCounts]);

  // Build sort dropdown items
  const sortItems: (DropdownItem | 'separator')[] = [
    { value: 'newest', label: 'Newest First' },
    { value: 'oldest', label: 'Oldest First' },
    'separator',
    { value: 'cost-desc', label: 'Cost: High → Low' },
    { value: 'cost-asc', label: 'Cost: Low → High' },
  ];

  // Filtered and sorted steps
  const filteredSteps = useMemo(() => {
    let result = [...steps];

    // Text search. The message id is searchable too, which is what turns
    // "msg_011CeTce1p" into "the blocks of one API response" — the cost links
    // put exactly that in the box.
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(s =>
        (s.toolName?.toLowerCase().includes(q)) ||
        (s.content?.toLowerCase().includes(q)) ||
        (s.messageId?.toLowerCase().includes(q)) ||
        (s.toolInput && JSON.stringify(s.toolInput).toLowerCase().includes(q)) ||
        (s.toolResult?.toLowerCase().includes(q))
      );
    }

    // Tool filter (multi-select)
    if (toolFilter.size > 0) {
      result = result.filter(s => toolFilter.has(filterKeyOf(s)));
    }

    // Status filter
    if (statusFilter === 'success') result = result.filter(s => s.toolSuccess === true);
    if (statusFilter === 'failed') result = result.filter(s => s.toolSuccess === false);
    if (statusFilter === 'issues') result = result.filter(s => stepFindings.has(keyOf(s)));

    // Hide steps whose owning agent — or any of its ancestors — is collapsed
    if (collapsedAgents.size > 0) {
      result = result.filter(s => {
        if (!s.agentId) return true;
        const chain = agentChain.get(s.agentId) ?? [s.agentId];
        return !chain.some(id => collapsedAgents.has(id));
      });
    }

    // Sorting — keyOf preserves chronological order for both main and agent
    // steps in the flattened list.
    switch (sortMode) {
      case 'newest': result.sort((a, b) => keyOf(b) - keyOf(a)); break;
      case 'oldest': result.sort((a, b) => keyOf(a) - keyOf(b)); break;
      case 'cost-desc': result.sort((a, b) => b.cost - a.cost); break;
      case 'cost-asc': result.sort((a, b) => a.cost - b.cost); break;
    }

    return result;
  }, [steps, searchQuery, toolFilter, statusFilter, sortMode, stepFindings, collapsedAgents, agentChain]);

  // Publish the filtered count for the tab header. Filters live only as long as
  // this component, so unmounting resets the header back to the plain total.
  useEffect(() => {
    onFilteredCountChange?.(filteredSteps.length);
  }, [filteredSteps.length, onFilteredCountChange]);

  useEffect(() => () => onFilteredCountChange?.(null), [onFilteredCountChange]);

  // How long each step took: the gap to whatever happened next.
  //
  // Measured over every step, hidden ones included, so a row reports the same
  // number whether or not the harness events around it are on screen — and the
  // one it reports is the gap to the next thing that actually happened, not to
  // the next thing being drawn. Rows the tab's own search/filters remove never
  // affected this either; the map is keyed by step, and only the rows that
  // survive ever look themselves up.
  // The gap to the next thing that happened is the whole answer here, pauses
  // for the user included — this row describes the timeline, it does not rank
  // operations, so `dropBeforeUserPrompt` stays off.
  const stepDurations = useMemo(() => {
    const timeline = allSteps ?? steps;
    return computeStepDurations(timeline, timeline, { clampNegative: true });
  }, [allSteps, steps]);

  const formatTime = (timestamp?: string | Date) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    const sec = ms / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const min = Math.floor(sec / 60);
    const rem = Math.round(sec % 60);
    return `${min}m ${rem}s`;
  };

  // Subtitle shown next to the tool name. `mono` marks payload text (paths,
  // patterns, raw commands) so prose descriptions can render in the UI font.
  const getStepSummary = (step: Step): { text: string; mono: boolean } | null => {
    if (step.type === 'compact') {
      return { text: 'context compacted — history replaced by a summary', mono: false };
    }
    // A harness event: which hook (or whatever else names the source) fired,
    // then the first line of what it said.
    if (step.type === 'system') {
      // A slash command's output can be terminal text: its colour codes are
      // invisible here but still push the line around, so they come off. Text
      // without them is returned unchanged.
      const first = stripAnsi(step.content || '')
        .split('\n')
        .find(line => line.trim() !== '')
        ?.trim();
      const text = [step.systemSource, first].filter(Boolean).join(' — ');
      return text ? { text, mono: true } : null;
    }
    // First non-empty line of the prompt/reply, so a turn is recognisable
    // while collapsed.
    if (step.type === 'user' || step.type === 'text' || step.type === 'attachment') {
      const first = stripAnsi(step.content || '')
        .split('\n')
        .find(line => line.trim() !== '');
      if (first) return { text: first.trim(), mono: false };
      // A pasted screenshot with no caption: the row would otherwise read as
      // an empty turn.
      const count = step.attachments?.length ?? 0;
      if (count > 0) {
        return { text: count === 1 ? '1 attachment' : `${count} attachments`, mono: false };
      }
      return null;
    }
    if (!step.toolName || !step.toolInput) return null;

    const input = step.toolInput as any;
    const description =
      typeof input.description === 'string' ? input.description.trim() : '';

    try {
      switch (step.toolName) {
        case 'Read':
        case 'Write':
        case 'Edit':
        case 'MultiEdit':
          return input.file_path ? { text: input.file_path, mono: true } : null;
        case 'Grep':
        case 'Glob':
          return { text: `"${input.pattern}"${input.path ? ` in ${input.path}` : ''}`, mono: true };
        case 'Bash':
          // Claude writes a one-line description for every command it runs; it
          // reads better here than the command, which the expanded body shows
          // verbatim anyway. Commands without one fall back to the text itself.
          return description
            ? { text: description, mono: false }
            : { text: input.command || '', mono: true };
        case 'Task':
        case 'Agent':
          return { text: description || input.prompt || '', mono: false };
        case 'AskUserQuestion': {
          // The question is the least interesting half of this step once it is
          // over — what the user picked is what the row is read for, so the
          // summary leads with the answer and keeps only each question's short
          // header for context.
          let result: unknown;
          try {
            result = step.toolResult ? JSON.parse(step.toolResult) : undefined;
          } catch {
            result = step.toolResult;
          }
          const text = askUserQuestionSummary(parseAskUserQuestion(input, result));
          return text ? { text, mono: false } : null;
        }
        default: {
          if (description) return { text: description, mono: false };
          // Unknown tools — MCP ones above all — carry no description, so fold
          // their scalar arguments into `key=value` pairs. Without this the row
          // would show nothing but the tool name, and a run of MCP calls would
          // be indistinguishable from one another.
          const parts: string[] = [];
          for (const [key, value] of Object.entries(input)) {
            if (typeof value === 'string') {
              const v = value.replace(/\s+/g, ' ').trim();
              if (v) parts.push(`${key}=${v.length > 80 ? `${v.slice(0, 80)}…` : v}`);
            } else if (typeof value === 'number' || typeof value === 'boolean') {
              parts.push(`${key}=${value}`);
            }
            if (parts.length === 3) break;
          }
          return parts.length ? { text: parts.join(' · '), mono: true } : null;
        }
      }
    } catch {
      return null;
    }
  };

  // A tool's key is its name and reads fine on the button; a harness kind's is
  // the key filtering runs on, not what a person calls it.
  const toolLabel =
    toolFilter.size === 0
      ? 'Tool'
      : toolFilter.size === 1
        ? filterKeyLabel([...toolFilter][0])
        : `${toolFilter.size} tools`;
  const statusLabel = statusFilter === 'all' ? 'Status' : statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1);
  const hasActiveFilters = searchQuery !== '' || toolFilter.size > 0 || statusFilter !== 'all' || sortMode !== defaultSortMode;

  const clearAllFilters = () => {
    setSearchQuery('');
    setToolFilter(new Set());
    setStatusFilter('all');
    setSortMode(defaultSortMode);
    setOpenDropdown(null);
  };

  return (
    <div className="steps-tab">
      {!hideControls && (
        <div className="steps-controls">
          <div className="steps-filter-bar" onClick={e => e.stopPropagation()}>
            <SearchIcon />
            <input
              className="steps-search-input"
              type="text"
              placeholder="Search steps..."
              spellCheck={false}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="steps-search-clear" onClick={() => setSearchQuery('')}>×</button>
            )}

            <div className="steps-divider" />
            <Dropdown
              id="tool"
              icon={<FilterIcon />}
              label={toolLabel}
              items={toolItems}
              selected={toolFilter.size === 0 ? 'all' : toolFilter}
              onSelect={toggleToolFilter}
              isActive={toolFilter.size > 0}
              multiSelect
              openDropdown={openDropdown}
              setOpenDropdown={setOpenDropdown}
            />

            <div className="steps-divider" />
            <Dropdown
              id="status"
              icon={<StatusIcon />}
              label={statusLabel}
              items={statusItems}
              selected={statusFilter}
              onSelect={setStatusFilter}
              isActive={statusFilter !== 'all'}
              openDropdown={openDropdown}
              setOpenDropdown={setOpenDropdown}
            />

            <div className="steps-divider" />
            <Dropdown
              id="sort"
              icon={<SortIcon />}
              label={SORT_LABELS[sortMode]}
              items={sortItems}
              selected={sortMode}
              onSelect={selectSortMode}
              isActive={sortMode !== defaultSortMode}
              openDropdown={openDropdown}
              setOpenDropdown={setOpenDropdown}
            />

            {hasActiveFilters && (
              <>
                <div className="steps-divider" />
                <button className="steps-clear-filters" onClick={clearAllFilters} title="Clear all filters">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" />
                  </svg>
                  <span>Clear</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <div className="steps-scroll">
        <div className={`steps-list${sortMode === 'newest' ? ' tree-reversed' : ''}`}>
          {filteredSteps.map((step, i) => {
            const k = keyOf(step);
            const summary = getStepSummary(step);
            const isExpanded = isStepExpanded(step);
            const hasToolBody = !!(step.toolInput || step.toolResult);
            const hasContentBody =
              (step.type === 'text' ||
                step.type === 'thinking' ||
                step.type === 'compact' ||
                step.type === 'user' ||
                step.type === 'system') && !!step.content;
            const systemInfo = systemKindInfo(step.systemKind);
            // Where this step's response was billed, and how many steps that one
            // charge covers. A step of type `user`/`compact`/`system` has no
            // response behind it and gets nothing.
            const billed = step.messageId ? billing.get(step.messageId) : undefined;
            const chargedElsewhere = !!billed && billed.cost > 0 && billed.key !== k;
            const sharedBlocks = billed?.blocks ?? 0;
            const usageNode = step.usage ? <StepTokenUsage usage={step.usage} /> : null;
            const hasIssues = stepFindings.has(k);
            const isHighlighted = highlightStep === k;
            const ownerAgent = step.agentId ? subagentById.get(step.agentId) : undefined;
            // A Task row may itself sit inside an agent transcript, so look the
            // spawned agents up by (owning agent, local step index).
            const linkedAgents =
              step.toolName === 'Task' || step.toolName === 'Agent'
                ? agentsByParent.get(spawnKey(step.agentId, step.index))
                : undefined;
            const allCollapsed = linkedAgents
              ? linkedAgents.every(a => collapsedAgents.has(a.agentId))
              : false;
            // Tree-style connector positioning: the connector is owned by the
            // agent rows themselves — line begins at the first agent step's
            // top edge and terminates at the last with an "└" corner.
            const prev = i > 0 ? filteredSteps[i - 1] : undefined;
            const next = i + 1 < filteredSteps.length ? filteredSteps[i + 1] : undefined;
            const isAgent = !!step.agentId;
            const isFirstAgentInRun =
              isAgent && (!prev || prev.agentId !== step.agentId);
            const isLastAgentInRun =
              isAgent && (!next || next.agentId !== step.agentId);
            // Nesting level drives the indent and connector offsets in CSS:
            // 0 = main session, 1 = agent, 2 = agent spawned by an agent.
            const depth = step.agentId ? (agentChain.get(step.agentId)?.length ?? 1) : 0;

            return (
              <div
                key={k}
                style={{ '--depth': String(depth) } as React.CSSProperties}
                className={[
                  'step-item',
                  isExpanded ? 'expanded' : '',
                  isHighlighted ? 'highlight' : '',
                  hasIssues ? 'has-issues' : '',
                  step.toolSuccess === false ? 'step-item-error' : '',
                  step.type === 'compact' ? 'step-item-compact' : '',
                  step.type === 'user' ? 'step-item-user' : '',
                  step.type === 'system' ? 'step-item-system' : '',
                  step.type === 'system' && !isSystemFailure(step) ? 'step-item-system-notice' : '',
                  isAgent ? 'step-item-agent' : '',
                  linkedAgents && !allCollapsed ? 'step-item-task' : '',
                  isFirstAgentInRun ? 'step-agent-first' : '',
                  isLastAgentInRun ? 'step-agent-last' : '',
                ].filter(Boolean).join(' ')}
              >
                <button className="step-header" onClick={() => toggleStep(k)}>
                  {linkedAgents && !allCollapsed && <span className="step-spawn-stub" />}
                  <div className="step-left">
                    <StepIcon step={step} />
                    <span className="step-index">#{k}</span>
                    <span className="step-time">{formatTime(step.timestamp)}</span>
                    <span className="step-type">
                      {step.toolName || systemInfo?.label || step.type}
                    </span>
                    {ownerAgent && (
                      <>
                        <span className="step-agent-badge" title={ownerAgent.description || ownerAgent.prompt}>
                          {ownerAgent.agentType || 'agent'}
                        </span>
                        {/* Transcript of this agent lives in
                          <session>/subagents/agent-<agentId>.jsonl — show the id
                          so a row can be traced back to its own session file. */}
                        <span
                          className="step-agent-id"
                          title={`Agent session: agent-${ownerAgent.agentId}.jsonl`}
                        >
                          {ownerAgent.agentId}
                        </span>
                      </>
                    )}
                    {linkedAgents && linkedAgents.length > 0 && (
                      <>
                        {/* The spawning Task row carries the id(s) of the agent
                          session(s) it started, mirroring the agent rows below. */}
                        {linkedAgents.map(a => (
                          <span
                            key={a.agentId}
                            className="step-agent-id"
                            title={`Agent session: agent-${a.agentId}.jsonl${a.agentType ? ` (${a.agentType})` : ''}`}
                          >
                            {a.agentId}
                          </span>
                        ))}
                        <button
                          className={`step-task-toggle${allCollapsed ? ' collapsed' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            for (const a of linkedAgents) toggleAgent(a.agentId);
                          }}
                          title={allCollapsed ? 'Show agent steps' : 'Hide agent steps'}
                        >
                          {allCollapsed ? '▸' : '▾'} {linkedAgents.reduce((acc, a) => acc + a.stepCount, 0)} agent steps
                        </button>
                      </>
                    )}
                    {/* Success/error state is carried by the row colouring alone
                      (.step-item-error) — no extra tick or badge here. */}
                    {summary && summary.text && (
                      <span className={`step-summary${summary.mono ? ' mono' : ''}`}>
                        {summary.text}
                      </span>
                    )}
                  </div>
                  <div className="step-right">
                    {stepDurations.has(k) && (
                      <span className={`step-duration${(stepDurations.get(k)!) >= 5000 ? ' slow' : ''}`}>
                        {formatDuration(stepDurations.get(k)!)}
                      </span>
                    )}
                    {/* Only the step a response is charged to carries a cost.
                      Its siblings carry 0 — a literal $0.0000 there would read
                      as "this was free" rather than "billed elsewhere", so they
                      show where the money actually landed instead, and clicking
                      either side narrows the timeline to that one response. */}
                    {step.cost > 0 ? (
                      sharedBlocks > 1 ? (
                        <button
                          className="step-cost-ref step-cost-charged"
                          title={
                            `Charged once for all ${sharedBlocks} blocks of response ${step.messageId} — click to show them` +
                            (step.costIsEstimate
                              ? `\nEstimated — no exact price for model ${step.model ?? 'unknown'}`
                              : '')
                          }
                          onClick={e => {
                            e.stopPropagation();
                            showResponse(step.messageId!);
                          }}
                        >
                          <span>{step.costIsEstimate ? '≈' : ''}${step.cost.toFixed(4)}</span>
                          <span className="step-cost-ref-target">
                            <CostGroupIcon /> ×{sharedBlocks}
                          </span>
                        </button>
                      ) : (
                        <span
                          className="step-cost"
                          title={
                            step.costIsEstimate
                              ? `Estimated — no exact price for model ${step.model ?? 'unknown'}`
                              : undefined
                          }
                        >
                          {step.costIsEstimate ? '≈' : ''}${step.cost.toFixed(4)}
                        </span>
                      )
                    ) : chargedElsewhere ? (
                      <button
                        className="step-cost-ref"
                        title={`This block is part of response ${step.messageId}, charged as a whole on step #${billed!.key} (${billed!.estimate ? '≈' : ''}$${billed!.cost.toFixed(4)} for ${billed!.blocks} blocks) — click to show only that response`}
                        onClick={e => {
                          e.stopPropagation();
                          showResponse(step.messageId!);
                        }}
                      >
                        <span>{billed!.estimate ? '≈' : ''}${billed!.cost.toFixed(4)}</span>
                        <span className="step-cost-ref-target">
                          <CostGroupIcon /> #{billed!.key}
                        </span>
                      </button>
                    ) : null}
                    <span className="step-expand">▶</span>
                  </div>
                </button>

                {isExpanded && (
                  <div className="step-details">
                    {hasIssues && (
                      <div className="step-findings">
                        {stepFindings.get(k)!.map((f, i) => (
                          <div key={i} className={`finding-inline ${f.severity}`}>
                            <strong>{f.title}</strong>
                            <p>{f.description}</p>
                          </div>
                        ))}
                      </div>
                    )}

                    {(step.toolInput || step.toolResult) && (
                      <div className="detail-section">
                        <RendererErrorBoundary
                          fallback={(err) => (
                            <div className="renderer-fallback">
                              <div className="renderer-fallback-header">
                                Renderer crashed — showing raw data. ({err.message})
                              </div>
                              {step.toolInput !== undefined && (
                                <pre className="detail-code">{JSON.stringify(step.toolInput, null, 2)}</pre>
                              )}
                              {step.toolResult !== undefined && (
                                <pre className="detail-code">{step.toolResult}</pre>
                              )}
                            </div>
                          )}
                        >
                          <ToolRenderer step={step} meta={usageNode} />
                        </RendererErrorBoundary>
                      </div>
                    )}

                    {hasContentBody && (
                      <div className="detail-section">
                        <RendererErrorBoundary
                          fallback={(err) => (
                            <div className="renderer-fallback">
                              <div className="renderer-fallback-header">
                                Renderer crashed — showing raw text. ({err.message})
                              </div>
                              <pre className="detail-text">{step.content}</pre>
                            </div>
                          )}
                        >
                          <ContentRenderer step={step} meta={usageNode} />
                        </RendererErrorBoundary>
                      </div>
                    )}

                    {/* Steps with neither renderer (a tool call with no payload,
                      an empty text block) still have somewhere to show their
                      token counts. */}
                    {usageNode && !hasToolBody && !hasContentBody && (
                      <div className="step-usage-standalone">{usageNode}</div>
                    )}

                    {/* Blobs the message carried — a pasted screenshot, a file
                      from an event the timeline otherwise skips. Tool steps
                      are not here: their attachments belong to the tool
                      renderer, which shows them in the pretty view and the raw
                      base64 in the other two. */}
                    {!hasToolBody && step.attachments && step.attachments.length > 0 && (
                      <Attachments attachments={step.attachments} agentId={step.agentId} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

      </div>
    </div>
  );
};

export default StepsTab;
