import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  entityIdFrom,
  Runtime,
  type URI,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import { parseLink } from "../../runner/src/link-utils.ts";
import { slugIdForSpace } from "../../runner/src/slugs.ts";
import { pieceId } from "../src/piece-id.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import {
  assignSlug,
  listSlugs,
  resolvePieceAddress,
  resolvePieceReference,
  resolveSlugTarget,
  resolveSlugTargetCell,
  setSlugLink,
  SlugResolutionError,
} from "../src/slugs.ts";

const signer = await Identity.fromPassphrase("piece slug tests");

describe("piece slugs", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const session = await createSession({
      identity: signer,
      spaceName: "piece-slugs-" + crypto.randomUUID(),
    });
    pieces = new PiecesController(session, runtime);
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  async function createPiece(cause: string) {
    const { commonfabric } = createBuilder();
    const piecePattern = commonfabric.pattern<{ value: number }>((
      { value },
    ) => ({ value }));
    return await pieces.runPersistent(piecePattern, { value: 1 }, cause);
  }

  function readRootMeta(id: string, key: string): unknown {
    return runtime.readTx().readOrThrow({
      space: pieces.getSpace(),
      id: `of:${id}` as URI,
      scope: "space",
      path: [key],
    });
  }

  it("stores slug metadata and resolves through the slug document redirect", async () => {
    const piece = await createPiece("slug-target");
    const id = pieceId(piece)!;

    await assignSlug(pieces, piece, "demo");

    const slugId = slugIdForSpace(pieces.getSpace(), "demo");
    expect(readRootMeta(id, "slug")).toBe("demo");
    expect(readRootMeta(slugId, "slug")).toBe("demo");
    expect(await resolvePieceAddress(pieces, "demo")).toBe(id);
  });

  it("throws naming the storage failure when the slug transaction is rejected", async () => {
    // A rejected slug transaction must reach the caller. Resolving normally
    // would report a slug that never landed, and the next read would find
    // the name unassigned.
    const piece = await createPiece("slug-rejected");
    const rejection = {
      name: "StorageTransactionAborted",
      message: "storage refused the commit",
      reason: new Error("refused"),
    };
    const originalEditWithRetry = runtime.editWithRetry;
    runtime.editWithRetry =
      (() =>
        Promise.resolve({ error: rejection })) as typeof runtime.editWithRetry;
    let failure: unknown;
    try {
      failure = await setSlugLink(pieces, "rejected", piece).then(
        () => undefined,
        (error: unknown) => error,
      );
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }

    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error;
    expect(error.message).toContain("rejected");
    expect(error.message).toContain("StorageTransactionAborted");
    expect(error.message).toContain("storage refused the commit");
    // The storage rejection stays reachable for a caller that wants to tell
    // a conflict from a refusal.
    expect(error.cause).toBe(rejection);
    // The name is not listed, because the transaction carrying it never
    // committed.
    expect(await listSlugs(pieces)).not.toContain("rejected");
    // The slug document was not written either: resolving the name still
    // reports it missing.
    await expect(resolvePieceAddress(pieces, "rejected")).rejects.toThrow(
      /Slug "rejected" not found/,
    );
  });

  it("lists every assigned slug, once, however many times a name is set", async () => {
    const piece = await createPiece("index-target");
    const other = await createPiece("index-other");

    await assignSlug(pieces, piece, "board");
    await setSlugLink(pieces, "tracker", other);
    // Repointing a name changes where it resolves, never how it is listed.
    await setSlugLink(pieces, "board", other);

    expect(await listSlugs(pieces)).toEqual(["board", "tracker"]);
    expect(await resolvePieceAddress(pieces, "board")).toBe(pieceId(other)!);
  });

  it("lists no slugs for a space that assigned none", async () => {
    expect(await listSlugs(pieces)).toEqual([]);
  });

  it("sets slug redirects to arbitrary cell links", async () => {
    const piece = await createPiece("slug-link-target");
    const slugId = slugIdForSpace(pieces.getSpace(), "value-link");
    const slugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugId),
    );

    await setSlugLink(pieces, "value-link", piece.key("value"));

    await slugCell.sync();
    const link = parseLink(slugCell.getRaw(), slugCell);
    expect(link?.overwrite).toBe("redirect");
    expect(link?.id).toBe(piece.getAsNormalizedFullLink().id);
    expect(link?.path).toEqual(["value"]);
    expect(readRootMeta(slugId, "slug")).toBe("value-link");
    // The index write is unconditional: a slug to a cell path is as much a
    // name the space has as one to a piece root.
    expect(await listSlugs(pieces)).toEqual(["value-link"]);
  });

  it("resolves slug redirects to arbitrary cells without treating them as pieces", async () => {
    const cell = runtime.getCell(
      pieces.getSpace(),
      { space: pieces.getSpace(), random: "slug-cell-target" },
    );
    await runtime.editWithRetry((tx) => {
      cell.withTx(tx).set({ value: 1 });
    });

    await setSlugLink(pieces, "value-link", cell);

    const target = await resolveSlugTargetCell(pieces, "value-link");
    expect(target.getAsNormalizedFullLink().id).toBe(
      cell.getAsNormalizedFullLink().id,
    );
    expect(target.getAsNormalizedFullLink().path).toEqual([]);
    expect(target.get()).toEqual({ value: 1 });

    await expect(resolvePieceAddress(pieces, "value-link")).rejects.toThrow(
      /not a piece/,
    );
  });

  it("can resolve source links before setting a slug redirect", async () => {
    const piece = await createPiece("slug-resolved-link-target");
    await setSlugLink(pieces, "first-link", piece);

    const firstSlugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugIdForSpace(pieces.getSpace(), "first-link")),
    );
    const secondSlugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugIdForSpace(pieces.getSpace(), "second-link")),
    );

    await setSlugLink(pieces, "second-link", firstSlugCell, {
      resolveBeforeLinking: true,
    });

    await secondSlugCell.sync();
    const link = parseLink(secondSlugCell.getRaw(), secondSlugCell);
    expect(link?.overwrite).toBe("redirect");
    expect(link?.id).toBe(piece.getAsNormalizedFullLink().id);
    expect(readRootMeta(pieceId(piece)!, "slug")).toBe("second-link");
  });

  it("stores slug metadata on the fully resolved target", async () => {
    const output = runtime.getCell(
      pieces.getSpace(),
      { space: pieces.getSpace(), random: "slug-final-target" },
    );
    const intermediate = runtime.getCell(
      pieces.getSpace(),
      { space: pieces.getSpace(), random: "slug-intermediate-target" },
    );

    await runtime.editWithRetry((tx) => {
      output.withTx(tx).set({ value: 1 });
      intermediate.withTx(tx).key("child").setRawUntyped(
        output.withTx(tx).getAsWriteRedirectLink({
          base: intermediate.withTx(tx).key("child"),
        }),
      );
    });

    await setSlugLink(pieces, "resolved-target", intermediate.key("child"), {
      writeTargetMetadata: true,
    });

    const slugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugIdForSpace(pieces.getSpace(), "resolved-target")),
    );
    await slugCell.sync();
    const link = parseLink(slugCell.getRaw(), slugCell);
    expect(link?.overwrite).toBe("redirect");
    expect(link?.id).toBe(intermediate.getAsNormalizedFullLink().id);
    expect(link?.path).toEqual(["child"]);
    expect(readRootMeta(
      String(output.getAsNormalizedFullLink().id).replace(/^of:/, ""),
      "slug",
    )).toBe("resolved-target");
  });

  it("preserves resolved slug redirect paths", async () => {
    const piece = await createPiece("slug-resolved-path-target");
    await setSlugLink(pieces, "first-path-link", piece.key("value"));

    const firstSlugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugIdForSpace(pieces.getSpace(), "first-path-link")),
    );
    const secondSlugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugIdForSpace(pieces.getSpace(), "second-path-link")),
    );

    await setSlugLink(pieces, "second-path-link", firstSlugCell, {
      resolveBeforeLinking: true,
    });

    await secondSlugCell.sync();
    const resolvedFirstLink = firstSlugCell.resolveAsCell()
      .getAsNormalizedFullLink();
    const link = parseLink(secondSlugCell.getRaw(), secondSlugCell);
    expect(link?.overwrite).toBe("redirect");
    expect(link?.id).toBe(resolvedFirstLink.id);
    expect(link?.path).toEqual(resolvedFirstLink.path);
  });

  it("preserves URI-shaped piece addresses", async () => {
    expect(await resolvePieceAddress(pieces, "fid1:piece-123")).toBe(
      "fid1:piece-123",
    );
    expect(await resolvePieceAddress(pieces, "of:fid1:piece-123")).toBe(
      "of:fid1:piece-123",
    );
  });

  it("overwrites an existing slug redirect", async () => {
    const first = await createPiece("slug-first");
    const second = await createPiece("slug-second");

    await assignSlug(pieces, first, "demo");
    await assignSlug(pieces, second, "demo");

    expect(await resolvePieceAddress(pieces, "demo")).toBe(pieceId(second));
  });

  it("reports missing and malformed slug documents", async () => {
    await expect(resolvePieceAddress(pieces, "missing")).rejects.toThrow(
      /Slug "missing" not found/,
    );

    const slugId = slugIdForSpace(pieces.getSpace(), "malformed");
    const slugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugId),
    );
    await runtime.editWithRetry((tx) => {
      slugCell.withTx(tx).setRawUntyped("not a redirect");
    });

    await expect(resolvePieceAddress(pieces, "malformed")).rejects.toThrow(
      /does not contain a valid redirect/,
    );
  });

  describe("a slug that names a collection", () => {
    // The members are pieces the controller ran. The board is a document
    // stamped as a piece's, holding its collection at `names` keyed by member
    // name, with one key holding a plain value for a member that is no
    // piece. `top` points at the collection and `one` at the first member.

    let board: Cell<unknown>;
    let boardId: string;
    let item1: Cell<unknown>;
    let item2: Cell<unknown>;

    async function failureOf(work: Promise<unknown>): Promise<unknown> {
      return await work.then(() => undefined, (error: unknown) => error);
    }

    beforeEach(async () => {
      item1 = await createPiece("member-1");
      item2 = await createPiece("member-2");
      board = runtime.getCell(
        pieces.getSpace(),
        { space: pieces.getSpace(), random: "board" },
      );
      await runtime.editWithRetry((tx) => {
        const withTx = board.withTx(tx);
        withTx.set({ names: { "1": item1, "2": item2, "3": { plain: true } } });
        withTx.setMetaRaw(
          "patternIdentity",
          { identity: "pattern-board", symbol: "default" },
          rawMetaWriteAuthorization,
        );
      });
      boardId = pieceId(board)!;
      await setSlugLink(pieces, "top", board.key("names"));
      await assignSlug(pieces, item1, "one");
    });

    describe("resolvePieceReference()", () => {
      it("returns the member the first segment selects, and the rest of the path", async () => {
        expect(await resolvePieceReference(pieces, "top", ["2", "value"]))
          .toEqual({ piece: pieceId(item2), pathAfter: ["value"] });
      });

      it("reads a numeric segment as the member name it denotes", async () => {
        expect(await resolvePieceReference(pieces, "top", [1]))
          .toEqual({ piece: pieceId(item1), pathAfter: [] });
      });

      it("returns the piece and the whole path when the slug names a piece root", async () => {
        expect(await resolvePieceReference(pieces, "one", ["value"]))
          .toEqual({ piece: pieceId(item1), pathAfter: ["value"] });
      });

      it("returns a handle and its path untouched", async () => {
        expect(await resolvePieceReference(pieces, "of:fid1:piece-123", ["x"]))
          .toEqual({ piece: "of:fid1:piece-123", pathAfter: ["x"] });
      });

      it("fails with `missing-member` when the collection holds no such name", async () => {
        const error = await failureOf(
          resolvePieceReference(pieces, "top", ["999"]),
        );
        expect(error).toBeInstanceOf(SlugResolutionError);
        expect((error as SlugResolutionError).code).toBe("missing-member");
        expect((error as Error).message).toBe("no member 999 in top");
      });

      it("fails with `inside-piece` naming the containing piece when no member follows the collection's name", async () => {
        for (
          const work of [
            resolvePieceReference(pieces, "top", []),
            resolvePieceAddress(pieces, "top"),
          ]
        ) {
          const error = await failureOf(work);
          expect(error).toBeInstanceOf(SlugResolutionError);
          expect((error as SlugResolutionError).code).toBe("inside-piece");
          expect((error as Error).message).toContain(
            `inside piece ${boardId}`,
          );
          expect((error as Error).message).toContain("top/<name>");
        }
      });

      it("fails with `not-piece` when the member holds no piece", async () => {
        const error = await failureOf(
          resolvePieceReference(pieces, "top", ["3"]),
        );
        expect(error).toBeInstanceOf(SlugResolutionError);
        expect((error as SlugResolutionError).code).toBe("not-piece");
        expect((error as Error).message).toMatch(
          /"top\/3" does not name a piece/,
        );
      });
    });

    describe("resolveSlugTarget()", () => {
      it("returns the containing piece and the path for a slug into a piece", async () => {
        expect(await resolveSlugTarget(pieces, "top"))
          .toEqual({ piece: boardId, pathInside: ["names"] });
      });

      it("returns an empty path for a slug that names a piece", async () => {
        expect(await resolveSlugTarget(pieces, "one"))
          .toEqual({ piece: pieceId(item1), pathInside: [] });
      });

      it("fails with `not-piece` for a slug to a plain document", async () => {
        const plain = runtime.getCell(
          pieces.getSpace(),
          { space: pieces.getSpace(), random: "plain" },
        );
        await runtime.editWithRetry((tx) => {
          plain.withTx(tx).set({ value: 1 });
        });
        await setSlugLink(pieces, "plain", plain);

        const error = await failureOf(resolveSlugTarget(pieces, "plain"));
        expect(error).toBeInstanceOf(SlugResolutionError);
        expect((error as SlugResolutionError).code).toBe("not-piece");
      });
    });
  });
});
