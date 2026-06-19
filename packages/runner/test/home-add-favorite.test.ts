import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("home add-favorite tests");
const space = signer.did();

type FavoriteEntry = { tags?: string[]; tag?: string; userTags?: string[] };

// Compiles and runs the real home pattern, then drives its addFavorite handler
// the way the runtime client does after deriving tags: it sends the tags as
// data, and the handler just stores them.
describe("home addFavorite handler", () => {
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

  it("stores the discovery tags it is given", async () => {
    const patternsRoot = join(import.meta.dirname!, "..", "..", "patterns");
    const program = await runtime.harness.resolve(
      new FileSystemProgramResolver(
        join(patternsRoot, "system", "home.tsx"),
        patternsRoot,
      ),
    );
    const homePattern = await runtime.patternManager.compilePattern(program, {
      space,
    });

    const resultCell = runtime.getCell(space, "home-instance");
    const home = await runtime.runSynced(resultCell, homePattern, {});
    await home.pull();
    await runtime.idle();

    const target = runtime.getCell(space, "favorited-piece", undefined, tx);
    target.set({ content: "x" });
    await tx.commit();
    tx = runtime.edit();

    // deno-lint-ignore no-explicit-any
    (home.key("addFavorite") as any).send({
      piece: target.getAsLink(),
      tags: ["alpha", "beta"],
      spaceName: "test-space",
    });

    let favorites: FavoriteEntry[] = [];
    for (let i = 0; i < 50; i++) {
      await runtime.idle();
      favorites =
        (home.key("favorites").get() as FavoriteEntry[] | undefined) ?? [];
      if (favorites.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(favorites.length).toBe(1);
    expect(favorites[0].tags).toEqual(["alpha", "beta"]);
    expect(favorites[0].userTags).toEqual([]);
  });
});
