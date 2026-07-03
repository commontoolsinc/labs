/**
 * Storage-level tests for the client side of the computed-cell ack-and-drop
 * policy (docs/specs/computed-cell-identity.md): when the server acknowledges
 * an all-computed commit but drops its operations (stale reads), the commit
 * must SUCCEED from the transaction's point of view while the optimistic
 * pending value is reverted — never promoted into confirmed state, where it
 * would shadow the authoritative value behind the monotonic seq guard.
 *
 * Runs against the real memory-v2 server inside the emulated storage manager;
 * staleness is made deterministic by capturing the transaction's read before
 * a remote session advances the input on the server.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type { Server as MemoryV2Server } from "@commonfabric/memory/v2/server";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createRef } from "../src/create-ref.ts";
import { toURI } from "../src/uri-utils.ts";
import { testSessionOpenAuthFactory } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("computed-drop-storage");
const space = signer.did();

describe("computed-cell ack-and-drop (storage client)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let remoteClient: MemoryV2Client.Client;
  let remoteSession: MemoryV2Client.SpaceSession;
  let remoteLocalSeq: number;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const candidate = storageManager as unknown as {
      server?: () => MemoryV2Server;
    };
    if (typeof candidate.server !== "function") {
      throw new Error("Expected a memory/v2 emulated storage manager");
    }
    remoteClient = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(candidate.server()),
    });
    remoteSession = await remoteClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    remoteLocalSeq = 1;
  });

  afterEach(async () => {
    await runtime.dispose();
    await remoteClient.close();
    await storageManager.close();
    await new Promise((resolve) => setTimeout(resolve, 1));
  });

  it("acks a stale all-computed commit, reverts the optimistic value, and converges on recompute", async () => {
    const input = runtime.getCell<number>(space, "computed-drop-input");
    const computedLink = {
      space,
      id: toURI(createRef({}, "computed-drop-out", { kind: "computed" })),
      path: [],
      scope: "space",
    } as const;
    const out = runtime.getCellFromLink<number>(computedLink);

    // Seed the input and let it reach the server.
    const seedTx = runtime.edit();
    input.withTx(seedTx).set(1);
    const seedResult = await seedTx.commit();
    expect(seedResult.error).toBeUndefined();
    await runtime.storageManager.synced();

    // Open the computing transaction and capture its read of the input
    // BEFORE the remote write advances it: the commit's confirmed read is
    // now pinned to the old seq.
    const computeTx = runtime.edit();
    const seen = input.withTx(computeTx).get();
    expect(seen).toBe(1);

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.getAsNormalizedFullLink().id,
        value: { value: 5 },
      }],
    });

    // Commit the (now stale) computed write. The server acknowledges and
    // drops it: the transaction reports SUCCESS, no conflict retry.
    out.withTx(computeTx).set(seen * 2);
    const result = await computeTx.commit();
    expect(result.error).toBeUndefined();

    // The optimistic value was reverted, not promoted: nothing pins seq
    // ahead of the authoritative state, so the entity reads as unwritten.
    expect(out.getRaw()).toBeUndefined();

    // Convergence: once the newer input arrives, a fresh recompute against
    // it commits cleanly (current reads — no drop).
    await input.pull();
    expect(input.get()).toBe(5);
    const recomputeTx = runtime.edit();
    const current = input.withTx(recomputeTx).get();
    out.withTx(recomputeTx).set(current * 2);
    const recomputeResult = await recomputeTx.commit();
    expect(recomputeResult.error).toBeUndefined();
    await runtime.storageManager.synced();
    expect(out.get()).toBe(10);
  });

  it("keeps strict conflict semantics for stale writes to untagged cells", async () => {
    const input = runtime.getCell<number>(space, "strict-input");
    const state = runtime.getCell<number>(space, "strict-state-out");

    const seedTx = runtime.edit();
    input.withTx(seedTx).set(1);
    const seedResult = await seedTx.commit();
    expect(seedResult.error).toBeUndefined();
    await runtime.storageManager.synced();

    const computeTx = runtime.edit();
    const seen = input.withTx(computeTx).get();
    expect(seen).toBe(1);

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.getAsNormalizedFullLink().id,
        value: { value: 5 },
      }],
    });

    state.withTx(computeTx).set(seen * 2);
    const result = await computeTx.commit();
    expect(result.error).toBeDefined();
    expect((result.error as { name?: string }).name).toBe("ConflictError");
  });
});
