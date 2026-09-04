import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  entityIdFrom,
  Runtime,
  slugIdForSpace,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { RequestType } from "@/protocol/mod.ts";
import { RuntimeProcessor } from "@/backends/runtime-processor.ts";

// The handler's own job is choosing how to read a reference and reporting
// what it reached; the walk it delegates to is covered in
// packages/runner/test/slug-resolution.test.ts. So the fixture here is the
// smallest thing that reference resolution reads: documents stamped with a
// `patternIdentity`, which is what makes a document a piece, and a board
// holding its members at `names`. Nothing runs.

const signer = await Identity.fromPassphrase("runtime-client slug resolve");
const space = signer.did();

describe("handleSlugResolve()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let board: Cell<unknown>;
  let item2: Cell<unknown>;

  /** A document that reads as a piece, holding `content`. */
  async function pieceDocument(
    cause: string,
    content: unknown,
  ): Promise<Cell<unknown>> {
    const cell = runtime.getCell(space, { space, random: cause });
    await runtime.editWithRetry((tx) => {
      const withTx = cell.withTx(tx);
      withTx.set(content);
      withTx.setMetaRaw(
        "patternIdentity",
        { identity: `pattern-${cause}`, symbol: "default" },
        rawMetaWriteAuthorization,
      );
    });
    return cell;
  }

  /** Bind `slug` to `target` the way `set-slug` does. */
  async function pointSlug(slug: string, target: Cell<unknown>): Promise<void> {
    const slugCell = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, slug)),
    );
    await runtime.editWithRetry((tx) => {
      const slugWithTx = slugCell.withTx(tx);
      slugWithTx.setRawUntyped(
        target.withTx(tx).getAsWriteRedirectLink({ base: slugWithTx }),
      );
    });
  }

  /** Call the handler over a processor that is nothing but this space. */
  function resolve(
    slug: string,
    member?: string,
  ): Promise<{ piece: { cell: unknown } }> {
    const processor = {
      getSpaceCtx: () => ({ getSpace: () => space }),
      runtime,
    };
    return (RuntimeProcessor.prototype as unknown as {
      handleSlugResolve(
        this: unknown,
        request: unknown,
      ): Promise<{ piece: { cell: unknown } }>;
    }).handleSlugResolve.call(processor, {
      type: RequestType.SlugResolve,
      space,
      slug,
      member,
    });
  }

  function idOf(cell: Cell<unknown>): string {
    return cell.getAsNormalizedFullLink().id;
  }

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const item1 = await pieceDocument("item-1", { title: "Glaze recipes" });
    item2 = await pieceDocument("item-2", { title: "Oven schedule" });
    board = await pieceDocument("board", { names: { "1": item1, "2": item2 } });
    await pointSlug("board", board);
    await pointSlug("top", board.key("names"));
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("answers with the member a reference names", async () => {
    const response = await resolve("top", "2");
    expect(response).toEqual({
      piece: { cell: { id: idOf(item2), space, scope: "space", path: [] } },
    });
  });

  it("answers with the piece that holds a collection named alone", async () => {
    // The runner refuses `top` with no member, naming the piece the
    // collection sits in. A page URL names a piece to render, so that piece
    // is what the shell opens — at its root, not at the collection.
    const response = await resolve("top");
    expect(response).toEqual({
      piece: { cell: { id: idOf(board), space, scope: "space", path: [] } },
    });
  });

  it("answers with the piece a slug names at its root", async () => {
    const response = await resolve("board");
    expect(response).toEqual({
      piece: { cell: { id: idOf(board), space, scope: "space", path: [] } },
    });
  });

  it("refuses a member the collection does not hold, naming both", async () => {
    await expect(resolve("top", "999")).rejects.toThrow(
      "no member 999 in top",
    );
  });
});
