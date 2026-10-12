import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { refuseAtCommitBoundary } from "./refused-commit.ts";

const signer = await Identity.fromPassphrase("pattern-swap-setup-verdict");
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

/**
 * A piece whose `add` stream appends to a list made with `.for(listCause)`,
 * and which exposes that list as `list`. Two versions that differ only in that
 * cause bind the stream to two different cells.
 */
function appending(listCause: string) {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: `/// <cts-enable />
        import { handler, pattern, Writable } from "commonfabric";
        const add = handler<{ add: string }, { list: Writable<string[]> }>(
          (event, { list }) => {
            list.set([...list.get(), event.add]);
          },
        );
        export default pattern<Record<string, never>>(() => {
          const list = new Writable<string[]>([]).for("${listCause}");
          return { list, add: add({ list }) };
        });
      `,
    }],
  };
}

describe("pattern-swap-setup-verdict", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let runtime: Runtime;
  let prepare: Runtime["prepareTxForCommit"];

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
      experimental: { serverExecution: false },
    });
    prepare = runtime.prepareTxForCommit;
  });

  afterEach(async () => {
    runtime.prepareTxForCommit = prepare;
    await runtime.idle();
    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.storageManager.synced();
    await runtime.dispose();
    await server.close();
  });

  /**
   * Refuse, at the commit boundary, the setup the pattern watcher stages for
   * `pieceId`, and record each refusal's verdict in the returned list. The
   * watcher's setup is the only commit that writes the piece's setup marker
   * after the piece has started.
   */
  const refuseWatcherSetup = (pieceId: string): boolean[] => {
    const refused: boolean[] = [];
    runtime.prepareTxForCommit = (tx: IExtendedStorageTransaction) => {
      const stagesSetup = [...tx.getWriteDetails?.(space) ?? []].some((
        { address },
      ) =>
        address.id === pieceId && address.path[0] === "patternSetupIdentity"
      );
      if (stagesSetup) {
        refuseAtCommitBoundary(tx, space, "refuse the watcher's setup");
        tx.addCommitCallback((_settled, result) => {
          refused.push(isCfcEnforcementRejection(result.error));
        });
      }
      prepare.call(runtime, tx);
    };
    return refused;
  };

  it("keeps the running graph reactive when the setup a pointer move needs is refused", async () => {
    expect(runtime.sealDestinationInstalled).toBe(false);
    const v1 = await runtime.patternManager.compilePattern(scaling(2), {
      space,
    });
    const v2 = await runtime.patternManager.compilePattern(scaling(3), {
      space,
    });
    const v2Ref = runtime.patternManager.getArtifactEntryRef(v2)!;
    const input = runtime.getCell<number>(space, "swap-verdict-input");
    const piece = runtime.getCell<{ slots: number[] }>(
      space,
      "swap-verdict-scaling",
    );
    const seed = runtime.edit();
    input.withTx(seed).set(1);
    await runtime.setup(seed, v1, { input }, piece);
    expect((await seed.commit().settled).error).toBeUndefined();
    expect(await runtime.start(piece)).toBe(true);
    const cancel = piece.sink(() => {});
    await runtime.idle();
    expect(piece.get()).toEqual({ slots: [2] });

    const refused = refuseWatcherSetup(piece.getAsNormalizedFullLink().id);
    const move = runtime.edit();
    piece.withTx(move).setMetaRaw(
      "patternIdentity",
      v2Ref,
      rawMetaWriteAuthorization,
    );
    expect((await move.commit().settled).error).toBeUndefined();
    await runtime.idle();
    runtime.prepareTxForCommit = prepare;
    expect(refused).toEqual([true]);

    expect(
      (await runtime.editWithRetry((tx) => input.withTx(tx).set(4))).error,
    ).toBeUndefined();
    await runtime.idle();
    expect(piece.get()).toEqual({ slots: [8] });
    cancel();
  });

  /**
   * Runs the `tags` version of `appending`, appends `before` through its
   * stream, and returns the piece with the `labels` version's reference.
   */
  const runAppending = async () => {
    const v1 = await runtime.patternManager.compilePattern(
      appending("tags"),
      { space },
    );
    const v2 = await runtime.patternManager.compilePattern(
      appending("labels"),
      { space },
    );
    const seed = runtime.edit();
    const piece = runtime.run(
      seed,
      v1,
      {},
      runtime.getCell(space, "swap-verdict-appending", v1.resultSchema, seed),
    );
    runtime.prepareTxForCommit(seed);
    expect((await seed.commit().settled).error).toBeUndefined();
    const cancel = piece.sink(() => {});
    await runtime.idle();
    piece.key("add").send({ add: "before" });
    await runtime.idle();
    expect(await piece.key("list").pull()).toEqual(["before"]);
    return {
      piece,
      v2Ref: runtime.patternManager.getArtifactEntryRef(v2)!,
      cancel,
    };
  };

  for (const refusal of [false, true]) {
    it(
      `delivers an event sent once a ${
        refusal ? "refused " : ""
      }pointer move commits to the ${
        refusal ? "running" : "incoming"
      } pattern's handler`,
      async () => {
        const { piece, v2Ref, cancel } = await runAppending();
        const refused = refusal
          ? refuseWatcherSetup(piece.getAsNormalizedFullLink().id)
          : [];
        const move = runtime.edit();
        piece.withTx(move).setMetaRaw(
          "patternIdentity",
          v2Ref,
          rawMetaWriteAuthorization,
        );
        expect((await move.commit().settled).error).toBeUndefined();
        piece.key("add").send({ add: "after" });
        await runtime.idle();
        runtime.prepareTxForCommit = prepare;
        expect(refused).toEqual(refusal ? [true] : []);

        // The incoming pattern's list is a cell the running one never wrote.
        expect(await piece.key("list").pull()).toEqual(
          refusal ? ["before", "after"] : ["after"],
        );
        cancel();
      },
    );
  }

  it("delivers an event that dispatches before the incoming pattern's setup settles to that pattern's handler", async () => {
    // The watcher's setup commit settles only once `settle` resolves. It
    // resolves when the scheduler finds the event's piece mid-change, or, if
    // nothing holds the event, when the running pattern's handler writes it to
    // that pattern's list. The setup is applied locally before it settles, so
    // the piece's `list` names the incoming pattern's cell by then, and the
    // running pattern's list is watched where it lives.
    const { piece, v2Ref, cancel } = await runAppending();
    const pieceId = piece.getAsNormalizedFullLink().id;
    const settle = Promise.withResolvers<void>();
    runtime.prepareTxForCommit = (tx: IExtendedStorageTransaction) => {
      const stagesSetup = [...tx.getWriteDetails?.(space) ?? []].some((
        { address },
      ) =>
        address.id === pieceId && address.path[0] === "patternSetupIdentity"
      );
      if (stagesSetup) {
        const commit = tx.commit.bind(tx);
        tx.commit = (...args) => {
          const receipt = commit(...args);
          return Object.create(receipt, {
            settled: { value: settle.promise.then(() => receipt.settled) },
          });
        };
      }
      prepare.call(runtime, tx);
    };
    const runner = runtime.runner;
    const consult = runner.pendingPatternChangeFor.bind(runner);
    runner.pendingPatternChangeFor = (roots) => {
      const change = consult(roots);
      if (change !== undefined) settle.resolve();
      return change;
    };
    const outgoingList = piece.key("list").resolveAsCell();
    const watch = outgoingList.sink((list) => {
      if (Array.isArray(list) && list.includes("after")) settle.resolve();
    });
    try {
      const move = runtime.edit();
      piece.withTx(move).setMetaRaw(
        "patternIdentity",
        v2Ref,
        rawMetaWriteAuthorization,
      );
      expect((await move.commit().settled).error).toBeUndefined();
      piece.key("add").send({ add: "after" });
      await settle.promise;
      await runtime.idle();
    } finally {
      runtime.prepareTxForCommit = prepare;
      runner.pendingPatternChangeFor = consult;
      watch();
    }

    expect(await piece.key("list").pull()).toEqual(["after"]);
    cancel();
  });
});
