import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { schedulerImplementationFingerprint } from "../src/scheduler/run.ts";
import type { Action } from "../src/scheduler/types.ts";

function makeAction(props: Record<string, unknown>): Action {
  const fn = (() => {}) as unknown as Action;
  Object.assign(fn, props);
  return fn;
}

describe("schedulerImplementationFingerprint", () => {
  it("prefers a content-addressed implementationHash over src", () => {
    const action = makeAction({
      src: "/abc123/pattern.tsx:1:1",
      implementationHash: "cf:module/HHH#sym",
    });
    expect(schedulerImplementationFingerprint(action, "id", undefined)).toBe(
      "impl:cf:module/HHH#sym",
    );
  });

  it("falls back to src when no implementationHash is present", () => {
    const action = makeAction({ src: "/abc123/pattern.tsx:1:1" });
    expect(schedulerImplementationFingerprint(action, "id", undefined)).toBe(
      "src:/abc123/pattern.tsx:1:1",
    );
  });

  it("ignores a non-string or empty implementationHash and falls back to src", () => {
    const action = makeAction({
      src: "/abc123/pattern.tsx:1:1",
      implementationHash: "",
    });
    expect(schedulerImplementationFingerprint(action, "id", undefined)).toBe(
      "src:/abc123/pattern.tsx:1:1",
    );
  });

  it("falls back to a telemetry-derived id when neither is present", () => {
    const action = makeAction({});
    expect(schedulerImplementationFingerprint(action, "id", undefined)).toBe(
      "action:action:id:id",
    );
  });
});
