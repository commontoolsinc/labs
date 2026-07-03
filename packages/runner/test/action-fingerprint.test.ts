import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { schedulerImplementationFingerprint } from "../src/scheduler/run.ts";
import type { Action } from "../src/scheduler/types.ts";
import { recordVerifiedProvenance } from "../src/harness/verified-provenance.ts";

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

  it("derives a content-addressed impl: id from provenance, NOT from src", () => {
    const impl = (() => {}) as () => void;
    recordVerifiedProvenance(impl, { identity: "HASH", symbol: "__cfLift_1" });
    const action = makeAction({
      src: "/abc123/pattern.tsx:1:1", // present but must be ignored
      module: { implementation: impl },
    });
    expect(schedulerImplementationFingerprint(action, "id", undefined)).toBe(
      "impl:cf:module/HASH:__cfLift_1",
    );
  });

  it("does NOT consult src for identity (debug-only); falls to the telemetry id", () => {
    const action = makeAction({ src: "/abc123/pattern.tsx:1:1" });
    expect(schedulerImplementationFingerprint(action, "id", undefined)).toBe(
      "action:action:id:id",
    );
  });

  it("ignores an empty implementationHash and still does not consult src", () => {
    const action = makeAction({
      src: "/abc123/pattern.tsx:1:1",
      implementationHash: "",
    });
    expect(schedulerImplementationFingerprint(action, "id", undefined)).toBe(
      "action:action:id:id",
    );
  });

  it("falls back to a telemetry-derived id when neither is present", () => {
    const action = makeAction({});
    expect(schedulerImplementationFingerprint(action, "id", undefined)).toBe(
      "action:action:id:id",
    );
  });
});
