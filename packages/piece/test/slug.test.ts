import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { entityIdFrom, Runtime, type URI } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import { parseLink } from "../../runner/src/link-utils.ts";
import { slugIdForSpace } from "../../runner/src/slugs.ts";
import { pieceId, PieceManager } from "../src/manager.ts";
import {
  assignSlug,
  resolvePieceAddress,
  resolveSlugTargetCell,
  setSlugLink,
} from "../src/slugs.ts";

const signer = await Identity.fromPassphrase("piece slug tests");

describe("piece slugs", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;

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
    manager = new PieceManager(session, runtime);
    await manager.synced();
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
    return await manager.runPersistent(piecePattern, { value: 1 }, cause);
  }

  function readRootMeta(id: string, key: string): unknown {
    return runtime.readTx().readOrThrow({
      space: manager.getSpace(),
      id: `of:${id}` as URI,
      scope: "space",
      path: [key],
    });
  }

  it("stores slug metadata and resolves through the slug document redirect", async () => {
    const piece = await createPiece("slug-target");
    const id = pieceId(piece)!;

    await assignSlug(manager, piece, "demo");

    const slugId = slugIdForSpace(manager.getSpace(), "demo");
    expect(readRootMeta(id, "slug")).toBe("demo");
    expect(readRootMeta(slugId, "slug")).toBe("demo");
    expect(await resolvePieceAddress(manager, "demo")).toBe(id);
  });

  it("sets slug redirects to arbitrary cell links", async () => {
    const piece = await createPiece("slug-link-target");
    const slugId = slugIdForSpace(manager.getSpace(), "value-link");
    const slugCell = runtime.getCellFromEntityId(
      manager.getSpace(),
      entityIdFrom(slugId),
    );

    await setSlugLink(manager, "value-link", piece.key("value"));

    await slugCell.sync();
    const link = parseLink(slugCell.getRaw(), slugCell);
    expect(link?.overwrite).toBe("redirect");
    expect(link?.id).toBe(piece.getAsNormalizedFullLink().id);
    expect(link?.path).toEqual(["value"]);
    expect(readRootMeta(slugId, "slug")).toBe("value-link");
  });

  it("resolves slug redirects to arbitrary cells without treating them as pieces", async () => {
    const cell = runtime.getCell(
      manager.getSpace(),
      { space: manager.getSpace(), random: "slug-cell-target" },
    );
    await runtime.editWithRetry((tx) => {
      cell.withTx(tx).set({ value: 1 });
    });

    await setSlugLink(manager, "value-link", cell);

    const target = await resolveSlugTargetCell(manager, "value-link");
    expect(target.getAsNormalizedFullLink().id).toBe(
      cell.getAsNormalizedFullLink().id,
    );
    expect(target.getAsNormalizedFullLink().path).toEqual([]);
    expect(target.get()).toEqual({ value: 1 });

    await expect(resolvePieceAddress(manager, "value-link")).rejects.toThrow(
      /not a piece/,
    );
  });

  it("can resolve source links before setting a slug redirect", async () => {
    const piece = await createPiece("slug-resolved-link-target");
    await setSlugLink(manager, "first-link", piece);

    const firstSlugCell = runtime.getCellFromEntityId(
      manager.getSpace(),
      entityIdFrom(slugIdForSpace(manager.getSpace(), "first-link")),
    );
    const secondSlugCell = runtime.getCellFromEntityId(
      manager.getSpace(),
      entityIdFrom(slugIdForSpace(manager.getSpace(), "second-link")),
    );

    await setSlugLink(manager, "second-link", firstSlugCell, {
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
      manager.getSpace(),
      { space: manager.getSpace(), random: "slug-final-target" },
    );
    const intermediate = runtime.getCell(
      manager.getSpace(),
      { space: manager.getSpace(), random: "slug-intermediate-target" },
    );

    await runtime.editWithRetry((tx) => {
      output.withTx(tx).set({ value: 1 });
      intermediate.withTx(tx).key("child").setRawUntyped(
        output.withTx(tx).getAsWriteRedirectLink({
          base: intermediate.withTx(tx).key("child"),
        }),
      );
    });

    await setSlugLink(manager, "resolved-target", intermediate.key("child"), {
      writeTargetMetadata: true,
    });

    const slugCell = runtime.getCellFromEntityId(
      manager.getSpace(),
      entityIdFrom(slugIdForSpace(manager.getSpace(), "resolved-target")),
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
    await setSlugLink(manager, "first-path-link", piece.key("value"));

    const firstSlugCell = runtime.getCellFromEntityId(
      manager.getSpace(),
      entityIdFrom(slugIdForSpace(manager.getSpace(), "first-path-link")),
    );
    const secondSlugCell = runtime.getCellFromEntityId(
      manager.getSpace(),
      entityIdFrom(slugIdForSpace(manager.getSpace(), "second-path-link")),
    );

    await setSlugLink(manager, "second-path-link", firstSlugCell, {
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
    expect(await resolvePieceAddress(manager, "fid1:piece-123")).toBe(
      "fid1:piece-123",
    );
    expect(await resolvePieceAddress(manager, "of:fid1:piece-123")).toBe(
      "of:fid1:piece-123",
    );
  });

  it("overwrites an existing slug redirect", async () => {
    const first = await createPiece("slug-first");
    const second = await createPiece("slug-second");

    await assignSlug(manager, first, "demo");
    await assignSlug(manager, second, "demo");

    expect(await resolvePieceAddress(manager, "demo")).toBe(pieceId(second));
  });

  it("reports missing and malformed slug documents", async () => {
    await expect(resolvePieceAddress(manager, "missing")).rejects.toThrow(
      /Slug "missing" not found/,
    );

    const slugId = slugIdForSpace(manager.getSpace(), "malformed");
    const slugCell = runtime.getCellFromEntityId(
      manager.getSpace(),
      entityIdFrom(slugId),
    );
    await runtime.editWithRetry((tx) => {
      slugCell.withTx(tx).setRawUntyped("not a redirect");
    });

    await expect(resolvePieceAddress(manager, "malformed")).rejects.toThrow(
      /does not contain a valid redirect/,
    );
  });
});
