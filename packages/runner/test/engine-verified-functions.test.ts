import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("Engine verified function cleanup", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("restores verifiedFunctionIndex entries from other loads when one load resets", () => {
    const previous = Object.assign(() => "previous", {
      implementationRef: "main.tsx#000:handler",
    });
    const surviving = Object.assign(() => "surviving", {
      implementationRef: "main.tsx#000:handler",
    });

    (engine as any).verifiedFunctions.set(
      "load:previous",
      new Map([[previous.implementationRef, previous]]),
    );
    (engine as any).verifiedFunctions.set(
      "load:surviving",
      new Map([[surviving.implementationRef, surviving]]),
    );
    (engine as any).verifiedFunctionIndex.set(
      previous.implementationRef,
      previous,
    );

    (engine as any).resetVerifiedFunctions("load:previous");

    expect((engine as any).verifiedFunctions.get("load:previous")).toEqual(
      new Map(),
    );
    expect(
      (engine as any).verifiedFunctionIndex.get(previous.implementationRef),
    ).toBe(surviving);
  });

  it("removes verifiedFunctionIndex entries when no other load owns the ref", () => {
    const only = Object.assign(() => "only", {
      implementationRef: "main.tsx#000:handler",
    });

    (engine as any).verifiedFunctions.set(
      "load:only",
      new Map([[only.implementationRef, only]]),
    );
    (engine as any).verifiedFunctionIndex.set(only.implementationRef, only);

    (engine as any).resetVerifiedFunctions("load:only");

    expect(
      (engine as any).verifiedFunctionIndex.has(only.implementationRef),
    ).toBe(false);
  });
});
