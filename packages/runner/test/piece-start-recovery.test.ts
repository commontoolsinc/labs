import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import { createTransactionCommitReceipt } from "../src/storage/commit-receipt.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { refuseAtCommitBoundary } from "./refused-commit.ts";

const signer = await Identity.fromPassphrase("piece-start-recovery");
const space = signer.did();

/** A piece whose `slots` are its `input` times `factor`. */
function scaling(factor: number) {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: `
        import { computed, pattern, Writable } from "commonfabric";
        export default pattern<{ input: Writable<number> }, { slots: number[] }>(
          ({ input }) => ({
            slots: [0].map(() => computed(() => input.get() * ${factor})),
          }),
        );
      `,
    }],
  };
}

describe("piece-start-recovery", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let runtime: Runtime;
  let prepare: Runtime["prepareTxForCommit"];
  let readiness: Runtime["awaitCommitRetryReadiness"];

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
      experimental: { serverExecution: false },
    });
    prepare = runtime.prepareTxForCommit;
    readiness = runtime.awaitCommitRetryReadiness;
  });

  afterEach(async () => {
    runtime.prepareTxForCommit = prepare;
    runtime.awaitCommitRetryReadiness = readiness;
    await runtime.idle();
    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.storageManager.synced();
    await runtime.dispose();
    await server.close();
  });

  /** Waits until the scheduler, the piece's instantiations and storage settle. */
  const settled = async () => {
    await runtime.idle();
    await runtime.runner.idlePieceInstantiationSettlements();
    await runtime.storageManager.synced();
    await runtime.idle();
  };

  it("instantiates the running pattern again when the pointer moves during the catch-up and the incoming pattern's setup is refused", async () => {
    // A refused instantiation retires its graph and waits for a catch-up
    // before it instantiates again. A pointer that moves during that wait has
    // a swap of its own on the way, and when that swap's setup is refused the
    // swap keeps the running pattern, so the retry is what gives the piece a
    // graph to keep.

    const v1 = await runtime.patternManager.compilePattern(scaling(2), {
      space,
    });
    const v2 = await runtime.patternManager.compilePattern(scaling(3), {
      space,
    });
    const v2Ref = runtime.patternManager.getArtifactEntryRef(v2)!;
    const input = runtime.getCell<number>(space, "recovery-input");
    const piece = runtime.getCell<{ slots: number[] }>(
      space,
      "recovery-scaling",
    );
    const pieceId = piece.getAsNormalizedFullLink().id;
    const seed = runtime.edit();
    input.withTx(seed).set(1);
    await runtime.setup(seed, v1, { input }, piece);
    expect((await seed.commit().settled).error).toBeUndefined();

    // The first instantiation commit is refused with a claim that the piece's
    // own document is absent, which recovers in every posture.
    const instantiations = new WeakSet<object>();
    const stamp = runtime.stampServerRun.bind(runtime);
    runtime.stampServerRun = ((tx, info) => {
      if (info.actionId.startsWith("piece-instantiate/")) {
        instantiations.add(tx);
      }
      return stamp(tx, info);
    }) as typeof runtime.stampServerRun;
    const conflict = { space, the: "application/json", of: pieceId, seq: 0 };
    const absence = {
      name: "ConflictError" as const,
      message: `stale confirmed read: ${pieceId} at seq 0 conflicted with ` +
        "seq 1",
      conflict,
      conflicts: [conflict],
      readyToRetry: () => Promise.resolve(),
    };
    let refusals = 0;

    // The watcher's setup for the incoming pattern is refused, and its
    // settlement held until `setupSettles` resolves.
    const setupStaged = Promise.withResolvers<void>();
    const setupSettles = Promise.withResolvers<void>();
    runtime.prepareTxForCommit = (tx: IExtendedStorageTransaction) => {
      if (instantiations.has(tx) && refusals === 0) {
        refusals += 1;
        tx.commit = () => {
          tx.abort(absence.message);
          return createTransactionCommitReceipt(
            Promise.resolve({ error: absence as never }),
          );
        };
        return;
      }
      const stagesSetup = [...tx.getWriteDetails?.(space) ?? []].some((
        { address },
      ) =>
        address.id === pieceId && address.path[0] === "patternSetupIdentity"
      );
      if (stagesSetup) {
        refuseAtCommitBoundary(tx, space, "refuse the watcher's setup");
        const commit = tx.commit.bind(tx);
        tx.commit = (...args) => {
          const receipt = commit(...args);
          setupStaged.resolve();
          return Object.create(receipt, {
            settled: {
              value: setupSettles.promise.then(() => receipt.settled),
            },
          });
        };
      }
      prepare.call(runtime, tx);
    };

    // The catch-up holds until `caughtUp` resolves.
    const catchingUp = Promise.withResolvers<void>();
    const caughtUp = Promise.withResolvers<void>();
    runtime.awaitCommitRetryReadiness = async (...args) => {
      catchingUp.resolve();
      await caughtUp.promise;
      return await readiness.apply(runtime, args);
    };

    expect(await runtime.start(piece)).toBe(true);
    const cancel = piece.sink(() => {});
    await catchingUp.promise;

    const move = runtime.edit();
    piece.withTx(move).setMetaRaw(
      "patternIdentity",
      v2Ref,
      rawMetaWriteAuthorization,
    );
    expect((await move.commit().settled).error).toBeUndefined();
    await setupStaged.promise;

    caughtUp.resolve();
    await runtime.runner.idlePieceInstantiationSettlements();
    setupSettles.resolve();
    await settled();
    runtime.prepareTxForCommit = prepare;

    expect(refusals).toBe(1);
    expect(runtime.runner.pieceGraphIsInstalled(piece)).toBe(true);
    expect(
      (await runtime.editWithRetry((tx) => input.withTx(tx).set(4))).error,
    ).toBeUndefined();
    await settled();
    expect(piece.get()).toEqual({ slots: [8] });
    cancel();
  });
});
