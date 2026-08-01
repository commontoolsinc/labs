import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import { Runtime } from "../src/runtime.ts";
import type { ExecutionClaim } from "@commonfabric/memory/v2";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";

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
      sourceAction === claimedAction ? "server-executor" : "suppress",
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

// Nothing pinned this before, and the failure mode is the silent one: two
// consumers consult the gate directly BEFORE `enqueueSinkRequestPostCommitEffect`
// re-consults it (`sqlite-builtins.ts:798`, `llm-dialog.ts:3272`), and both
// document that they rely on the two answers agreeing. If the first consult
// says "allow" and the second says "suppress", sqliteQuery has already written
// its `{ pending: true, requestHash }` dedup marker on a side that then never
// issues — every later run returns early on the matching hash, so the result
// cell is stranded `pending` forever and the other side is wedged too. A
// missing effect is worse than a duplicated one, so it is the direction the
// memo has to hold.
Deno.test("externalSinkDisposition is idempotent across a server-executor policy state change", async () => {
  const signer = await Identity.fromPassphrase(
    "executor sink disposition idempotence",
  );
  const storage = StorageManager.emulate({ as: signer });
  const claimedAction = {};
  // Shape of `executor-worker.ts:1572`: a LIVE predicate over the executor's
  // claim table, re-evaluated on every consult.
  let claimLive = true;
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    externalSinkDisposition: (sourceAction) =>
      sourceAction === claimedAction && claimLive
        ? "server-executor"
        : "suppress",
  });

  try {
    const tx = runtime.edit();
    tx.tx.sourceAction = claimedAction;
    assertEquals(tx.externalSinkDisposition(), "allow");
    // The claim is released between the two consults.
    claimLive = false;
    assertEquals(tx.externalSinkDisposition(), "allow");
    // The memo is NOT on the public, forgeable transaction field.
    assertEquals(tx.tx.executionEffectAuthority, undefined);
    tx.abort();
  } finally {
    await runtime.dispose();
    await storage.close();
  }
});

// F4: the server-executor memo must not be reachable from anything a pattern
// or handler can write. `ExtendedStorageTransaction` exposes `public tx` and
// `executionEffectAuthority` is a plain writable property on the public
// interface, so if the memo lived there, untrusted code holding a Cell could
// forge it and re-authorise its own egress past the claim stand-down. Same
// threat model that made `#cfcState` / `#cfcEnforcementFloor` `#private`.
//
// The posture under test is "claim-conditional", DECLARED — and that is the
// whole of what changed here. It used to be reached by declaring nothing,
// which no longer works: the terminal flip made the default "suppress", and a
// suppress-configured runtime returns from the gate's first branch without
// ever consulting `executionEffectAuthority`. It would still pass this test,
// and for a reason with nothing to do with forgery. Claim-conditional is the
// only posture in which the forged field is reachable at all, so it is the
// only posture in which this guard discriminates.
Deno.test("server-executor authority cannot be forged through tx.executionEffectAuthority", async () => {
  const signer = await Identity.fromPassphrase(
    "client forges server executor authority",
  );
  const storage = StorageManager.emulate({ as: signer });
  const sourceAction = {};
  const claim: ExecutionClaim = {
    branch: "",
    space: signer.did(),
    contextKey: "space",
    pieceId: "space:of:forged-authority-piece",
    actionId: "action:forged-authority",
    actionKind: "effect",
    implementationFingerprint: "impl:forged-authority",
    runtimeFingerprint: "runtime:forged-authority",
    leaseGeneration: 3,
    claimGeneration: 4,
    expiresAt: 100_000,
  };
  storage.captureExecutionClaim = (action) =>
    action === sourceAction ? claim : undefined;
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: { serverPrimaryExecution: true },
    externalSinkDisposition: "claim-conditional",
  });
  // The posture every client actually ships with, kept alongside so the two
  // are read together rather than one standing in for the other.
  const defaultRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });

  try {
    const tx = runtime.edit();
    tx.tx.sourceAction = sourceAction;
    // What handler code reaching `cell.tx` would try.
    (tx.tx as { executionEffectAuthority?: string }).executionEffectAuthority =
      "server-executor";
    assertEquals(tx.externalSinkDisposition(), "suppress");
    assertEquals(tx.tx.executionEffectAuthority, "server");
    assertEquals(tx.tx.executionClaim, claim);
    tx.abort();

    // The shipped posture, and it is categorical rather than conditional: the
    // same forgery cannot reach "allow" even for an action NO server claim
    // covers, which is the case the claim-conditional leg above used to answer
    // "allow" to. Nothing is captured because the field is never read.
    const plain = defaultRuntime.edit();
    plain.tx.sourceAction = {};
    (plain.tx as { executionEffectAuthority?: string })
      .executionEffectAuthority = "server-executor";
    assertEquals(plain.externalSinkDisposition(), "suppress");
    assertEquals(plain.tx.executionEffectAuthority, "server-executor");
    assertEquals(plain.tx.executionClaim, undefined);
    plain.abort();
  } finally {
    await runtime.dispose();
    await defaultRuntime.dispose();
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
    // Sole party performing the effect under test, so it declares that
    // authority; a runtime that declares nothing is "suppress" (runtime.ts).
    // Nothing about source-action inheritance is client- or server-specific,
    // but the continuation only exists if the effect dispatches at all.
    externalSinkDisposition: "server-executor",
  });
  const sourceAction = {};
  const asyncBaseline = getLoggerCountsBreakdown()["runtime.execution"]?.[
    "execution-client-async-request"
  ]?.debug ?? 0;

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
        runtime.trackAsyncWork(Promise.resolve(), { externalEffect: true });
        await Promise.resolve();
        const continuation = runtime.edit();
        continuationSource = continuation.tx.sourceAction;
        continuation.abort();
      },
    );
    assertEquals((await tx.commit()).error, undefined);
    assertEquals(continuationSource, sourceAction);
    await runtime.settled();
    assertEquals(
      getLoggerCountsBreakdown()["runtime.execution"]?.[
        "execution-client-async-request"
      ]?.debug ?? 0,
      asyncBaseline + 1,
    );
  } finally {
    await runtime.dispose();
    await storage.close();
  }
});

// The double-egress guard. Its posture is "claim-conditional", DECLARED —
// see the note on the forgery guard above for why declaring nothing no longer
// reaches it. Read the two legs as before-and-after, because the difference is
// the arc's whole point: the claim-conditional leg is passive BECAUSE it
// observed an exact claim, and the claimless leg is passive FULL STOP. The
// second is not a weaker version of the first; it is what the first was a
// race-dependent approximation of.
Deno.test("client builtin sink captures one exact claim and becomes passive", async () => {
  const signer = await Identity.fromPassphrase(
    "client exact claimed sink passivity",
  );
  const storage = StorageManager.emulate({ as: signer });
  const sourceAction = {};
  const claim: ExecutionClaim = {
    branch: "",
    space: signer.did(),
    contextKey: "space",
    pieceId: "space:of:claimed-sink-piece",
    actionId: "action:claimed-sink",
    actionKind: "effect",
    implementationFingerprint: "impl:claimed-sink",
    runtimeFingerprint: "runtime:claimed-sink",
    leaseGeneration: 3,
    claimGeneration: 4,
    expiresAt: 100_000,
  };
  storage.captureExecutionClaim = (action) =>
    action === sourceAction ? claim : undefined;
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: { serverPrimaryExecution: true },
    externalSinkDisposition: "claim-conditional",
  });
  const defaultRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });

  try {
    let releases = 0;
    const tx = runtime.edit();
    tx.tx.sourceAction = sourceAction;
    enqueueSinkRequestPostCommitEffect(
      tx,
      "fetchText",
      "fetchText:client-passive",
      { url: "/claimed" },
      "fetchText-start",
      () => {
        releases++;
      },
    );
    assertEquals(tx.externalSinkDisposition(), "suppress");
    assertEquals(tx.tx.executionEffectAuthority, "server");
    assertEquals(tx.tx.executionClaim, claim);
    assertEquals(tx.hasPendingPostCommitEffects(), false);
    tx.abort();
    assertEquals(releases, 0);

    // The shipped posture, on an action NOTHING claims — the exact case the
    // claim-conditional leg answers "allow" to, and the one that made D9's
    // "control authority and quota on the server" claim-conditional rather
    // than actual. No claim observed, no authority recorded, still passive.
    const unclaimed = defaultRuntime.edit();
    unclaimed.tx.sourceAction = {};
    enqueueSinkRequestPostCommitEffect(
      unclaimed,
      "fetchText",
      "fetchText:unclaimed-passive",
      { url: "/unclaimed" },
      "fetchText-start",
      () => {
        releases++;
      },
    );
    assertEquals(unclaimed.externalSinkDisposition(), "suppress");
    assertEquals(unclaimed.tx.executionEffectAuthority, undefined);
    assertEquals(unclaimed.tx.executionClaim, undefined);
    assertEquals(unclaimed.hasPendingPostCommitEffects(), false);
    unclaimed.abort();
    assertEquals(releases, 0);
  } finally {
    await runtime.dispose();
    await defaultRuntime.dispose();
    await storage.close();
  }
});
