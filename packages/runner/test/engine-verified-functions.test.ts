import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
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

  function getExecutableRegistry() {
    return (engine as any).executableRegistry;
  }

  it("restores verifiedFunctionIndex entries from other loads when one load resets", () => {
    const previous = Object.assign(() => "previous", {
      implementationRef: "main.tsx#000:handler",
    });
    const surviving = Object.assign(() => "surviving", {
      implementationRef: "main.tsx#000:handler",
    });
    const executableRegistry = getExecutableRegistry();

    executableRegistry.verifiedFunctions.set(
      "load:previous",
      new Map([[previous.implementationRef, previous]]),
    );
    executableRegistry.verifiedFunctions.set(
      "load:surviving",
      new Map([[surviving.implementationRef, surviving]]),
    );
    executableRegistry.verifiedFunctionIndex.set(
      previous.implementationRef,
      previous,
    );

    executableRegistry.beginVerifiedLoad("load:previous");

    expect(executableRegistry.verifiedFunctions.get("load:previous")).toEqual(
      new Map(),
    );
    expect(
      executableRegistry.verifiedFunctionIndex.get(previous.implementationRef),
    ).toBe(surviving);
  });

  it("removes verifiedFunctionIndex entries when no other load owns the ref", () => {
    const only = Object.assign(() => "only", {
      implementationRef: "main.tsx#000:handler",
    });
    const executableRegistry = getExecutableRegistry();

    executableRegistry.verifiedFunctions.set(
      "load:only",
      new Map([[only.implementationRef, only]]),
    );
    executableRegistry.verifiedFunctionIndex.set(only.implementationRef, only);

    executableRegistry.beginVerifiedLoad("load:only");

    expect(executableRegistry.verifiedFunctionIndex.has(only.implementationRef))
      .toBe(false);
  });
});
