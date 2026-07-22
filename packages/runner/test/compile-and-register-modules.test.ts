import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  Engine,
  Runtime,
  signer,
  StorageManager,
} from "./engine-test-support.ts";
import type { RuntimeProgram } from "./engine-test-support.ts";
import type { ModuleByteCache } from "../src/runtime.ts";
import type { CompiledModuleArtifact } from "../src/harness/types.ts";
import { factoryStateOf } from "@commonfabric/data-model/fabric-factory";

/**
 * Conformance guard for CT-1811.
 *
 * The pattern-load seam `PatternManager.compileAndRegisterModules` must INDEX
 * the evaluated artifacts (so a pattern/op gets a content-addressed entry ref
 * for canonical Factory@1 materialization), while the bare
 * `Engine.compileAndEvaluateModules` primitive must NOT. This pins the contract
 * that lets harness callers get the full evaluated namespace without silently
 * skipping registration — the divergence that caused CT-1811.
 */
describe("PatternManager.compileAndRegisterModules", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const program: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents: `import { NAME, pattern } from "commonfabric";\n` +
          `export default pattern(() => ({ [NAME]: "conformance" }));\n`,
      },
    ],
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("indexes evaluated artifacts (default export gets an entry ref)", async () => {
    const result = await runtime.patternManager.compileAndRegisterModules(
      program,
    );
    const entry = result.main!["default"] as object;
    expect(runtime.patternManager.getArtifactEntryRef(entry)).toBeDefined();
  });

  it("can persist the evaluated closure before granting durable factory refs", async () => {
    const result = await runtime.patternManager.compileAndRegisterModules(
      program,
      undefined,
      { space: signer.did() },
    );
    const entry = result.main!["default"] as object;

    expect(factoryStateOf(entry).ref).toBeDefined();
  });

  it("the bare Engine.compileAndEvaluateModules does NOT index artifacts", async () => {
    const engine = runtime.harness as Engine;
    const result = await engine.compileAndEvaluateModules(program);
    const entry = result.main!["default"] as object;
    // No registration means no content-addressed entry ref, so the value cannot
    // be materialized through the canonical Factory@1 path.
    expect(runtime.patternManager.getArtifactEntryRef(entry)).toBeUndefined();
  });

  // The cf-test harness injects a process-wide module byte cache
  // (`RuntimeOptions.moduleByteCache`) so repeated pattern compiles across
  // runtimes skip the transform-and-emit step. Pin that seam here: a fresh
  // runtime given a previously populated cache must serve the compile from
  // cached bytes (a COMPLETE set — partial sets recompile) and still register
  // the evaluated artifacts exactly like a cold compile.
  it("reuses an injected module byte cache across runtimes and still registers", async () => {
    const entries = new Map<
      string,
      { identity: string } & CompiledModuleArtifact
    >();
    let completeSetHits = 0;
    const byteCache: ModuleByteCache = {
      getCompleteSet(runtimeVersion, identities) {
        const set = new Map<string, CompiledModuleArtifact>();
        for (const identity of identities) {
          const entry = entries.get(`${runtimeVersion}\0${identity}`);
          if (entry === undefined) return undefined;
          set.set(identity, entry);
        }
        completeSetHits++;
        return set;
      },
      putAll(runtimeVersion, modules) {
        for (const module of modules) {
          entries.set(`${runtimeVersion}\0${module.identity}`, module);
        }
      },
    };

    // Cold: compiles, writes the emitted bodies back through putAll.
    const coldStorage = StorageManager.emulate({ as: signer });
    const coldRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: coldStorage,
      moduleByteCache: byteCache,
    });
    try {
      const cold = await coldRuntime.patternManager.compileAndRegisterModules(
        program,
      );
      expect(
        coldRuntime.patternManager.getArtifactEntryRef(
          cold.main!["default"] as object,
        ),
      ).toBeDefined();
      expect(entries.size).toBeGreaterThan(0);
      expect(completeSetHits).toBe(0); // nothing cached yet on the cold pass
    } finally {
      await coldRuntime.dispose();
      await coldStorage.close();
    }

    // Warm: a fresh runtime with the SAME cache must get a complete set and
    // still produce a registered, evaluated namespace.
    const warmStorage = StorageManager.emulate({ as: signer });
    const warmRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: warmStorage,
      moduleByteCache: byteCache,
    });
    try {
      const warm = await warmRuntime.patternManager.compileAndRegisterModules(
        program,
      );
      expect(completeSetHits).toBe(1);
      expect(
        warmRuntime.patternManager.getArtifactEntryRef(
          warm.main!["default"] as object,
        ),
      ).toBeDefined();
    } finally {
      await warmRuntime.dispose();
      await warmStorage.close();
    }
  });
});
