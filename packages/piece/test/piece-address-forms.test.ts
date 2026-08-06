import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { pieceId } from "../src/piece-id.ts";

const signer = await Identity.fromPassphrase("piece address form tests");

describe("piece address forms", () => {
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
      spaceName: "piece-address-forms-" + crypto.randomUUID(),
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

  it("resolves one piece through its bare hash and through its `of:` URI", async () => {
    const piece = await createPiece("address-forms-target");
    const id = pieceId(piece)!;

    const viaHash = await pieces.getPieceCell(id);
    const viaUri = await pieces.getPieceCell(`of:${id}`);

    expect(pieceId(viaUri)).toBe(id);
    expect(viaUri.equals(viaHash)).toBe(true);
    expect(viaUri.get()).toEqual(viaHash.get());
  });

  it("throws for a `computed:` address, naming the address it was given", async () => {
    // The `of:` id over the same hash is a DIFFERENT entity, so the scheme
    // cannot be dropped to reach a piece — the address is refused instead.
    const piece = await createPiece("address-forms-computed");
    const id = pieceId(piece)!;

    await expect(pieces.getPieceCell(`computed:${id}`)).rejects.toThrow(
      `Kinded entity id \`computed:${id}\``,
    );
  });
});
