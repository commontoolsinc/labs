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

/** Keeps rapid node selections ordered without repeating the latest request. */
export function useLatestRequestedSelection(
  authoritativeSelection: string | null,
  writeSelection: (nodeId: string) => Promise<unknown>,
): (nodeId: string) => Promise<void> {
  const authoritativeRef = React.useRef(authoritativeSelection);
  const latestRequestedRef = React.useRef(authoritativeSelection);
  const pendingCountRef = React.useRef(0);
  authoritativeRef.current = authoritativeSelection;

  React.useEffect(() => {
    if (pendingCountRef.current === 0) {
      latestRequestedRef.current = authoritativeSelection;
    }
  }, [authoritativeSelection]);

  return React.useCallback(async (nodeId: string) => {
    if (latestRequestedRef.current === nodeId) return;
    latestRequestedRef.current = nodeId;
    pendingCountRef.current++;
    try {
      await writeSelection(nodeId);
    } finally {
      pendingCountRef.current--;
      if (pendingCountRef.current === 0) {
        latestRequestedRef.current = authoritativeRef.current;
      }
    }
  }, [writeSelection]);
}
