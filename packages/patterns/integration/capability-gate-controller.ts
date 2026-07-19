import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PieceManager } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { moduleByteCache } from "./pieces-controller.ts";

export async function initializeCapabilityGateController(
  spaceName: string,
): Promise<PiecesController> {
  const identity = await Identity.generate({ implementation: "noble" });
  const session = await createSession({ identity, spaceName });
  const runtime = new Runtime({
    apiUrl: new URL(
      Deno.env.get("API_URL") ?? "http://localhost:8000/",
    ),
    storageManager: StorageManager.emulate({ as: session.as }),
    moduleByteCache,
    cfcEnforcementMode: "enforce-explicit",
    trustSnapshotProvider: () => ({
      id: `principal:${session.as.did()}`,
      actingPrincipal: session.as.did(),
    }),
  });
  const manager = new PieceManager(session, runtime);
  await manager.synced();
  return new PiecesController(manager);
}
