import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime, type URI } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import { parseLink } from "../../runner/src/link-utils.ts";
import { slugIdForSpace } from "../../runner/src/slugs.ts";
import { pieceId, PieceManager } from "../src/manager.ts";
import { assignSlug, resolvePieceAddress, setSlugLink } from "../src/slugs.ts";

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
    const slugCell = runtime.getCellFromEntityId(manager.getSpace(), {
      "/": slugId,
    });

    await setSlugLink(manager, "value-link", piece.key("value"));

    await slugCell.sync();
    const link = parseLink(slugCell.getRaw(), slugCell);
    expect(link?.overwrite).toBe("redirect");
    expect(link?.id).toBe(piece.getAsNormalizedFullLink().id);
    expect(link?.path).toEqual(["value"]);
    expect(readRootMeta(slugId, "slug")).toBe("value-link");
  });

  it("can resolve source links before setting a slug redirect", async () => {
    const piece = await createPiece("slug-resolved-link-target");
    await setSlugLink(manager, "first-link", piece);

    const firstSlugCell = runtime.getCellFromEntityId(manager.getSpace(), {
      "/": slugIdForSpace(manager.getSpace(), "first-link"),
    });
    const secondSlugCell = runtime.getCellFromEntityId(manager.getSpace(), {
      "/": slugIdForSpace(manager.getSpace(), "second-link"),
    });

    await setSlugLink(manager, "second-link", firstSlugCell, {
      resolveBeforeLinking: true,
    });

    await secondSlugCell.sync();
    const link = parseLink(secondSlugCell.getRaw(), secondSlugCell);
    expect(link?.overwrite).toBe("redirect");
    expect(link?.id).toBe(piece.getAsNormalizedFullLink().id);
  });

  it("preserves resolved slug redirect paths", async () => {
    const piece = await createPiece("slug-resolved-path-target");
    await setSlugLink(manager, "first-path-link", piece.key("value"));

    const firstSlugCell = runtime.getCellFromEntityId(manager.getSpace(), {
      "/": slugIdForSpace(manager.getSpace(), "first-path-link"),
    });
    const secondSlugCell = runtime.getCellFromEntityId(manager.getSpace(), {
      "/": slugIdForSpace(manager.getSpace(), "second-path-link"),
    });

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
    const slugCell = runtime.getCellFromEntityId(manager.getSpace(), {
      "/": slugId,
    });
    await runtime.editWithRetry((tx) => {
      slugCell.withTx(tx).setRawUntyped("not a redirect");
    });

    await expect(resolvePieceAddress(manager, "malformed")).rejects.toThrow(
      /does not contain a valid redirect/,
    );
  });
});
