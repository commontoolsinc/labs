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

Deno.test("executor sink release policy follows the exact source action", async () => {
  const signer = await Identity.fromPassphrase(
    "executor source action sink policy",
  );
  const storage = StorageManager.emulate({ as: signer });
  const claimedAction = {};
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    externalSinkDisposition: (sourceAction) =>
      sourceAction === claimedAction ? "allow" : "suppress",
  });

  try {
    let releases = 0;
    const shadow = runtime.edit();
    shadow.tx.sourceAction = {};
    enqueueSinkRequestPostCommitEffect(
      shadow,
      "fetchText",
      "fetchText:shadow",
      { url: "/shadow" },
      "fetchText-start",
      () => {
        releases++;
      },
    );
    assertEquals((await shadow.commit()).error, undefined);

    const claimed = runtime.edit();
    claimed.tx.sourceAction = claimedAction;
    enqueueSinkRequestPostCommitEffect(
      claimed,
      "fetchText",
      "fetchText:claimed",
      { url: "/claimed" },
      "fetchText-start",
      () => {
        releases++;
      },
    );
    assertEquals((await claimed.commit()).error, undefined);
    assertEquals(releases, 1);
  } finally {
    await runtime.dispose();
    await storage.close();
  }
});

Deno.test("post-commit builtin continuations inherit their source action", async () => {
  const signer = await Identity.fromPassphrase(
    "executor source action continuation",
  );
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  const sourceAction = {};

  try {
    let continuationSource: object | undefined;
    const tx = runtime.edit();
    tx.tx.sourceAction = sourceAction;
    enqueueSinkRequestPostCommitEffect(
      tx,
      "fetchText",
      "fetchText:continuation",
      { url: "/continuation" },
      "fetchText-start",
      async () => {
        await Promise.resolve();
        const continuation = runtime.edit();
        continuationSource = continuation.tx.sourceAction;
        continuation.abort();
      },
    );
    assertEquals((await tx.commit()).error, undefined);
    assertEquals(continuationSource, sourceAction);
  } finally {
    await runtime.dispose();
    await storage.close();
  }
});
