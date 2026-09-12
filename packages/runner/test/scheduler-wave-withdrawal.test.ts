import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import { toMemorySpaceAddress } from "../src/link-types.ts";
import { Runtime } from "../src/runtime.ts";
import { syncCellForIdentity } from "../src/cell.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import type { Action } from "../src/scheduler/types.ts";
import {
  requireWaveAcceptance,
  stampWaveRunContext,
  WaveAccumulator,
} from "../src/executor/wave.ts";
import { EngineWaveCommitSink } from "../src/executor/engine-wave-sink.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("scheduler wave withdrawal");
const space = signer.did() as MemorySpace;

describe("reactive wave withdrawal", () => {
  let server: ReturnType<typeof newSharedServer>;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let engine: Engine.Engine;
  let lease: ExecutionLeaseCycle;
  let waves: WaveAccumulator[];
  let actions: Action[];
  let peers: Runtime[];

  beforeEach(async () => {
    waves = [];
    actions = [];
    peers = [];
    server = newSharedServer();
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
    engine = await server.engineForSpace(space);
    lease = new ExecutionLeaseCycle({
      engine,
      space,
      holder: executionLeaseHolder(`service:${space}`),
    });
    expect(lease.acquire()).toBe(true);
  });

  afterEach(async () => {
    for (const action of actions) runtime.scheduler.unsubscribe(action);
    runtime.clearSealDestination();
    for (const wave of waves) wave.abandon("test cleanup");
    await Promise.all(waves.map((wave) => wave.settled()));
    lease.release();
    await storageManager.synced();
    await runtime.dispose();
    await Promise.all(peers.map((peer) => peer.dispose()));
    await server.close();
  });

  const newWave = () => {
    const wave = new WaveAccumulator({
      space,
      basisSeq: Engine.serverSeq(engine),
      lease,
      foreignWrites: "accept",
      foreignWriteGrant: () => true,
      scopeKeyIdentity: { principal: signer.did(), sessionId: "wave-test" },
      replicaFor: (target) => storageManager.open(target).replica,
    });
    waves.push(wave);
    return wave;
  };
  const newSink = () =>
    new EngineWaveCommitSink({
      engineFor: () => engine,
      sessionId: executionLeaseHolder(`service:${space}`),
    });

  for (
    const [boundary, description] of [
      [
        "withdrawn",
        "recomputes a withdrawn derivation when rollback preserves its input value",
      ],
      ["accepted", "keeps an accepted derivation current"],
      [
        "repeated",
        "recovers a withdrawn result after an equal-value no-op rerun",
      ],
      [
        "partial",
        "recovers an elided output when a newer run writes another output",
      ],
      [
        "local-acceptance",
        "recovers an elided output through a write-free local acceptance contribution",
      ],
      ["abandoned", "does not rearm a derivation from an abandoned wave"],
      [
        "unsubscribed",
        "does not revive an unsubscribed derivation after withdrawal",
      ],
      [
        "reregistered",
        "does not transfer a held seal to a new registration of the same action",
      ],
      [
        "body-reregistered",
        "does not transfer an unfinished run to a new registration of the same action",
      ],
      ["newer", "does not rearm an obsolete run after a newer accepted result"],
    ] as const
  ) {
    it(description, async () => {
      const input = runtime.getCell<{ draft: string; note?: string }>(
        space,
        "input",
        undefined,
      );
      const output = runtime.getCell<string>(space, "output", undefined);
      const extra = runtime.getCell<string>(space, "extra-output", undefined);
      let writesExtra = false;
      const seed = runtime.edit();
      input.withTx(seed).set({ draft: "a0" });
      expect((await seed.commit()).error).toBeUndefined();
      let wave = newWave();
      const authored = runtime.edit();
      input.withTx(authored).key("draft").set("b0");
      expect((await authored.commit()).error).toBeUndefined();

      if (boundary === "accepted") wave = newWave();
      let flushing = false;
      let recoveryWave: WaveAccumulator | undefined;
      const sealHeld = Promise.withResolvers<void>();
      const releaseSeal = Promise.withResolvers<void>();
      const bodyHeld = Promise.withResolvers<void>();
      const releaseBody = Promise.withResolvers<void>();
      const reregistered = boundary === "reregistered" ||
        boundary === "body-reregistered";
      let seals = 0;
      runtime.installSealDestination({
        seal: async (tx) => {
          const result = await (flushing ? recoveryWave ??= newWave() : wave)
            .seal(tx);
          if (boundary === "reregistered" && ++seals === 2) {
            sealHeld.resolve();
            await releaseSeal.promise;
          }
          return result;
        },
      }, {
        runStamper: (tx, info) =>
          stampWaveRunContext(tx, { actionId: info.actionId, kind: info.kind }),
      });
      const initializer = runtime.edit();
      stampWaveRunContext(initializer, {
        actionId: "initialize-note",
        kind: "derivation",
      });
      input.withTx(initializer).key("note").set("session-default");
      expect((await initializer.commit()).error).toBeUndefined();
      let runs = 0;
      let override: string | undefined;
      let retiredRegistration = false;
      const derive: Action = (tx) => {
        runs += 1;
        if (retiredRegistration) return;
        if (boundary === "local-acceptance" && runs > 1) {
          requireWaveAcceptance(tx);
        }
        if (writesExtra) {
          tx.writeValueOrThrow(extra.getAsNormalizedFullLink(), "extra");
        }
        tx.writeValueOrThrow(
          output.getAsNormalizedFullLink(),
          override ?? tx.readOrThrow(
            toMemorySpaceAddress(input.key("draft").getAsNormalizedFullLink()),
          ),
        );
        if (boundary === "body-reregistered" && runs === 1) {
          bodyHeld.resolve();
          return releaseBody.promise;
        }
      };
      actions.push(derive);
      runtime.scheduler.subscribe(derive, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
      if (reregistered) {
        try {
          await (boundary === "reregistered"
            ? sealHeld.promise
            : bodyHeld.promise);
          expect(runs).toBe(1);
          runtime.scheduler.unsubscribe(derive);
          retiredRegistration = true;
          runtime.scheduler.subscribe(derive, {
            reads: [],
            shallowReads: [],
            writes: [],
          }, { isEffect: true });
          if (boundary === "reregistered") {
            await runtime.scheduler.idle();
            expect(runs).toBe(2);
          }
        } finally {
          releaseSeal.resolve();
          releaseBody.resolve();
        }
      }
      await runtime.scheduler.idleWithPendingCommits();
      expect(runs).toBe(reregistered ? 2 : 1);
      expect(output.get()).toBe("b0");
      if (
        boundary === "repeated" || boundary === "partial" ||
        boundary === "local-acceptance"
      ) {
        writesExtra = boundary === "partial";
        if (boundary !== "repeated") override = "b0";
        await runtime.scheduler.run(derive);
        await runtime.scheduler.idleWithPendingCommits();
        expect(runs).toBe(2);
      }
      if (boundary === "unsubscribed") runtime.scheduler.unsubscribe(derive);
      if (boundary === "newer") {
        override = "newer";
        await runtime.scheduler.run(derive);
        await runtime.scheduler.idleWithPendingCommits();
        expect(runs).toBe(2);
      }
      flushing = true;
      if (boundary === "abandoned") wave.abandon("lease tenure ended");
      else {
        const outcome = await wave.commitWave(newSink());
        expect(outcome.dispositions).toEqual(
          boundary === "accepted"
            ? [{ kind: "committed" }, { kind: "committed" }]
            : boundary === "partial" || boundary === "local-acceptance"
            ? [{ kind: "dropped" }, { kind: "dropped" }, { kind: "dropped" }]
            : boundary === "newer"
            ? [{ kind: "dropped" }, { kind: "dropped" }, { kind: "committed" }]
            : [{ kind: "dropped" }, { kind: "dropped" }],
        );
      }
      await wave.settled();
      expect(input.get()).toEqual(
        boundary === "accepted"
          ? { draft: "b0", note: "session-default" }
          : { draft: "b0" },
      );
      await runtime.scheduler.idleWithPendingCommits();
      if (
        boundary === "withdrawn" || boundary === "repeated" ||
        boundary === "partial" || boundary === "local-acceptance"
      ) {
        expect(runs).toBe(boundary === "withdrawn" ? 2 : 3);
        expect(recoveryWave).toBeDefined();
        await recoveryWave!.commitWave(newSink());
        await recoveryWave!.settled();
      } else {
        expect(runs).toBe(
          boundary === "newer" || reregistered ? 2 : 1,
        );
        expect(recoveryWave).toBeUndefined();
      }
      expect(
        Engine.readState(engine, { id: output.getAsNormalizedFullLink().id })
          ?.document,
      ).toEqual(
        boundary === "withdrawn" || boundary === "accepted" ||
          boundary === "repeated" || boundary === "partial" ||
          boundary === "local-acceptance"
          ? { value: "b0" }
          : boundary === "newer"
          ? { value: "newer" }
          : undefined,
      );
      expect(
        Engine.readState(engine, { id: extra.getAsNormalizedFullLink().id })
          ?.document,
      ).toEqual(boundary === "partial" ? { value: "extra" } : undefined);
      runtime.scheduler.unsubscribe(derive);
    });
  }
  for (
    const refusal of [
      "output supersession",
      "precondition",
      "foreign failure",
    ] as const
  ) {
    it(`does not retry a direct ${refusal} without a withdrawn read`, async () => {
      const output = runtime.getCell<string>(space, "direct-output", undefined);
      const seed = runtime.edit();
      output.withTx(seed).set("initial");
      expect((await seed.commit()).error).toBeUndefined();
      const wave = newWave();
      if (refusal === "output supersession") {
        const authored = runtime.edit();
        output.withTx(authored).set("authored");
        expect((await authored.commit()).error).toBeUndefined();
      }
      const foreignSigner = await Identity.fromPassphrase("withdrawal foreign");
      const foreign = foreignSigner.did() as MemorySpace;
      const foreignOutput = runtime.getCell<string>(
        foreign,
        "foreign-output",
        undefined,
      );
      if (refusal === "foreign failure") await server.engineForSpace(foreign);
      let flushing = false;
      let recoveryWave: WaveAccumulator | undefined;
      const sink = newSink();
      runtime.installSealDestination({
        seal: (tx) => (flushing ? recoveryWave ??= newWave() : wave).seal(tx),
      }, {
        runStamper: (tx, info) =>
          stampWaveRunContext(tx, {
            actionId: info.actionId,
            kind: info.kind,
            acting: { user: signer.did() },
            capabilityRef: "test-foreign-grant",
          }),
      });
      let runs = 0;
      const derive: Action = (tx) => {
        runs++;
        tx.writeValueOrThrow(
          (refusal === "foreign failure" ? foreignOutput : output)
            .getAsNormalizedFullLink(),
          "derived",
        );
        if (refusal === "precondition") {
          tx.addCommitPrecondition!(space, {
            kind: "entity-absent",
            id: output.getAsNormalizedFullLink().id,
          });
        }
      };
      actions.push(derive);
      runtime.scheduler.subscribe(derive, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
      await runtime.scheduler.idleWithPendingCommits();
      expect(runs).toBe(1);
      let readerRuns = 0;
      const answer = runtime.getCell<string>(
        space,
        "foreign-answer",
        undefined,
      );
      if (refusal === "foreign failure") {
        const readForeign: Action = (tx) => {
          const value = tx.readValueOrThrow(
            foreignOutput.getAsNormalizedFullLink(),
          );
          tx.writeValueOrThrow(
            answer.getAsNormalizedFullLink(),
            value ?? "missing",
          );
          readerRuns++;
        };
        actions.push(readForeign);
        runtime.scheduler.subscribe(readForeign, {
          reads: [],
          shallowReads: [],
          writes: [],
        }, { isEffect: true });
        await runtime.scheduler.idleWithPendingCommits();
        expect(readerRuns).toBe(1);
        wave.failForeignSpace(foreign, "engine unavailable");
      }
      flushing = true;
      const outcome = await wave.commitWave(sink);
      await wave.settled();
      expect(outcome.dispositions).toEqual(
        refusal === "foreign failure"
          ? [{ kind: "dropped" }, { kind: "dropped" }]
          : [{ kind: "dropped" }],
      );
      await runtime.scheduler.idleWithPendingCommits();
      expect(runs).toBe(1);
      if (refusal === "foreign failure") {
        expect(readerRuns).toBe(2);
        expect(recoveryWave).toBeDefined();
        await recoveryWave!.commitWave(sink);
        await recoveryWave!.settled();
        await runtime.scheduler.idleWithPendingCommits();
        expect(readerRuns).toBe(2);
        expect(runs).toBe(1);
        expect(
          Engine.readState(engine, { id: answer.getAsNormalizedFullLink().id })
            ?.document,
        ).toEqual({ value: "missing" });
      } else expect(recoveryWave).toBeUndefined();
      expect(
        Engine.readState(engine, { id: output.getAsNormalizedFullLink().id })
          ?.document,
      ).toEqual({
        value: refusal === "output supersession" ? "authored" : "initial",
      });
      runtime.scheduler.unsubscribe(derive);
    });
  }
  for (const boundary of ["retained", "removed", "replaced"] as const) {
    it(
      boundary === "retained"
        ? "retries only the withdrawn user instance and preserves its shared trigger read"
        : `does not revive a ${boundary} user instance after withdrawal`,
      async () => {
        await runtime.dispose();
        lease.release();
        const holder = executionLeaseHolder(signer.did());
        lease = new ExecutionLeaseCycle({ engine, space, holder });
        expect(lease.acquire()).toBe(true);
        storageManager = EmulatedStorageManager.connectTo(server, {
          as: signer,
          id: holder,
        });
        runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        const bob = await Identity.fromPassphrase("withdrawal Bob");
        const identities = [
          { principal: signer.did(), sessionId: "alice" },
          { principal: bob.did(), sessionId: "bob" },
        ];
        let demanders = [...identities];
        let replacementIsReadOnly = false;
        const input = runtime.getCellFromLink<{ draft: string; note?: string }>(
          {
            ...runtime.getCell(space, "scoped-input", undefined)
              .getAsNormalizedFullLink(),
            scope: "user",
          },
        );
        const output = runtime.getCellFromLink<string>({
          ...runtime.getCell(space, "scoped-output", undefined)
            .getAsNormalizedFullLink(),
          scope: "user",
        });
        const shared = runtime.getCell<number>(
          space,
          "shared-trigger",
          undefined,
        );
        for (const [index, actor] of [signer, bob].entries()) {
          const peer = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: EmulatedStorageManager.connectTo(server, {
              as: actor,
              id: identities[index].sessionId,
            }),
          });
          peers.push(peer);
          const tx = peer.edit();
          peer.getCellFromLink(input.getAsNormalizedFullLink()).withTx(tx).set({
            draft: identities[index].sessionId,
          });
          if (index === 0) {
            peer.getCellFromLink(shared.getAsNormalizedFullLink()).withTx(tx)
              .set(
                0,
              );
          }
          expect((await tx.commit()).error).toBeUndefined();
          expect(
            Engine.readState(engine, {
              id: input.getAsNormalizedFullLink().id,
              scopeKey: resolveScopeKey("user", identities[index]),
            })?.document,
          ).toEqual({ value: { draft: identities[index].sessionId } });
          await syncCellForIdentity(input, identities[index]);
        }
        await shared.sync();
        let activeWave = newWave();
        let recoveryWave: WaveAccumulator | undefined;
        let flushing = false;
        let sealChain = Promise.resolve();
        const sink = new EngineWaveCommitSink({
          engineFor: () => engine,
          sessionId: holder,
        });
        runtime.installSealDestination({
          seal: (tx) => {
            const wave = flushing ? recoveryWave ??= newWave() : activeWave;
            const sealed = sealChain.then(() => wave.seal(tx));
            sealChain = sealed.then(() => undefined, () => undefined);
            return sealed;
          },
        }, {
          runStamper: (tx, info) =>
            stampWaveRunContext(tx, {
              actionId: info.actionId,
              kind: info.kind,
              scopeKeyIdentity: info.scopeKeyIdentity,
              actionScopeKey: info.actionScopeKey,
            }),
          runDemanderResolver: () => demanders,
        });
        const runs: string[] = [];
        const triggers: string[][] = [];
        const derive = Object.assign((tx: IExtendedStorageTransaction) => {
          const sharedValue = tx.readValueOrThrow(
            shared.getAsNormalizedFullLink(),
          );
          const draft = tx.readValueOrThrow(
            input.key("draft").getAsNormalizedFullLink(),
          );
          if (
            !replacementIsReadOnly ||
            tx.tx.scopeKeyIdentity?.principal !== identities[0].principal
          ) {
            tx.writeValueOrThrow(
              output.getAsNormalizedFullLink(),
              `${String(draft)}:${String(sharedValue)}`,
            );
          }
          runs.push(String(tx.tx.scopeKeyIdentity?.principal));
          triggers.push(
            tx.getCfcState().triggerReads.map((read) => read.id),
          );
        }, {
          schedulerObservationIdentity: { pieceRootId: "withdrawal-piece" },
        });
        actions.push(derive);
        runtime.scheduler.subscribe(derive, {
          reads: [],
          shallowReads: [],
          writes: [],
        }, { isEffect: true });
        await runtime.scheduler.idleWithPendingCommits();
        await activeWave.commitWave(sink);
        await activeWave.settled();
        await runtime.scheduler.idleWithPendingCommits();
        expect([...new Set(runs)].sort()).toEqual(
          identities.map((identity) => String(identity.principal)).sort(),
        );
        runs.length = 0;
        triggers.length = 0;
        activeWave = newWave();
        const peer = peers[0];
        const peerInput = peer.getCellFromLink<
          { draft: string; note?: string }
        >(
          input.getAsNormalizedFullLink(),
        );
        const peerShared = peer.getCellFromLink<number>(
          shared.getAsNormalizedFullLink(),
        );
        await peerInput.sync();
        await peerShared.sync();
        // Hold dispatch while the real authored commit records both invalidation
        // causes; the next run must consume the shared trigger for both users.
        const dispatch = stub(runtime.scheduler, "queueExecution", () => {});
        try {
          const authored = peer.edit();
          authored.tx.scopeKeyIdentity = identities[0];
          peerInput.withTx(authored).key("note").set("authored-note");
          peerShared.withTx(authored).set(1);
          expect((await authored.commit()).error).toBeUndefined();
          await storageManager.synced();
          const initializer = runtime.edit();
          initializer.tx.scopeKeyIdentity = identities[0];
          stampWaveRunContext(initializer, {
            actionId: "initialize-alice-note",
            kind: "derivation",
            scopeKeyIdentity: identities[0],
          });
          input.withTx(initializer).key("note").set("session-default");
          expect((await initializer.commit()).error).toBeUndefined();
        } finally {
          dispatch.restore();
        }
        runtime.scheduler.queueExecution();
        await runtime.scheduler.idleWithPendingCommits();
        expect([...new Set(runs)].sort()).toEqual(
          identities.map((identity) => String(identity.principal)).sort(),
        );
        expect(
          triggers.every((reads) =>
            reads.includes(shared.getAsNormalizedFullLink().id)
          ),
        ).toBe(true);
        runs.length = 0;
        triggers.length = 0;
        if (boundary !== "retained") {
          demanders = [identities[1]];
          expect(runtime.scheduler.invalidateActionsForDemandRoots([
            "withdrawal-piece",
          ])).toBe(1);
          await runtime.scheduler.idleWithPendingCommits();
          expect(runs).toEqual([]);
          if (boundary === "replaced") {
            replacementIsReadOnly = true;
            demanders = [...identities];
            expect(runtime.scheduler.invalidateActionsForDemandRoots([
              "withdrawal-piece",
            ])).toBe(1);
            await runtime.scheduler.idleWithPendingCommits();
            expect(runs).toEqual([String(signer.did())]);
            runs.length = 0;
            triggers.length = 0;
          }
        }
        flushing = true;
        const outcome = await activeWave.commitWave(sink);
        await activeWave.settled();
        expect(outcome.dispositions).toEqual([{ kind: "dropped" }, {
          kind: "dropped",
        }, { kind: "committed" }]);
        await runtime.scheduler.idleWithPendingCommits();
        if (boundary === "retained") {
          expect(runs).toEqual([String(signer.did())]);
          expect(triggers).toEqual([
            expect.arrayContaining([shared.getAsNormalizedFullLink().id]),
          ]);
          expect(recoveryWave).toBeDefined();
          await recoveryWave!.commitWave(sink);
          await recoveryWave!.settled();
        } else {
          expect(runs).toEqual([]);
          expect(recoveryWave).toBeUndefined();
        }
        for (
          const [identity, value] of [[
            identities[0],
            boundary === "retained" ? "alice:1" : "alice:0",
          ], [
            identities[1],
            "bob:1",
          ]] as const
        ) {
          expect(
            Engine.readState(engine, {
              id: output.getAsNormalizedFullLink().id,
              scopeKey: resolveScopeKey("user", identity),
            })?.document,
          ).toEqual({ value });
        }
        runtime.scheduler.unsubscribe(derive);
      },
    );
  }
});
