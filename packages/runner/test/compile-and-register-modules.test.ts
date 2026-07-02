import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  Engine,
  Runtime,
  signer,
  StorageManager,
} from "./engine-test-support.ts";
import type { RuntimeProgram } from "./engine-test-support.ts";

/**
 * Conformance guard for CT-1811.
 *
 * The pattern-load seam `PatternManager.compileAndRegisterModules` must INDEX
 * the evaluated artifacts (so a pattern/op gets a content-addressed entry ref and
 * resolves via its canonical `$patternRef` artifact), while the bare
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

  it("the bare Engine.compileAndEvaluateModules does NOT index artifacts", async () => {
    const engine = runtime.harness as Engine;
    const result = await engine.compileAndEvaluateModules(program);
    const entry = result.main!["default"] as object;
    // No registration → no content-addressed entry ref → map/filter/flatMap ops
    // would fall back to the embedded graph (this is the CT-1811 hazard the seam
    // exists to remove).
    expect(runtime.patternManager.getArtifactEntryRef(entry)).toBeUndefined();
  });
});
