/**
 * The kinds of harness event that get a step of their own, and how each one
 * shows up.
 *
 * A `system` step is not something the model did: nothing was billed for it and
 * no rule reasons about it, but it changed the run and the timeline had nothing
 * to show for it. So each kind stays hidden until the user presses its button
 * in the session header, and every kind gets its own button — hook errors and,
 * as they get parsed, API errors or model fallbacks are separate questions and
 * one switch for all of them would be no better than none.
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
}

export const SYSTEM_STEP_KINDS: SystemStepKindInfo[] = [
  {
    kind: 'hook_blocking_error',
    label: 'hook error',
    plural: 'hook errors',
    hint: 'a hook refused a tool call, and the model was handed the error instead of a result',
    Icon: BlockedIcon,
  },
];

const BY_KIND = new Map(SYSTEM_STEP_KINDS.map(info => [info.kind, info]));

/** Undefined for a kind this build doesn't know — the step still renders. */
export const systemKindInfo = (kind?: string): SystemStepKindInfo | undefined =>
  kind ? BY_KIND.get(kind) : undefined;
