import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { enterActionExecution } from "../src/builder/action-context.ts";
import { handler, lift } from "../src/builder/module.ts";

/**
 * Identity E5 (design Phase 4): builder artifacts are module-scope
 * declarations — the transformer hoists every authored builder call, and
 * content-addressed identity only exists for module-scope artifacts. Minting
 * a lift/handler INSIDE a running action used to limp along through the
 * legacy registry channel (in-session only, never rehydratable); with that
 * channel gone the mint fails loudly at creation time, pointing at the
 * module-level rule and the possibility of a transformer bug.
 */
describe("builder calls inside a running action throw", () => {
  it("lift() inside the action window throws with module-level guidance", () => {
    const exit = enterActionExecution();
    try {
      expect(() => lift((x: number) => x + 1)).toThrow(
        /define the lift at module level/,
      );
      expect(() => lift((x: number) => x + 1)).toThrow(
        /transformer bug/,
      );
    } finally {
      exit();
    }
  });

  it("handler() inside the action window throws with module-level guidance", () => {
    const exit = enterActionExecution();
    try {
      expect(() =>
        handler(
          { type: "object" },
          { type: "object" },
          () => {},
        )
      ).toThrow(
        /define the handler at module level/,
      );
    } finally {
      exit();
    }
  });

  it("the same calls are fine outside the action window", () => {
    expect(() => lift((x: number) => x + 1)).not.toThrow();
    expect(() =>
      handler(
        { type: "object" },
        { type: "object" },
        () => {},
      )
    ).not.toThrow();
  });

  it("the window is re-entrant and restores correctly", () => {
    const exitOuter = enterActionExecution();
    const exitInner = enterActionExecution();
    exitInner();
    expect(() => lift((x: number) => x)).toThrow(/module level/);
    exitOuter();
    expect(() => lift((x: number) => x)).not.toThrow();
  });
});
