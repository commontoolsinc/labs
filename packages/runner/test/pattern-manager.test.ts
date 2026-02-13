import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

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

  it("compiles multi-file program, attaches program, saves and reloads by id", async () => {
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
            "import { pattern, lift } from 'commontools';",
            "import { double } from './util.ts';",
            "const dbl = lift((x:number)=>double(x));",
            "export default pattern<{ value: number }>('Test', ({ value }) => {",
            "  return { result: dbl(value) };",
            "});",
          ].join("\n"),
        },
      ],
    };

    const compiled = await runtime.patternManager.compilePattern(program);
    expect(compiled.program).toBeDefined();
    expect(compiled.program?.main).toEqual("/main.tsx");
    // Ensure original file names are preserved (no injected prefix leaked here)
    const fileNames = (compiled.program?.files ?? []).map((f) => f.name).sort();
    expect(fileNames).toEqual(["/main.tsx", "/util.ts"].sort());

    const patternId = runtime.patternManager.registerPattern(compiled, program);
    await runtime.patternManager.saveAndSyncPattern({ patternId, space });

    const meta = runtime.patternManager.getPatternMeta({ patternId });
    expect(meta.id).toEqual(patternId);
    expect(meta.program).toBeDefined();
    expect(meta.program?.main).toEqual("/main.tsx");
    const metaFileNames = (meta.program?.files ?? []).map((f) => f.name).sort();
    expect(metaFileNames).toEqual(["/main.tsx", "/util.ts"].sort());

    // Verify we can re-load and run the saved pattern
    const loaded = await runtime.patternManager.loadPattern(patternId, space, tx);
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "pattern-manager: run loaded",
      undefined,
      tx,
    );
    const result = runtime.run(tx, loaded, { value: 3 }, resultCell);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();
    expect(result.getAsQueryResult()).toEqual({ result: 6 });
  });

  it("register/save idempotency: saving same pattern id twice is harmless", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "import { pattern } from 'commontools';",
            "export default pattern<{ x: number }>('Idempotent', ({ x }) => ({ x }));",
          ].join("\n"),
        },
      ],
    };

    const compiled = await runtime.patternManager.compilePattern(program);
    const patternId = runtime.patternManager.registerPattern(compiled, program);
    const first = runtime.patternManager.savePattern({ patternId, space });
    const second = runtime.patternManager.savePattern({ patternId, space });
    expect(first).toBe(true);
    expect(second).toBe(true);

    const meta = runtime.patternManager.getPatternMeta({ patternId });
    expect(meta.program?.main).toEqual("/main.ts");
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
          "import { pattern } from 'commontools';",
          "export default pattern<{ x: number }>('Cached', ({ x }) => ({ doubled: x }));",
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
          "import { pattern } from 'commontools';",
          "export default pattern<{ y: number }>('Different', ({ y }) => ({ tripled: y }));",
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
    expect(pattern.program).toBeDefined();
    expect(pattern.program?.main).toEqual("/main.ts");
  });

  it("returns cached pattern on second call (same instance)", async () => {
    const first = await runtime.patternManager.compileOrGetPattern(simpleProgram);
    const second = await runtime.patternManager.compileOrGetPattern(
      simpleProgram,
    );

    // Should be the exact same object instance (cache hit)
    expect(second).toBe(first);
  });

  it("compiles different patterns for different programs", async () => {
    const first = await runtime.patternManager.compileOrGetPattern(simpleProgram);
    const second = await runtime.patternManager.compileOrGetPattern(
      differentProgram,
    );

    // Should be different pattern instances
    expect(second).not.toBe(first);
    expect(first.program?.files[0].contents).toContain("doubled");
    expect(second.program?.files[0].contents).toContain("tripled");
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
      "import { pattern } from 'commontools';",
      "export default pattern<{ n: number }>('FromString', ({ n }) => ({ result: n }));",
    ].join("\n");

    const pattern = await runtime.patternManager.compileOrGetPattern(source);
    expect(pattern).toBeDefined();
    expect(pattern.program?.main).toEqual("/main.tsx");
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
    expect(pattern.program).toBeDefined();
    expect(pattern.program?.main).toEqual("/main.ts");
  });
});
