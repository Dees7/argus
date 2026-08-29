/**
 * The kinds of harness event that get a step of their own, and how each one
 * shows up.
 *
 * A `system` step is not something the model did: nothing was billed for it and
 * no rule reasons about it, but it changed the run and the timeline had nothing
 * to show for it. So each kind stays hidden until the user presses its button
 * in the session header, and a button covers one question rather than all of
 * them — a blocked tool call, a retried request, a slash command and the stop
 * hooks are separate things to go looking for, and one switch for the lot would
 * be no better than none: the kind you came for would arrive buried in the ones
 * you did not. The stop hooks alone outnumber every other row in a long session.
 * Kinds that answer the same question share a button via `toggleWith`.
 *
 * Adding a kind is an entry here plus a branch in the parser. Everything that
 * renders one — the header buttons, the step icon, the row's type column —
 * reads this list, so nothing else needs to learn the new name.
 */

import type { ReactElement } from 'react';

interface IconProps {
  className?: string;
  size?: number;
}

/** Circle-slash: the call was refused, and by something outside the model. */
const BlockedIcon = ({ className, size = 13 }: IconProps) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="m5.6 5.6 12.8 12.8" />
  </svg>
);

/** Warning triangle: the hook broke, and the run carried on regardless. */
const HookFailedIcon = ({ className, size = 13 }: IconProps) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M10.3 3.9 2.4 17.5a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>
);

/** Cloud struck through: the request to the API did not come back. */
const ApiErrorIcon = ({ className, size = 13 }: IconProps) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M6.5 19a4.5 4.5 0 0 1-.5-8.97A6 6 0 0 1 17.7 8.6 4.7 4.7 0 0 1 20 17.4" />
    <path d="M3 3.5 21 20.5" />
  </svg>
);

/** A slash in a window: a command the CLI ran and answered by itself. */
const LocalCommandIcon = ({ className, size = 13 }: IconProps) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M14 8.5 10 15.5" />
  </svg>
);

/** A crook: the hook the harness hung on the end of the turn. */
const StopHookIcon = ({ className, size = 13 }: IconProps) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15 4v10a5 5 0 0 1-10 0v-2" />
    <path d="M11.5 6.5 15 3l3.5 3.5" />
  </svg>
);

export interface SystemStepKindInfo {
  /** Matches `Step.systemKind` as the parser writes it. */
  kind: string;
  /** The row's type column, where a tool step shows its tool name. */
  label: string;
  /** Plural for the header button: "Show hook errors (12)". */
  plural: string;
  /** What the kind means, appended to the button's tooltip. */
  hint: string;
  Icon: (props: IconProps) => ReactElement;
  /**
   * The kind whose button brings this one in, for a kind that gets no button of
   * its own. Two kinds that answer the same question — "did a hook get in the
   * way?" — are one thing to switch on and two things to read, so they share a
   * button and keep their own label and icon in the row. Omitted by every kind
   * that stands on its own, which is the normal case.
   */
  toggleWith?: string;
}

export const SYSTEM_STEP_KINDS: SystemStepKindInfo[] = [
  {
    kind: 'hook_blocking_error',
    label: 'hook error',
    plural: 'hook errors',
    hint: 'a hook got in the way of the run — one that refused a tool call and handed the model the error instead of a result, or one that failed and was let through anyway',
    Icon: BlockedIcon,
  },
  {
    kind: 'hook_non_blocking_error',
    label: 'hook failed',
    plural: 'hook failures',
    hint: 'a hook exited non-zero and nothing stopped — the notification never fired, the formatter never ran, and this event is the only trace',
    Icon: HookFailedIcon,
    toggleWith: 'hook_blocking_error',
  },
  {
    kind: 'api_error',
    label: 'api error',
    plural: 'API errors',
    hint: 'a request failed and was retried — one row per attempt, so a burst reads as the burst it was',
    Icon: ApiErrorIcon,
  },
  {
    kind: 'local_command',
    label: 'command',
    plural: 'local commands',
    hint: 'a slash command the CLI answered by itself — the model never saw it; the invocation and its output are separate rows',
    Icon: LocalCommandIcon,
  },
  {
    kind: 'stop_hook_summary',
    label: 'stop hooks',
    plural: 'stop hooks',
    hint: 'what the Stop hooks did when a turn ended — one row per turn, so most say only that they ran; the ones that matter are the errors and the refusals to stop',
    Icon: StopHookIcon,
  },
];

const BY_KIND = new Map(SYSTEM_STEP_KINDS.map(info => [info.kind, info]));

/** Undefined for a kind this build doesn't know — the step still renders. */
export const systemKindInfo = (kind?: string): SystemStepKindInfo | undefined =>
  kind ? BY_KIND.get(kind) : undefined;

/**
 * Which button governs a kind: its own, unless it rides on another's. A kind
 * this build doesn't know governs itself, so a step from a newer parser is
 * still reachable by a button of its own name.
 */
export const systemToggleOf = (kind?: string): string =>
  (kind ? BY_KIND.get(kind)?.toggleWith : undefined) ?? kind ?? '';

/** One button per group, in registry order — what the header renders. */
export const SYSTEM_STEP_TOGGLES = SYSTEM_STEP_KINDS.filter(info => !info.toggleWith);
