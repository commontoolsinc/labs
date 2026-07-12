import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import { Runtime } from "../src/runtime.ts";

Deno.test("executor shadow runtime records but never releases external sink effects", async () => {
  const signer = await Identity.fromPassphrase(
    "executor shadow external sink suppression",
  );
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    externalSinkDisposition: "suppress",
  });

  try {
    const transaction = runtime.edit();
    let releases = 0;
    for (
      const [sink, kind] of [
        ["fetchJson", "fetchJson-start"],
        ["streamData", "streamData-start"],
        ["generateText", "llm-start"],
        ["generateObject", "llm-start"],
      ] as const
    ) {
      enqueueSinkRequestPostCommitEffect(
        transaction,
        sink,
        `${sink}:executor-shadow`,
        { sink },
        kind,
        () => {
          releases++;
        },
      );
    }

    assertEquals(transaction.getCfcState().writePolicyInputs.length, 4);
    assertEquals(transaction.hasPendingPostCommitEffects(), false);
    assertEquals((await transaction.commit()).error, undefined);
    assertEquals(releases, 0);
  } finally {
    await runtime.dispose();
    await storage.close();
  }
});
