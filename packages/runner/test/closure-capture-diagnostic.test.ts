// Unit coverage for the unified closure-capture diagnostic message (CT-1626).
// Both construction-time throw sites (builder/node-utils.ts and
// builder/pattern.ts) route through `closureCaptureErrorMessage`, so this pins
// the shared wording: it names the offending cell, surfaces a source location
// when one is available, and recommends the actual escape hatches
// (inline pattern closures / computed) rather than manual sibling params or
// the old "wrap in a derive" guidance.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { closureCaptureErrorMessage } from "../src/builder/closure-capture-diagnostic.ts";

describe("closureCaptureErrorMessage (CT-1626)", () => {
  it("describes the captured cell's name, path, and scope", () => {
    const message = closureCaptureErrorMessage({
      capturedCell: {
        name: "setAssign",
        path: ["params", "setAssign"],
        scope: "space",
      },
    });
    expect(message).toContain("'setAssign'");
    expect(message).toContain("at path [params, setAssign]");
    expect(message).toContain("space-scoped");
    expect(message).toContain("captured by a closure");
  });

  it("includes a source location when one is resolved", () => {
    const message = closureCaptureErrorMessage({
      capturedCell: { name: "x" },
      sourceLocation: "/main.tsx:23:7",
    });
    expect(message).toContain("at /main.tsx:23:7");
  });

  it("omits the location line when none is available", () => {
    const message = closureCaptureErrorMessage({
      capturedCell: { name: "x" },
      sourceLocation: null,
    });
    expect(message).not.toContain("\n  at ");
  });

  it("recommends inline closures instead of manual sibling params", () => {
    const message = closureCaptureErrorMessage();
    expect(message).toContain("write the callback inline");
    expect(message).toContain("computed()");
    expect(message).not.toContain("mapWithPattern(pattern, params)");
    expect(message).not.toContain("thread captured cells through `params`");
    // The misleading "wrap the access in a derive" recipe is gone.
    expect(message).not.toContain("derive that passes the variable through");
  });

  it("degrades gracefully with no cell info", () => {
    const message = closureCaptureErrorMessage();
    expect(message).toContain("Reactive cell from an outer scope");
  });
});
