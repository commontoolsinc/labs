// @deno-types="npm:@types/react@19.2.18"
// deno-lint-ignore no-external-import
import React, { type ReactNode } from "npm:react@19.2.8";

/** Keeps embedded controls out of React Flow's node-selection lifecycle. */
export function stopNodeControlPropagation(
  event: Pick<Event, "stopPropagation">,
): void {
  event.stopPropagation();
}

/** Owns the event and drag boundary around controls rendered inside a node. */
export function NodeControlBoundary(
  { children }: Readonly<{ children?: ReactNode }>,
) {
  return React.createElement(
    "div",
    {
      className: "node-parameters nodrag nopan",
      onClick: stopNodeControlPropagation,
    },
    children,
  );
}
