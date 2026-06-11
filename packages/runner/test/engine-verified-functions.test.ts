import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";

const signer = await Identity.fromPassphrase("test operator");

// The global executable index — the retained legacy read path (gate-2
// decision, PR E2): pre-flip stored graphs, host-trusted values, and dynamic
// in-action artifacts all resolve by `implementationRef` through it. The
// former per-load partitions and the `beginVerifiedLoad` cross-load repair
// are gone; the index is global, strong, and overwrite-on-re-registration.
describe("Engine verified function registry", () => {
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
    // deno-lint-ignore no-explicit-any
    return (engine as any).executableRegistry;
  }

  it("admits registered functions through the global index", () => {
    const fn = Object.assign(() => "value", {
      implementationRef: "main.tsx#000:handler",
    });
    const executableRegistry = getExecutableRegistry();

    executableRegistry.registerVerifiedFunction(fn.implementationRef, fn);

    expect(executableRegistry.getVerifiedFunction(fn.implementationRef))
      .toBe(fn);
    expect(executableRegistry.getExecutableFunction(fn.implementationRef))
      .toBe(fn);
  });

  it("re-registration of a content-derived ref points the index at the fresh function", () => {
    // Two evaluations of the same module mint the same content-derived ref
    // for behaviorally interchangeable functions (SES forbids module-scope
    // mutable state); the index resolves to the latest.
    const first = Object.assign(() => "first", {
      implementationRef: "main.tsx#000:handler",
    });
    const second = Object.assign(() => "second", {
      implementationRef: "main.tsx#000:handler",
    });
    const executableRegistry = getExecutableRegistry();

    executableRegistry.registerVerifiedFunction(first.implementationRef, first);
    executableRegistry.registerVerifiedFunction(
      second.implementationRef,
      second,
    );

    expect(executableRegistry.getExecutableFunction(first.implementationRef))
      .toBe(second);
  });

  it("dynamic in-action registrations admit through the same index (Harness channel)", () => {
    const dynamic = Object.assign(() => "dynamic", {
      implementationRef: "fid1:dynamic-artifact",
    });

    engine.registerDynamicVerifiedFunction(
      dynamic.implementationRef,
      dynamic,
    );

    expect(engine.getExecutableFunction(dynamic.implementationRef))
      .toBe(dynamic);
  });
});
