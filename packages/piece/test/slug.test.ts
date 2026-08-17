import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type CommitError,
  entityIdFrom,
  Runtime,
  type URI,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import { parseLink } from "../../runner/src/link-utils.ts";
import { slugIdForSpace } from "../../runner/src/slugs.ts";
import { pieceId } from "../src/piece-id.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import {
  assignSlug,
  releaseSlug,
  resolvePieceAddress,
  resolveSlugTargetCell,
  setSlugLink,
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

  function slugCellFor(slug: string) {
    return runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugIdForSpace(pieces.getSpace(), slug)),
    );
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

  it("clears an assigned slug back to not found", async () => {
    const piece = await createPiece("slug-release-target");
    await assignSlug(pieces, piece, "demo");
    // The assignment really landed, so the rejection below is a clear rather
    // than a name that was never taken.
    expect(await resolvePieceAddress(pieces, "demo")).toBe(pieceId(piece));

    await releaseSlug(pieces, "demo", piece);

    await expect(resolvePieceAddress(pieces, "demo")).rejects.toThrow(
      /Slug "demo" not found/,
    );
  });

  it("leaves a slug that now redirects elsewhere alone", async () => {
    const first = await createPiece("slug-release-first");
    const second = await createPiece("slug-release-second");
    await assignSlug(pieces, first, "demo");
    await assignSlug(pieces, second, "demo");

    await releaseSlug(pieces, "demo", first);

    expect(await resolvePieceAddress(pieces, "demo")).toBe(pieceId(second));
  });

  it("returns `undefined` as the replaced value for a name that held nothing", async () => {
    const piece = await createPiece("slug-replaced-free");

    const assignment = await assignSlug(pieces, piece, "demo");

    expect(assignment.replaced).toBe(undefined);
  });

  it("returns the redirect it overwrote as the replaced value", async () => {
    const first = await createPiece("slug-replaced-first");
    const second = await createPiece("slug-replaced-second");
    await assignSlug(pieces, first, "demo");
    const heldByFirst = slugCellFor("demo").getRawUntyped();

    const assignment = await assignSlug(pieces, second, "demo");

    expect(assignment.replaced).toEqual(heldByFirst);
  });

  it("clears the slug when released with what an assignment to a free name replaced", async () => {
    const piece = await createPiece("slug-restore-free");
    const assignment = await assignSlug(pieces, piece, "demo");
    // The assignment really landed, so the rejection below is a clear rather
    // than a name that was never taken.
    expect(await resolvePieceAddress(pieces, "demo")).toBe(pieceId(piece));

    await releaseSlug(pieces, "demo", piece, {
      restore: assignment.replaced,
    });

    await expect(resolvePieceAddress(pieces, "demo")).rejects.toThrow(
      /Slug "demo" not found/,
    );
  });

  it("restores another writer's redirect when released with what the assignment replaced", async () => {
    const other = await createPiece("slug-restore-other");
    const ours = await createPiece("slug-restore-ours");
    // The name is taken between the availability check and the assignment,
    // so the assignment below overwrites an address that is not its own.
    await assignSlug(pieces, other, "demo");
    const heldByOther = slugCellFor("demo").getRawUntyped();

    const assignment = await assignSlug(pieces, ours, "demo");
    // The clobber really happened, so the restore below gives something back
    // rather than reinstating a redirect that was never displaced.
    expect(await resolvePieceAddress(pieces, "demo")).toBe(pieceId(ours));

    await releaseSlug(pieces, "demo", ours, { restore: assignment.replaced });

    expect(slugCellFor("demo").getRawUntyped()).toEqual(heldByOther);
    expect(await resolvePieceAddress(pieces, "demo")).toBe(pieceId(other));
  });

  it("leaves a same-target link that is not a write redirect alone", async () => {
    const piece = await createPiece("slug-release-plain-link");
    const slugCell = slugCellFor("demo");
    // A plain link points where this piece's redirect would point, so the
    // release is decided by the shape of the link rather than its target.
    await runtime.editWithRetry((tx) => {
      const slugWithTx = slugCell.withTx(tx);
      slugWithTx.setRawUntyped(
        piece.withTx(tx).getAsLink({ base: slugWithTx }),
      );
    });
    const planted = slugCell.getRawUntyped();

    await releaseSlug(pieces, "demo", piece);

    expect(slugCell.getRawUntyped()).toEqual(planted);
  });

  it("returns the error when the clear's commit is rejected", async () => {
    const piece = await createPiece("slug-release-rejected");
    await assignSlug(pieces, piece, "demo");

    const rejection: CommitError = {
      name: "StorageTransactionAborted",
      message: "commit refused",
      reason: undefined,
    };
    const originalEdit = runtime.editWithRetry.bind(runtime);
    runtime.editWithRetry = (() =>
      Promise.resolve({
        ok: undefined,
        error: rejection,
      })) as Runtime["editWithRetry"];
    let released: Awaited<ReturnType<typeof releaseSlug>>;
    try {
      released = await releaseSlug(pieces, "demo", piece);
    } finally {
      runtime.editWithRetry = originalEdit;
    }

    expect(released.error?.message).toBe("commit refused");
    // And the name really is still assigned, which is what a caller trusting
    // a silent resolution would have been wrong about.
    expect(await resolvePieceAddress(pieces, "demo")).toBe(pieceId(piece));
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
});
