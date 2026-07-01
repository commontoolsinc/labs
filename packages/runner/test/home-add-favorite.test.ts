import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { favoriteKey } from "@commonfabric/home-schemas";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { Cell } from "../src/cell.ts";

const signer = await Identity.fromPassphrase("home add-favorite tests");
const space = signer.did();

type FavoriteEntry = {
  tags?: string[];
  tag?: string;
  userTags?: string[];
  id?: string;
};

// Compiles and runs the real home pattern, then drives its addFavorite /
// removeFavorite handlers the way the runtime client does: it derives the
// piece's stable key and the discovery tags as data, and the handlers key the
// favorite entity by that id.
describe("home favorites handlers", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  // deno-lint-ignore no-explicit-any
  let home: any;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

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
    home = await runtime.runSynced(resultCell, homePattern, {});
    await home.pull();
    await runtime.idle();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  // Create a piece cell and return the (link, id) a client would send for it.
  function makePiece(cause: string): { piece: unknown; id: string } {
    const target = runtime.getCell(space, cause, undefined, tx) as Cell<
      unknown
    >;
    target.set({ content: cause });
    const id = favoriteKey(target.getAsNormalizedFullLink());
    return { piece: target.getAsLink(), id };
  }

  async function readFavorites(): Promise<FavoriteEntry[]> {
    let favorites: FavoriteEntry[] = [];
    for (let i = 0; i < 50; i++) {
      await runtime.idle();
      favorites =
        (home.key("favorites").get() as FavoriteEntry[] | undefined) ?? [];
      if (favorites.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return favorites;
  }

  it("stores the discovery tags it is given", async () => {
    const { piece, id } = makePiece("favorited-piece");
    await tx.commit();
    tx = runtime.edit();

    home.key("addFavorite").send({
      piece,
      tags: ["alpha", "beta"],
      spaceName: "test-space",
      id,
    });

    const favorites = await readFavorites();
    expect(favorites.length).toBe(1);
    expect(favorites[0].tags).toEqual(["alpha", "beta"]);
    expect(favorites[0].userTags).toEqual([]);
    expect(favorites[0].id).toBe(id);
  });

  it("dedups a re-favorite and removes by piece identity", async () => {
    const { piece, id } = makePiece("favorited-piece");
    await tx.commit();
    tx = runtime.edit();

    home.key("addFavorite").send({ piece, tags: ["one"], id });
    expect((await readFavorites()).length).toBe(1);

    // Re-favoriting the same piece resolves to the same key — no duplicate.
    home.key("addFavorite").send({ piece, tags: ["one"], id });
    for (let i = 0; i < 10; i++) await runtime.idle();
    expect(
      (home.key("favorites").get() as FavoriteEntry[] | undefined)?.length,
    ).toBe(1);

    // Unfavoriting removes the membership entry by identity.
    home.key("removeFavorite").send({ piece, id });
    for (let i = 0; i < 20; i++) {
      await runtime.idle();
      const favorites =
        (home.key("favorites").get() as FavoriteEntry[] | undefined) ?? [];
      if (favorites.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(
      (home.key("favorites").get() as FavoriteEntry[] | undefined) ?? [],
    ).toEqual([]);
  });
});
