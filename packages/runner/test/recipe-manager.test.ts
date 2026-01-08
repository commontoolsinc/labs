import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("RecipeManager program persistence", () => {
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
            "import { recipe, lift } from 'commontools';",
            "import { double } from './util.ts';",
            "export default recipe<{ value: number }>('Test', ({ value }) => {",
            "  const dbl = lift((x:number)=>double(x))(value);",
            "  return { result: dbl };",
            "});",
          ].join("\n"),
        },
      ],
    };

    const compiled = await runtime.recipeManager.compileRecipe(program);
    expect(compiled.program).toBeDefined();
    expect(compiled.program?.main).toEqual("/main.tsx");
    // Ensure original file names are preserved (no injected prefix leaked here)
    const fileNames = (compiled.program?.files ?? []).map((f) => f.name).sort();
    expect(fileNames).toEqual(["/main.tsx", "/util.ts"].sort());

    const recipeId = runtime.recipeManager.registerRecipe(compiled, program);
    await runtime.recipeManager.saveAndSyncRecipe({ recipeId, space });

    const meta = runtime.recipeManager.getRecipeMeta({ recipeId });
    expect(meta.id).toEqual(recipeId);
    expect(meta.program).toBeDefined();
    expect(meta.program?.main).toEqual("/main.tsx");
    const metaFileNames = (meta.program?.files ?? []).map((f) => f.name).sort();
    expect(metaFileNames).toEqual(["/main.tsx", "/util.ts"].sort());

    // Verify we can re-load and run the saved recipe
    const loaded = await runtime.recipeManager.loadRecipe(recipeId, space, tx);
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "recipe-manager: run loaded",
      undefined,
      tx,
    );
    const result = runtime.run(tx, loaded, { value: 3 }, resultCell);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();
    expect(result.getAsQueryResult()).toEqual({ result: 6 });
  });

  it("register/save idempotency: saving same recipe id twice is harmless", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "import { recipe } from 'commontools';",
            "export default recipe<{ x: number }>('Idempotent', ({ x }) => ({ x }));",
          ].join("\n"),
        },
      ],
    };

    const compiled = await runtime.recipeManager.compileRecipe(program);
    const recipeId = runtime.recipeManager.registerRecipe(compiled, program);
    const first = runtime.recipeManager.saveRecipe({ recipeId, space });
    const second = runtime.recipeManager.saveRecipe({ recipeId, space });
    expect(first).toBe(true);
    expect(second).toBe(true);

    const meta = runtime.recipeManager.getRecipeMeta({ recipeId });
    expect(meta.program?.main).toEqual("/main.ts");
  });
});

describe("RecipeManager.compileOrGetRecipe", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  const simpleProgram: RuntimeProgram = {
    main: "/main.ts",
    files: [
      {
        name: "/main.ts",
        contents: [
          "import { recipe } from 'commontools';",
          "export default recipe<{ x: number }>('Cached', ({ x }) => ({ doubled: x }));",
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
          "import { recipe } from 'commontools';",
          "export default recipe<{ y: number }>('Different', ({ y }) => ({ tripled: y }));",
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

  it("compiles and returns a recipe on first call", async () => {
    const recipe = await runtime.recipeManager.compileOrGetRecipe(
      simpleProgram,
    );
    expect(recipe).toBeDefined();
    expect(recipe.program).toBeDefined();
    expect(recipe.program?.main).toEqual("/main.ts");
  });

  it("returns cached recipe on second call (same instance)", async () => {
    const first = await runtime.recipeManager.compileOrGetRecipe(simpleProgram);
    const second = await runtime.recipeManager.compileOrGetRecipe(
      simpleProgram,
    );

    // Should be the exact same object instance (cache hit)
    expect(second).toBe(first);
  });

  it("compiles different recipes for different programs", async () => {
    const first = await runtime.recipeManager.compileOrGetRecipe(simpleProgram);
    const second = await runtime.recipeManager.compileOrGetRecipe(
      differentProgram,
    );

    // Should be different recipe instances
    expect(second).not.toBe(first);
    expect(first.program?.files[0].contents).toContain("doubled");
    expect(second.program?.files[0].contents).toContain("tripled");
  });

  it("single-flight: concurrent calls share one compilation", async () => {
    // Start multiple compilations concurrently
    const [first, second, third] = await Promise.all([
      runtime.recipeManager.compileOrGetRecipe(simpleProgram),
      runtime.recipeManager.compileOrGetRecipe(simpleProgram),
      runtime.recipeManager.compileOrGetRecipe(simpleProgram),
    ]);

    // All should return the same instance
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("works with string input (single file)", async () => {
    const source = [
      "import { recipe } from 'commontools';",
      "export default recipe<{ n: number }>('FromString', ({ n }) => ({ result: n }));",
    ].join("\n");

    const recipe = await runtime.recipeManager.compileOrGetRecipe(source);
    expect(recipe).toBeDefined();
    expect(recipe.program?.main).toEqual("/main.tsx");
  });

  it("recipe is cached and returns same instance on subsequent calls", async () => {
    const recipe = await runtime.recipeManager.compileOrGetRecipe(
      simpleProgram,
    );

    // The recipe should be cached - calling again returns same instance
    const recipe2 = await runtime.recipeManager.compileOrGetRecipe(
      simpleProgram,
    );
    expect(recipe2).toBe(recipe);

    // And the recipe should have its program attached
    expect(recipe.program).toBeDefined();
    expect(recipe.program?.main).toEqual("/main.ts");
  });
});
