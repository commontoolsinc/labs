import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import { pieceId, PieceManager } from "../src/manager.ts";

const signer = await Identity.fromPassphrase("piece address form tests");

describe("piece address forms", () => {
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
      spaceName: "piece-address-forms-" + crypto.randomUUID(),
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

  it("resolves one piece through its bare hash and through its `of:` URI", async () => {
    const piece = await createPiece("address-forms-target");
    const id = pieceId(piece)!;

    const viaHash = await manager.get(id);
    const viaUri = await manager.get(`of:${id}`);

    expect(pieceId(viaUri)).toBe(id);
    expect(viaUri.equals(viaHash)).toBe(true);
    expect(viaUri.get()).toEqual(viaHash.get());
  });

  it("throws for a `computed:` address, naming the address it was given", async () => {
    // The `of:` id over the same hash is a DIFFERENT entity, so the scheme
    // cannot be dropped to reach a piece — the address is refused instead.
    const piece = await createPiece("address-forms-computed");
    const id = pieceId(piece)!;

    await expect(manager.get(`computed:${id}`)).rejects.toThrow(
      `Kinded entity id \`computed:${id}\``,
    );
  });
});
