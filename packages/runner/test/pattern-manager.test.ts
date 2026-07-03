import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { getPatternProgram } from "../src/builder/pattern-metadata.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("PatternManager program persistence", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("compiles multi-file program, attaches program, persists source docs and reloads by identity", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/util.ts",
          contents: "export const double = (x:number)=>x*2;",
        },
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

    // Compiling INTO a space persists the content-addressed source +
    // compiled docs (the single durable source — no more meta cell).
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
    });
    expect(getPatternProgram(compiled)).toBeDefined();
    expect(getPatternProgram(compiled)?.main).toEqual("/main.tsx");
    // Ensure original file names are preserved (no injected prefix leaked here)
    const fileNames = (getPatternProgram(compiled)?.files ?? []).map((f) =>
      f.name
    ).sort();
    expect(fileNames).toEqual(["/main.tsx", "/util.ts"].sort());

    const entryRef = runtime.patternManager.getArtifactEntryRef(compiled);
    expect(entryRef).toBeDefined();

    // Recover the source files from the persisted source-doc closure. The
    // closure is the recovery unit, so it includes the authored modules plus
    // any injected helper modules (e.g. cfc.ts) — assert the authored files are
    // present rather than an exact set.
    const recovered = await runtime.patternManager
      .getPatternSourceProgramByIdentity(entryRef!.identity, space);
    expect(recovered?.main).toEqual("/main.tsx");
    const recoveredNames = (recovered?.files ?? []).map((f) => f.name);
    expect(recoveredNames).toContain("/main.tsx");
    expect(recoveredNames).toContain("/util.ts");

    // Verify we can re-load the pattern by its content identity and run it.
    const loaded = await runtime.patternManager.loadPatternByIdentity(
      entryRef!.identity,
      entryRef!.symbol,
      space,
    );
    expect(loaded).toBeDefined();
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "pattern-manager: run loaded",
      undefined,
      tx,
    );
    const result = runtime.run(tx, loaded!, { value: 3 }, resultCell);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();
    expect(result.getAsQueryResult()).toEqual({ result: 6 });
  });
});

describe("PatternManager.loadPatternByIdentity single-flight", () => {
  it("concurrent loads of one identity share a single evaluation's artifact", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    // Runtime A persists the closure; a FRESH runtime B then loads it with
    // cold in-memory indexes, so concurrent calls all miss the sync fast
    // paths and race into the storage/eval tail. Without the single-flight
    // dedup, each call ran its own full SES evaluation of the closure
    // (measured as 4 identical evaluations per cold worker boot); with it,
    // one leader evaluates and every caller resolves to the same shared
    // content-addressed artifact — the behavior sequential callers get.
    const runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    let runtimeB: Runtime | undefined;
    try {
      const txA = runtimeA.edit();
      const compiled = await runtimeA.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { pattern, lift } from 'commonfabric';",
            "const inc = lift((x:number)=>x+1);",
            "export default pattern<{ value: number }>(({ value }) => {",
            "  return { result: inc(value) };",
            "});",
          ].join("\n"),
        }],
      }, { space, tx: txA });
      const { identity: entryIdentity, symbol } = runtimeA.patternManager
        .getArtifactEntryRef(compiled)!;
      // Make the closure durable before runtime B reads it.
      await runtimeA.patternManager.flushCompileCacheWrites();
      await txA.commit();
      await storageManager.synced();

      // Runtime B shares the storage but has cold in-memory indexes, so the
      // three concurrent loads all miss the sync fast paths and race into
      // the single-flight tail.
      runtimeB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const [first, second, third] = await Promise.all([
        runtimeB.patternManager.loadPatternByIdentity(
          entryIdentity,
          symbol,
          space,
        ),
        runtimeB.patternManager.loadPatternByIdentity(
          entryIdentity,
          symbol,
          space,
        ),
        runtimeB.patternManager.loadPatternByIdentity(
          entryIdentity,
          symbol,
          space,
        ),
      ]);
      expect(first).toBeDefined();
      // One artifact, not three: followers resolve from the leader's indexes.
      expect(second).toBe(first);
      expect(third).toBe(first);
    } finally {
      await runtimeB?.dispose();
      await runtimeA.dispose();
      await storageManager.close();
    }
  });
});

describe("PatternManager.loadPatternByIdentity error handling", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

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

  it("returns undefined for a missing identity, not a TypeError", async () => {
    const result = await runtime.patternManager.loadPatternByIdentity(
      "nonexistent-pattern-identity",
      "default",
      space,
    );
    expect(result).toBeUndefined();
  });
});

describe("PatternManager.compileOrGetPattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  const simpleProgram: RuntimeProgram = {
    main: "/main.ts",
    files: [
      {
        name: "/main.ts",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export default pattern<{ x: number }>(({ x }) => ({ doubled: x }));",
        ].join("\n"),
      },
    ],
  };

  const differentProgram: RuntimeProgram = {
    main: "/main.ts",
    files: [
      {
        name: "/main.ts",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export default pattern<{ y: number }>(({ y }) => ({ tripled: y }));",
        ].join("\n"),
      },
    ],
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("compiles and returns a pattern on first call", async () => {
    const pattern = await runtime.patternManager.compileOrGetPattern(
      simpleProgram,
    );
    expect(pattern).toBeDefined();
    expect(getPatternProgram(pattern)).toBeDefined();
    expect(getPatternProgram(pattern)?.main).toEqual("/main.ts");
  });

  it("returns cached pattern on second call (same instance)", async () => {
    const first = await runtime.patternManager.compileOrGetPattern(
      simpleProgram,
    );
    const second = await runtime.patternManager.compileOrGetPattern(
      simpleProgram,
    );

    // Should be the exact same object instance (cache hit)
    expect(second).toBe(first);
  });

  it("compiles different patterns for different programs", async () => {
    const first = await runtime.patternManager.compileOrGetPattern(
      simpleProgram,
    );
    const second = await runtime.patternManager.compileOrGetPattern(
      differentProgram,
    );

    // Should be different pattern instances
    expect(second).not.toBe(first);
    expect(getPatternProgram(first)?.files[0].contents).toContain("doubled");
    expect(getPatternProgram(second)?.files[0].contents).toContain("tripled");
  });

  it("single-flight: concurrent calls share one compilation", async () => {
    // Start multiple compilations concurrently
    const [first, second, third] = await Promise.all([
      runtime.patternManager.compileOrGetPattern(simpleProgram),
      runtime.patternManager.compileOrGetPattern(simpleProgram),
      runtime.patternManager.compileOrGetPattern(simpleProgram),
    ]);

    // All should return the same instance
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("works with string input (single file)", async () => {
    const source = [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ n: number }>(({ n }) => ({ result: n }));",
    ].join("\n");

    const pattern = await runtime.patternManager.compileOrGetPattern(source);
    expect(pattern).toBeDefined();
    expect(getPatternProgram(pattern)?.main).toEqual("/main.tsx");
  });

  it("pattern is cached and returns same instance on subsequent calls", async () => {
    const pattern = await runtime.patternManager.compileOrGetPattern(
      simpleProgram,
    );

    // The pattern should be cached - calling again returns same instance
    const pattern2 = await runtime.patternManager.compileOrGetPattern(
      simpleProgram,
    );
    expect(pattern2).toBe(pattern);

    // And the pattern should have its program attached
    expect(getPatternProgram(pattern)).toBeDefined();
    expect(getPatternProgram(pattern)?.main).toEqual("/main.ts");
  });
});
