import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { DataUnavailable } from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";
import { createBuilder } from "../src/builder/factory.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase(
  "data-unavailability builder test operator",
);

describe("data-unavailability builder helpers", () => {
  const { commonfabric } = createBuilder();

  it("injects pure concrete-brand guards", () => {
    const pending = DataUnavailable.pending();
    const error = DataUnavailable.error(new Error("failed"));
    const syncing = DataUnavailable.syncing();
    const mismatch = DataUnavailable.schemaMismatch();

    expect(commonfabric.isPending(pending)).toBe(true);
    expect(commonfabric.hasError(error)).toBe(true);
    expect(commonfabric.isSyncing(syncing)).toBe(true);
    expect(commonfabric.hasSchemaMismatch(mismatch)).toBe(true);
    expect(commonfabric.isPending({ reason: "pending", pending: true })).toBe(
      false,
    );
  });

  it("observeAvailability is a zero-node identity", () => {
    const pending = DataUnavailable.pending();

    expect(commonfabric.observeAvailability(pending)).toBe(pending);
    expect(commonfabric.observeAvailability(pending, "error")).toBe(pending);
  });

  it("resultOf is a zero-node identity", () => {
    const pending = DataUnavailable.pending();

    expect(commonfabric.resultOf(pending)).toBe(pending);
    expect(commonfabric.resultOf("ready")).toBe("ready");
  });

  it("projects direct async results without adding projection nodes", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const frame = pushFrame({ runtime, space: signer.did() });

    try {
      const AsyncResults = commonfabric.pattern(() => {
        const fetched = commonfabric.fetchText({ url: "/text" });
        const availableFetched = commonfabric.resultOf(fetched);
        const generated = commonfabric.generateText({ prompt: "hello" });
        const availableGenerated = commonfabric.resultOf(generated);
        const advanced = commonfabric.generateTextStream({ prompt: "hello" });
        return {
          fetched,
          availableFetched,
          generated,
          availableGenerated,
          partial: commonfabric.partialResultOf(advanced),
        };
      });

      expect(AsyncResults.nodes).toHaveLength(3);
      expect((AsyncResults.result as any).fetched.$alias.path).toEqual([
        "result",
      ]);
      expect((AsyncResults.result as any).generated.$alias.path).toEqual([
        "result",
      ]);
      expect((AsyncResults.result as any).availableFetched.$alias).toEqual(
        (AsyncResults.result as any).fetched.$alias,
      );
      expect((AsyncResults.result as any).availableGenerated.$alias).toEqual(
        (AsyncResults.result as any).generated.$alias,
      );
      expect((AsyncResults.result as any).partial.$alias.path).toEqual([
        "partial",
      ]);
    } finally {
      popFrame(frame);
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("associates streaming final and partial results without projection nodes", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const frame = pushFrame({ runtime, space: signer.did() });

    try {
      const StreamingResults = commonfabric.pattern(() => {
        const request = commonfabric.generateTextStream({ prompt: "hello" });
        const final = commonfabric.resultOf(request);
        const partialRequest = commonfabric.partialResultOf(request);
        const partial = commonfabric.resultOf(partialRequest);
        return { request, final, partialRequest, partial };
      });

      expect(StreamingResults.nodes).toHaveLength(1);
      expect((StreamingResults.result as any).request.$alias.path).toEqual([
        "result",
      ]);
      expect((StreamingResults.result as any).final.$alias).toEqual(
        (StreamingResults.result as any).request.$alias,
      );
      expect((StreamingResults.result as any).partialRequest.$alias.path)
        .toEqual(["partial"]);
      expect((StreamingResults.result as any).partial.$alias).toEqual(
        (StreamingResults.result as any).partialRequest.$alias,
      );
    } finally {
      popFrame(frame);
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
