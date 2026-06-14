import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { Source } from "@commonfabric/js-compiler";
import type { CachedCompiledModule } from "../src/sandbox/module-record-compiler.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("load-by-identity");
const space = signer.did();

// The load-by-identity warm path: build + evaluate a pattern directly from
// cached compiled modules (no TS source, no resolve, no recompile), and the
// cold-recovery path: recreate the pattern from the stored TypeScript alone
// (content-addressed source set) when the compiled set is unavailable — the
// runtime-version-bump scenario.
describe("load by module identity (warm + version-bump recovery)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let engine: Engine;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
    tx = runtime.edit();
  });
  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  const PROGRAM: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      { name: "/util.ts", contents: "export const double = (x:number)=>x*2;" },
      {
        name: "/main.tsx",
        contents: [
          "import { pattern, lift } from 'commonfabric';",
          "import { double } from './util.ts';",
          "const dbl = lift((x:number)=>double(x));",
          "export default pattern<{ value: number }>(({ value }) => {",
          "  return { result: dbl(value) };",
          "});",
        ].join("\n"),
      },
    ],
  };

  const runPattern = async (
    main: Record<string, unknown> | undefined,
    value: number,
    cause: string,
  ): Promise<unknown> => {
    const pattern = (main as { default?: unknown })?.default;
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      cause,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const result = runtime.run(tx, pattern as any, { value }, resultCell);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();
    return result.getAsQueryResult();
  };

  const toCached = (
    modules: {
      identity: string;
      filename: string;
      js: string;
      imports: unknown;
    }[],
  ): CachedCompiledModule[] =>
    modules.map((m) => ({
      identity: m.identity,
      filename: m.filename,
      code: m.js,
      // deno-lint-ignore no-explicit-any
      imports: m.imports as any,
    }));

  it("evaluates a pattern from cached compiled modules (no resolve/compile)", async () => {
    const { modules, entryIdentity } = await engine.compileToRecordGraph(
      PROGRAM,
    );

    // Warm path: build records + evaluate straight from the cached bodies.
    const result = await engine.evaluateCachedModules(
      toCached(modules),
      entryIdentity,
      { sourceFiles: PROGRAM.files },
    );
    expect(result.main).toBeDefined();
    expect(await runPattern(result.main, 4, "warm cached run")).toEqual({
      result: 8,
    });
  });

  it("recreates the pattern from the stored TypeScript alone (runtime-version bump)", async () => {
    // First compile — capture the content-addressed source set (what
    // `pattern:<identity>` cells store: each module's resolved TS + identity).
    const first = await engine.compileToRecordGraph(PROGRAM);
    const storedSource: Source[] = first.modules.map((m) => ({
      name: m.filename,
      contents: m.source,
    }));
    const entryFilename =
      first.modules.find((m) => m.identity === first.entryIdentity)!.filename;

    // Simulate a runtime-version bump: the compiled set (keyed by
    // runtimeVersion) is now a miss, so recover from the stored source alone —
    // no in-hand program, no compiled cache. Recompiling is identity-stable.
    const recovered = await engine.compileResolvedToRecordGraph(
      storedSource,
      entryFilename,
    );

    // Content-addressed: recompiling the stored source reproduces the SAME
    // per-module identities (so the rebuilt compiled set is addressable, and
    // writable-back under the new runtimeVersion).
    expect(recovered.entryIdentity).toBe(first.entryIdentity);
    expect(new Set(recovered.modules.map((m) => m.identity))).toEqual(
      new Set(first.modules.map((m) => m.identity)),
    );

    // And the recreated pattern runs correctly.
    const result = await engine.evaluateCachedModules(
      toCached(recovered.modules),
      recovered.entryIdentity,
      { sourceFiles: storedSource },
    );
    expect(await runPattern(result.main, 5, "recovered run")).toEqual({
      result: 10,
    });
  });

  it("trusts integrity-gated cached bodies and skips body re-verification", async () => {
    // Spec (module-loading.md, threat model): a warm hit loaded from the
    // integrity-gated compiled set trusts the CFC label, so `trustedBodies`
    // skips the per-module SES verifier. Tamper the entry body with a
    // verify-rejectable but eval-safe top-level statement (a bare call
    // expression — rejected by classification, harmless to execute) appended
    // after the module's exports so `default` still resolves.
    const { modules, entryIdentity } = await engine.compileToRecordGraph(
      PROGRAM,
    );
    const tamperedCached = toCached(modules).map((m) =>
      m.identity === entryIdentity
        ? { ...m, code: `${m.code}\nObject.keys({});\n` }
        : m
    );
    // Untrusted: the SES body verifier rejects the tampered body before eval.
    await expect(
      engine.evaluateCachedModules(tamperedCached, entryIdentity, {
        sourceFiles: PROGRAM.files,
      }),
    ).rejects.toThrow();
    // Trusted (integrity-gated warm hit): body verification is skipped, so the
    // graph evaluates and the pattern runs correctly.
    const trusted = await engine.evaluateCachedModules(
      tamperedCached,
      entryIdentity,
      { sourceFiles: PROGRAM.files, trustedBodies: true },
    );
    expect(await runPattern(trusted.main, 3, "trusted cached run")).toEqual({
      result: 6,
    });
  });
});
