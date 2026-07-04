// Unit coverage for the unified closure-capture diagnostic message (CT-1626).
// Both construction-time throw sites (builder/node-utils.ts and
// builder/pattern.ts) route through `closureCaptureErrorMessage`, so this pins
// the shared wording: it names the offending cell, surfaces a source location
// when one is available, and recommends the actual escape hatches
// (mapWithPattern / computed) rather than the old "wrap in a derive" guidance.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { closureCaptureErrorMessage } from "../src/builder/closure-capture-diagnostic.ts";
import { connectInputAndOutputs } from "../src/builder/node-utils.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import type { NodeRef } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("test closure capture diagnostic");
const space = signer.did();

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

  it("recommends the real escape hatches (mapWithPattern / computed)", () => {
    const message = closureCaptureErrorMessage();
    expect(message).toContain("mapWithPattern");
    expect(message).toContain("computed()");
    // The misleading "wrap the access in a derive" recipe is gone.
    expect(message).not.toContain("derive that passes the variable through");
  });

  it("degrades gracefully with no cell info", () => {
    const message = closureCaptureErrorMessage();
    expect(message).toContain("Reactive cell from an outer scope");
  });

  it("reports construction-time captures through node inputs", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();

    try {
      const capturedCell = runtime.getCell(
        space,
        "construction-time capture",
        undefined,
        tx,
      );
      const nodeFrame = pushFrame({ runtime, space, tx });
      try {
        const node = {
          module: {
            type: "javascript",
            implementation: function captureInput() {
              return undefined;
            },
          },
          inputs: { capturedCell },
          outputs: {},
          frame: nodeFrame,
        } as NodeRef;

        expect(() => connectInputAndOutputs(node)).toThrow(
          "captured by a closure",
        );
      } finally {
        popFrame(nodeFrame);
      }
    } finally {
      await tx.commit();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
