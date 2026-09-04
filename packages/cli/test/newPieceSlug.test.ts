/**
 * `cf piece new --slug`'s naming step over a real runtime: the second door
 * into slug assignment, which refuses a name that already points somewhere
 * and takes it under `--force`. The piece itself is made ahead of the call
 * and handed back by a `create` that stands in for compiling one, so what is
 * exercised is the naming rather than the build.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { pieceId, resolvePieceAddress } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { type Cell, createBuilder, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { newPiece } from "../lib/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";
import { captureStderr } from "./utils.ts";

const CONFIG = {
  apiUrl: "https://cf.dev",
  space: "collection-naming",
  identity: "~/.my.key",
};

describe("newPiece() naming", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    resetWriteReceipts();
    const signer = await Identity.fromPassphrase("cli piece new slug tests");
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    pieces = new PiecesController(
      await createSession({ identity: signer, spaceName: "cli-piece-new" }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** A started piece in the space, which a `create` below answers with. */
  async function makePiece(cause: string): Promise<Cell<unknown>> {
    const { commonfabric } = createBuilder();
    const pattern = commonfabric.pattern<{ value: number }>((
      { value },
    ) => ({ value }));
    return await pieces.runPersistent(pattern, { value: 1 }, cause);
  }

  /**
   * Runs `newPiece()` against the real space with the naming step reaching
   * real storage. The three members either side of it stand in: `create`
   * answers with `piece` rather than compiling one, and the registry pair
   * belongs to the space's default pattern rather than to the name.
   */
  async function createWithSlug(
    piece: Cell<unknown>,
    slug: string,
    options?: { force?: boolean },
  ): Promise<void> {
    // A proxy rather than a prototype override: the controller reads its own
    // `#private` fields, which only resolve when `this` is the instance
    // itself, so every member but `create` is forwarded bound to it.
    const controller = new Proxy(pieces, {
      get(target, property) {
        if (property === "create") {
          return () =>
            Promise.resolve({ id: pieceId(piece)!, getCell: () => piece });
        }
        if (property === "ensureDefaultPattern" || property === "add") {
          return () => Promise.resolve();
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await captureStderr(async () => {
      await newPiece(
        CONFIG,
        { mainPath: "/repo/main.tsx" },
        { slug, ...options },
        {
          loadPieces: () => Promise.resolve(controller),
          getPinnedProgramFromFile: () => Promise.resolve({} as never),
        },
      );
    });
  }

  it("names the new piece when the slug points nowhere", async () => {
    const piece = await makePiece("new-free");

    await createWithSlug(piece, "notes");

    expect(await resolvePieceAddress(pieces, "notes")).toBe(pieceId(piece));
  });

  it("refuses a slug that already points somewhere, naming it and the flag that takes it", async () => {
    const held = await makePiece("new-held");
    const taking = await makePiece("new-taking");
    await createWithSlug(held, "notes");

    const failure = await createWithSlug(taking, "notes").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(`/${held.getAsNormalizedFullLink().id}`);
    expect(message).toContain("--force");
    // The piece was created before the naming step, so the refusal hands
    // back the id an operator needs to name it another way.
    expect(message).toContain(pieceId(taking)!);
    // The name still points at the piece that held it, not at the one the
    // refused run created.
    expect(await resolvePieceAddress(pieces, "notes")).toBe(pieceId(held));
  });

  it("takes a slug that already points somewhere when forced", async () => {
    const held = await makePiece("new-held");
    const taking = await makePiece("new-taking");
    await createWithSlug(held, "notes");

    await createWithSlug(taking, "notes", { force: true });

    expect(await resolvePieceAddress(pieces, "notes")).toBe(pieceId(taking));
  });
});
