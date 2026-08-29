/** Exercises embedded node controls with React's real browser event system. */

// @deno-types="npm:@types/react@19.2.18"
// deno-lint-ignore no-external-import
import React, { act } from "npm:react@19.2.8";
// @deno-types="npm:@types/react-dom@19.2.5/client.d.ts"
// deno-lint-ignore no-external-import
import { createRoot } from "npm:react-dom@19.2.8/client";
import { expect } from "@std/expect";

import {
  NodeControlBoundary,
  useLatestRequestedSelection,
} from "./interaction.ts";

function SelectionHarness(
  { writeSelection }: Readonly<{
    writeSelection: (nodeId: string) => Promise<unknown>;
  }>,
) {
  const requestSelection = useLatestRequestedSelection(
    "node-a",
    writeSelection,
  );
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "button",
      { onClick: () => void requestSelection("node-a") },
      "Select A",
    ),
    React.createElement(
      "button",
      { onClick: () => void requestSelection("node-b") },
      "Select B",
    ),
  );
}

Deno.test("embedded controls do not select their React Flow node", async () => {
  if (typeof document === "undefined") return;
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let nodeSelections = 0;

  try {
    await act(() => {
      root.render(
        React.createElement(
          "div",
          { onClick: () => nodeSelections++ },
          React.createElement(
            NodeControlBoundary,
            null,
            React.createElement(
              "select",
              { "aria-label": "Gate operator", defaultValue: "xor" },
              React.createElement("option", { value: "xor" }, "XOR"),
              React.createElement("option", { value: "and" }, "AND"),
            ),
          ),
        ),
      );
    });

    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    select!.click();

    expect(nodeSelections).toBe(0);
    expect(select!.disabled).toBe(false);
  } finally {
    await act(() => root.unmount());
    container.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

Deno.test("rapid node selections retain the latest requested node", async () => {
  if (typeof document === "undefined") return;
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const writes: string[] = [];
  let releaseNodeB!: () => void;
  const nodeBGate = new Promise<void>((resolve) => releaseNodeB = resolve);
  const writeSelection = (nodeId: string) => {
    writes.push(nodeId);
    return nodeId === "node-b" ? nodeBGate : Promise.resolve();
  };

  try {
    await act(() => {
      root.render(React.createElement(SelectionHarness, { writeSelection }));
    });
    const [selectA, selectB] = container.querySelectorAll("button");

    selectA.click();
    selectB.click();
    selectA.click();

    expect(writes).toEqual(["node-b", "node-a"]);
  } finally {
    releaseNodeB();
    await act(async () => {
      await nodeBGate;
      root.unmount();
    });
    container.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
