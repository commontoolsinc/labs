// Server-execution v2 Phase 3 (D-v2-1): events-down, end to end against
// a real memory server, a live ExecutorHost, and flag-ON clients.
//
// - the FULL loop: a client fire commits ONLY the event; the
//   SpaceServer drains it, runs the handler AUTHORITATIVELY, and
//   commits consequences in ONE derived commit carrying
//   `consequenceOf` — with the entry consequence-marked and the
//   per-stream `eventWatermark` advanced in the SAME transaction
//   (events.md §2, §4); the client's echo retires on the consequence
//   signal and the authoritative value renders;
// - exactly-once across restart (the plan's kill-between gate): an
//   append committed with NO serving host is drained once at
//   activation (serving-loop.md §6 step 4); a second activation
//   re-runs nothing (the consequenced mark + the watermark exclude
//   it);
// - the ERROR arm: a throwing handler's error IS the consequence
//   (events.md §5) — the entry carries it, the stream does not wedge;
// - the DROP arm: an event whose piece can NEVER start defers for the
//   bounded creation-race window, then hardens into the
//   `{status: "dropped", reason}` notice (events.md §5's predicate;
//   OW19's conflation caution bounds the deferral, it does not erase
//   the drop);
// - the SKIP arm: an at-or-below-horizon duplicate admission is
//   skipped at processing, counted `skippedIdempotent`, and passed by
//   the frontier (events.md §4/§5; the model's C2-dedupe pin);
// - LD1 at cardinality 2: two users' fires run as their OWN actors —
//   `firedAt` stamps distinct users, and the wave's attribution
//   annotations carry each event's actor on its consequence writes
//   (protocol.md §1/§2, scopes.md §5).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  decodeMemoryBoundary,
  eventAttentionEntryKey,
  eventAttentionIndexKey,
  SERVER_EXECUTION_ATTENTION_DOC_ID,
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { ReplicaLoadFailureError } from "../src/storage/interface.ts";
import { RetryImmediately } from "../src/scheduler/retry-immediately.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { readWatermarkSeq } from "../src/executor/watermark.ts";
import type {
  WaveCommitRejection,
  WaveCommitSink,
  WaveSpaceCommit,
} from "../src/executor/wave.ts";
import { waveRunContextOf } from "../src/executor/wave.ts";
import {
  isRendererTrustedEvent,
  markRendererTrustedEvent,
} from "../src/cfc/ui-contract.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

/** The serving-loop harness's settle-gate seam (see
 * executor-serving-loop.test.ts): when set, the loop's settle hangs at
 * its `inputSynced` barrier until the gate resolves — deterministically
 * holding an open (sealed, uncommitted) wave so a rival authored commit
 * can race a drained handler's consequence (the C8d raced-cascade
 * test). `settleGateWhen` scopes the hold: the serving loop runs a
 * settle in EVERY cycle (empty ones included), so an unconditional gate
 * would catch some idle cycle already in flight and starve the drain
 * the test needs. The predicate must become true before the intended
 * cycle reaches the barrier; a flag set by the handler gives that cycle
 * a causal name. Undefined everywhere else.
 *
 * The second seam, the drain's SYNC gate (`syncGate` / `syncGateWhen`,
 * the seal→outcome-window pin): the serving drain awaits the sidecar
 * doc's `syncCell` BEFORE any entry's in-flight guard check, so a drain
 * parked here (after the real sync — the doc IS synced; only the drain's
 * continuation is held) reaches the guard check exactly when the test
 * lets it. `syncGateWhen` receives the synced doc's id. */
class GatedStorageManager extends EmulatedStorageManager {
  static loadParkRecoveryGeneration = 0;

  static signalLoadRecovery(manager: GatedStorageManager): void {
    const failedEpoch = `test:load-park:${this.loadParkRecoveryGeneration}`;
    this.loadParkRecoveryGeneration += 1;
    manager.loadRecoveryObserver?.({
      failedEpoch,
      recoveryEpoch: `test:load-park:${this.loadParkRecoveryGeneration}`,
    });
  }

  static override connectTo(
    server: MemoryV2Server.Server,
    options: Parameters<typeof EmulatedStorageManager.connectTo>[1],
  ): GatedStorageManager {
    return super.connectTo(server, options) as GatedStorageManager;
  }

  settleGate: Promise<void> | undefined;
  settleGateWhen: (() => boolean) | undefined;
  syncGate: Promise<void> | undefined;
  syncGateWhen: ((id: string) => boolean) | undefined;

  /** How many syncs the sync gate has parked (a pin's evidence that a
   * drain WAS held in the window it constructs). */
  syncGateHits = 0;

  override async inputSynced(): Promise<void> {
    await super.inputSynced();
    if (this.settleGate !== undefined && (this.settleGateWhen?.() ?? true)) {
      await this.settleGate;
    }
  }

  /** The third seam, a sidecar whose sync FAILS transiently (the
   * arrival-order pin): while armed, a matching doc's `syncCell` throws
   * — the drain's sidecar-sync-failure arm, one of the two deferral
   * arms events.md §2's arrival order must survive (the other, the
   * index-addressed view-lag check, is the same barrier contract at the
   * same seam; its live shape is asynchronous frame delivery under
   * load, OW45 arm B's b01 red). STATIC on purpose: the host may rotate
   * runtime tenures (each with a fresh manager), and the seam must hold
   * across every tenure of the pass under test. */
  static syncThrowWhen: ((id: string) => boolean) | undefined;

  /** How many syncs the throw seam refused — each drain pass that
   * touched the failing sidecar counts one. */
  static syncThrowHits = 0;

  /** The FOURTH seam, the HEAD-EVENT LOAD-PARK FAILURE arm (the OW45
   * residue member's live shape): a served event's dispatch preflight
   * parks on an in-flight replica load its closure reads, and that
   * load FAILS. In production the failure is a serving session revoked
   * by the genesis ACL landing after activation — transient, healing
   * on the next mount, and NOT events.md §5's "no runnable handler".
   * While armed, the named doc reads as an in-flight load (so a head
   * event whose closure reads it parks) and the park's settle REJECTS
   * with that error's text. STATIC for the same reason as the sync
   * throw seam: the host may rotate runtime tenures, and the seam must
   * hold across every tenure of the pass under test. */
  static loadParkFailDocId: string | undefined;
  /** The armed doc's address, reported as pending while armed. */
  static loadParkFailAddress:
    | { space: MemorySpace; scope: "space"; id: string }
    | undefined;
  /** How many head-event load parks the seam has failed — a pin's
   * evidence that the park was REACHED, not merely armed. */
  static loadParkFailHits = 0;

  /** The park key is `space/scopeKey/id` (scheduler/keys.ts); the
   * scope key resolves against the runtime's identity, so match on the
   * id suffix rather than re-deriving it here. */
  static #matchesArmedDoc(key: string): boolean {
    const id = GatedStorageManager.loadParkFailDocId;
    return id !== undefined && key.endsWith(`/${id}`);
  }

  override pendingLoadAddresses(): ReturnType<
    EmulatedStorageManager["pendingLoadAddresses"]
  > {
    const real = super.pendingLoadAddresses();
    const armed = GatedStorageManager.loadParkFailAddress;
    if (armed === undefined) return real;
    return [...real, armed] as ReturnType<
      EmulatedStorageManager["pendingLoadAddresses"]
    >;
  }

  override pendingLoadGeneration(key: string): number | undefined {
    if (GatedStorageManager.#matchesArmedDoc(key)) return 1;
    return super.pendingLoadGeneration(key);
  }

  /** When set, the armed doc's park settle returns THIS promise instead of
   * rejecting at once — so a pin can hold a park OPEN until it has arranged
   * the state under test (e.g. a later-arrived entry actually QUEUED behind
   * the parked head), then fail it on command. Without it the rejection is
   * immediate and the state a pin wants to construct may never exist. The
   * scheduler-level pins use the same `Promise.withResolvers` idiom. */
  static loadParkSettle: Promise<void> | undefined;

  override loadsSettled(keys: readonly string[]): Promise<void> {
    if (keys.some((key) => GatedStorageManager.#matchesArmedDoc(key))) {
      GatedStorageManager.loadParkFailHits += 1;
      const held = GatedStorageManager.loadParkSettle;
      const failure = (cause: unknown) =>
        new ReplicaLoadFailureError({
          failureClass: "session-revoked",
          recoveryEpoch:
            `test:load-park:${GatedStorageManager.loadParkRecoveryGeneration}`,
          permanentEvidence: false,
        }, cause);
      if (held !== undefined) {
        return held.catch((cause) => Promise.reject(failure(cause)));
      }
      return Promise.reject(failure(
        new Error("memory session revoked: unauthorized (pin seam)"),
      ));
    }
    return super.loadsSettled(keys);
  }

  override async syncCell<T>(
    cell: Cell<T>,
    options?: Parameters<EmulatedStorageManager["syncCell"]>[1],
  ): Promise<Cell<T>> {
    if (
      GatedStorageManager.syncThrowWhen?.(
        cell.getAsNormalizedFullLink().id,
      ) === true
    ) {
      GatedStorageManager.syncThrowHits += 1;
      throw new Error("emulated transient sidecar sync failure (pin seam)");
    }
    const synced = await super.syncCell(cell, options);
    if (
      this.syncGate !== undefined &&
      (this.syncGateWhen?.(cell.getAsNormalizedFullLink().id) ?? true)
    ) {
      this.syncGateHits += 1;
      await this.syncGate;
    }
    return synced;
  }
}

const spaceSigner = await Identity.fromPassphrase("events down space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("events down service");
const aliceSigner = await Identity.fromPassphrase("events down alice");
const bobSigner = await Identity.fromPassphrase("events down bob");

/** The TRUE sidecar doc ids in the store (the client derives the id
 * from the RESOLVED stream link — a pattern's stream resolves into an
 * internal fid doc, so tests read the ids back from the head prefix
 * rather than re-deriving them). */
const sidecarIdsIn = (engine: Engine.Engine): string[] =>
  (engine.database.prepare(
    `SELECT id FROM head WHERE id LIKE 'of:stream-events:%' AND op != 'delete'`,
  ).all() as Array<{ id: string }>).map((row) => row.id);

const waitUntil = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const BUMP_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const bump = handler<unknown, { value: Writable<number> }>(",
  "  (_ev, { value }) => { value.set((value.get() ?? 0) + 1); },",
  ");",
  "export default pattern<",
  "  { value: Writable<number> },",
  "  { value: number; bump: Stream<unknown> }",
  ">(({ value }) => ({ value, bump: bump({ value }) }));",
].join("\n");

const CASCADE_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const secondHandler = handler<unknown, { value: Writable<number> }>(",
  "  (_ev, { value }) => { value.set((value.get() ?? 0) + 10); },",
  ");",
  "const firstHandler = handler<",
  "  unknown,",
  "  { value: Writable<number>; second: Stream<unknown> }",
  ">((_ev, { value, second }) => {",
  "  value.set((value.get() ?? 0) + 1);",
  "  second.send({});",
  "});",
  "export default pattern<",
  "  { value: Writable<number> },",
  "  { value: number; first: Stream<unknown>; second: Stream<unknown> }",
  ">(({ value }) => {",
  "  const second = secondHandler({ value });",
  "  return { value, first: firstHandler({ value, second }), second };",
  "});",
].join("\n");

const THROW_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const explode = handler<unknown, { value: Writable<number> }>(",
  "  () => { throw new Error('handler exploded deliberately'); },",
  ");",
  "export default pattern<",
  "  { value: Writable<number> },",
  "  { value: number; explode: Stream<unknown> }",
  ">(({ value }) => ({ value, explode: explode({ value }) }));",
].join("\n");

/** A handler whose `$ctx` requires a plain-number `gate` the argument doc
 * does not hold at fire time: the served dispatch's argument read fails the
 * schema (`isValidArgument === false`, runner.ts's "-- not running" skip)
 * until a later authored write supplies it — the mark/effects-atomicity
 * pin's reproduction of the a04 write-side member. */
const GATED_BUMP_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const bump = handler<unknown, { value: Writable<number>; gate: number }>(",
  "  (_ev, { value, gate }) => {",
  "    value.set((value.get() ?? 0) + 1 + gate * 0);",
  "  },",
  ");",
  "export default pattern<",
  "  { value: Writable<number>; gate: Writable<number> },",
  "  { value: number; bump: Stream<unknown> }",
  ">(({ value, gate }) => ({ value, bump: bump({ value, gate }) }));",
].join("\n");

/** Two independent streams whose handlers append their letter to ONE
 * shared log — the arrival-order pin reads the log as the record of
 * consequence order. */
const ORDERED_LOG_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const pushA = handler<unknown, { log: Writable<string[]> }>(",
  "  (_ev, { log }) => { log.set([...(log.get() ?? []), 'A']); },",
  ");",
  "const pushB = handler<unknown, { log: Writable<string[]> }>(",
  "  (_ev, { log }) => { log.set([...(log.get() ?? []), 'B']); },",
  ");",
  "export default pattern<",
  "  { log: Writable<string[]> },",
  "  { log: string[]; a: Stream<unknown>; b: Stream<unknown> }",
  ">(({ log }) => ({ log, a: pushA({ log }), b: pushB({ log }) }));",
].join("\n");

/** The ORDERED_LOG_PATTERN's sibling with DISJOINT handler closures: `pushA`
 * additionally reads `gate`, which the test links to a SEPARATE doc, while
 * `pushB` reads only the shared log. Arming the load-park failure on the gate
 * doc therefore parks stream `a`'s head event and leaves stream `b`'s handler
 * perfectly runnable — the construction the in-queue arrival-order barrier
 * actually needs. (In the shared-closure pattern a later-arrived B parks on
 * the same failing doc and self-defers through the HEAD arm, so removing the
 * barrier changes nothing and the pin cannot discriminate it — independent
 * review F3.) */
const DISJOINT_CLOSURE_LOG_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const pushA = handler<",
  "  unknown,",
  "  { log: Writable<string[]>; gate: Writable<number> }",
  ">((_ev, { log, gate }) => {",
  "  gate.get();",
  "  log.set([...(log.get() ?? []), 'A']);",
  "});",
  "const pushB = handler<unknown, { log: Writable<string[]> }>(",
  "  (_ev, { log }) => { log.set([...(log.get() ?? []), 'B']); },",
  ");",
  "export default pattern<",
  "  { log: Writable<string[]>; gate: Writable<number> },",
  "  { log: string[]; a: Stream<unknown>; b: Stream<unknown> }",
  ">(({ log, gate }) => ({ log, a: pushA({ log, gate }), b: pushB({ log }) }));",
].join("\n");

/** DISJOINT_CLOSURE_LOG_PATTERN's shape with GATED_BUMP's plain-number
 * gate: `pushA`'s `$ctx` requires `gate: number`, which the argument doc
 * does not hold at fire time — its served dispatch hits the runner's
 * argument-did-not-resolve skip and is WITHDRAWN (handler-not-run) —
 * while `pushB`'s closure reads only the shared log and is perfectly
 * runnable. The construction the handler-not-run arrival-order barrier
 * pin needs (review-6459 F1): a healthy later arrival queued behind a
 * withdrawn head. */
const GATED_ORDERED_LOG_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const pushA = handler<unknown, { log: Writable<string[]>; gate: number }>(",
  "  (_ev, { log, gate }) => {",
  "    log.set([...(log.get() ?? []), gate * 0 === 0 ? 'A' : 'never']);",
  "  },",
  ");",
  "const pushB = handler<unknown, { log: Writable<string[]> }>(",
  "  (_ev, { log }) => { log.set([...(log.get() ?? []), 'B']); },",
  ");",
  "export default pattern<",
  "  { log: Writable<string[]>; gate: Writable<number> },",
  "  { log: string[]; a: Stream<unknown>; b: Stream<unknown> }",
  ">(({ log, gate }) => ({ log, a: pushA({ log, gate }), b: pushB({ log }) }));",
].join("\n");

// OW54's refused-commit class (verification-coverage.md §3): a stored
// envelope whose `result.anyOf` carries TWO ifc branches is genuinely
// ambiguous — the class the RULING-5 narrowing still refuses
// (cfc/schema-merge.ts). The FIRST writer's commit lands (nothing is
// stored yet, so no merge runs), poisoning the stored envelope; every
// later merging writer's commit-prep records the refusal and the
// commit is rejected PRE-STORAGE with the "CFC enforcement rejected
// commit" message class (extended-storage-transaction.ts). The
// fixtures mirror cfc-prepare-crash-surfacing.test.ts, which pins the
// mechanism at the transaction level; here the same refusal lands on a
// SERVED event's commit, where it classifies as a give-up disposition
// (scheduler/events.ts).
const ow54ProfileViewSchema: JSONSchema = {
  type: "object",
  properties: {
    name: { type: "string", ifc: { confidentiality: ["secret"] } },
  },
} as JSONSchema;

const ow54AltProfileViewSchema: JSONSchema = {
  type: "string",
  ifc: { confidentiality: ["other"] },
} as JSONSchema;

const ow54AmbiguousEnvelopeSchema: JSONSchema = {
  type: "object",
  properties: {
    result: {
      anyOf: [
        ow54ProfileViewSchema,
        ow54AltProfileViewSchema,
      ],
    },
    candidates: { type: "array", items: ow54ProfileViewSchema },
  },
} as JSONSchema;

describe("Phase 3 events-down (serving side)", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: EmulatedStorageManager;
  let clientRuntime: Runtime;
  let extraManagers: EmulatedStorageManager[];
  let extraRuntimes: Runtime[];

  /** The live serving runtime/manager (set by newHost's createRuntime)
   * — the C8d raced-cascade test reads sealed state through them and
   * closes the settle gate. */
  let servingRuntime: Runtime | undefined;
  let servingManager: GatedStorageManager | undefined;
  let rejectWaveCommitWhen: ((batch: WaveSpaceCommit) => boolean) | undefined;
  let rejectWaveCommitWith:
    | ((batch: WaveSpaceCommit) => WaveCommitRejection | undefined)
    | undefined;
  let rejectedWaveCommits = 0;
  let gateWaveCommitWhen: ((batch: WaveSpaceCommit) => boolean) | undefined;
  let waveCommitGate: Promise<void> | undefined;
  let waveCommitGateHits = 0;
  let observedWaveCommits: WaveSpaceCommit[];
  type ServingCommitFailure =
    | "result-error"
    | "rejection"
    | "synchronous-throw";
  let failNextServingCommit: ServingCommitFailure | undefined;
  let failServingCommitSequence: ServingCommitFailure[];
  let failServingCommitActionPrefix: string | undefined;

  const decorateWaveCommitSink = (sink: WaveCommitSink): WaveCommitSink => ({
    currentHeads: (space, docs) => sink.currentHeads(space, docs),
    concurrentWritePaths: (space, doc, sinceSeq) =>
      sink.concurrentWritePaths(space, doc, sinceSeq),
    commitWave: (batch) => {
      const typedRejection = rejectWaveCommitWith?.(batch);
      if (typedRejection !== undefined) {
        rejectWaveCommitWith = undefined;
        rejectedWaveCommits += 1;
        return Promise.resolve({ error: typedRejection });
      }
      if (rejectWaveCommitWhen?.(batch) === true) {
        rejectWaveCommitWhen = undefined;
        rejectedWaveCommits += 1;
        return Promise.resolve({
          error: {
            name: "WaveCommitRejected",
            message: "forced OW54 processing-state write rejection",
          },
        });
      }
      if (
        waveCommitGate !== undefined && gateWaveCommitWhen?.(batch) === true
      ) {
        const gate = waveCommitGate;
        gateWaveCommitWhen = undefined;
        waveCommitGateHits += 1;
        return gate.then(() => {
          observedWaveCommits.push(batch);
          return sink.commitWave(batch);
        });
      }
      observedWaveCommits.push(batch);
      return sink.commitWave(batch);
    },
  });

  const newHost = (
    policy?: ConstructorParameters<typeof ExecutorHost>[0]["policy"],
  ): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = GatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: {
            serverExecution: true,
          },
        });
        const edit = runtime.edit.bind(runtime);
        runtime.edit = (options) => {
          const tx = edit(options);
          const commit = tx.commit.bind(tx);
          tx.commit = () => {
            const sequenceFailure = failServingCommitSequence[0];
            const failure = sequenceFailure ?? failNextServingCommit;
            const actionId = waveRunContextOf(tx)?.actionId;
            if (
              failure === undefined ||
              failServingCommitActionPrefix === undefined ||
              !actionId?.startsWith(failServingCommitActionPrefix)
            ) {
              return commit();
            }
            if (sequenceFailure === undefined) {
              failNextServingCommit = undefined;
              failServingCommitActionPrefix = undefined;
            } else {
              failServingCommitSequence.shift();
              if (failServingCommitSequence.length === 0) {
                failServingCommitActionPrefix = undefined;
              }
            }
            const error = new Error(`forced serving commit ${failure}`);
            if (failure === "result-error") {
              return Promise.resolve({
                error: {
                  name: "StorageTransactionAborted" as const,
                  message: error.message,
                  reason: error,
                },
              });
            }
            if (failure === "rejection") return Promise.reject(error);
            throw error;
          };
          return tx;
        };
        servingRuntime = runtime;
        servingManager = manager;
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: policy ?? { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      decorateWaveCommitSink,
    });

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    GatedStorageManager.loadParkRecoveryGeneration = 0;
    extraManagers = [];
    extraRuntimes = [];
    servingRuntime = undefined;
    servingManager = undefined;
    rejectWaveCommitWhen = undefined;
    rejectWaveCommitWith = undefined;
    rejectedWaveCommits = 0;
    gateWaveCommitWhen = undefined;
    waveCommitGate = undefined;
    waveCommitGateHits = 0;
    observedWaveCommits = [];
    failNextServingCommit = undefined;
    failServingCommitSequence = [];
    failServingCommitActionPrefix = undefined;
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    for (const runtime of extraRuntimes) await runtime.dispose();
    for (const manager of extraManagers) await manager.close();
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  const openClient = (
    signer: Identity = aliceSigner,
  ): { manager: EmulatedStorageManager; runtime: Runtime } => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    return { manager, runtime };
  };

  /** Compile + run a pattern on `runtime`, returning its cells. */
  const standUp = async (
    runtime: Runtime,
    source: string,
    names: { arg: string; result: string },
  ) => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    }, { space });
    const argument = runtime.getCell<{ value: number }>(
      space,
      names.arg,
      undefined,
    );
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      names.result,
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = runtime.edit();
      argument.withTx(seed).set({ value: 0 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    return { compiled, argument, result };
  };

  it("the full loop: fire → drain → authoritative handler → ONE derived commit with consequenceOf + mark + watermark → echo retires", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "full-arg",
      result: "full-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    const before = Engine.serverSeq(engine);
    // The durable-ack coupling (verdict blocker, 2026-08-12): the send's
    // settle callback fires from the append + authoritative consequence
    // outcome — captured here, asserted after the consequence lands.
    let ackStatus: string | undefined;
    (result.key("bump") as unknown as {
      send(
        value: unknown,
        onCommit?: (tx: { status(): { status: string } }) => void,
      ): unknown;
    }).send({}, (ackTx) => {
      ackStatus = ackTx.status().status;
    });
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    // The speculative echo alone is NOT the acknowledgment: nothing has
    // consequenced yet.
    expect(ackStatus).toBeUndefined();

    // The serving side processes the event: the sidecar entry is
    // marked consequenced and the per-stream watermark advances to its
    // seq — in the SAME derived commit as the handler's consequence
    // (events.md §4).
    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the event append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        const entry = value?.entries?.[0];
        return entry?.consequenced === true &&
          value?.eventWatermark === entry?.seq;
      },
      "the entry to consequence and the stream watermark to advance",
    );
    const sidecar = Engine.read(engine, { id: sidecarId })
      ?.value as StreamEventsDocValue;
    const entry = sidecar.entries![0];
    expect(entry.firedAt?.user).toBe(aliceSigner.did());
    expect(entry.error).toBeUndefined();
    expect(entry.status).toBeUndefined();

    // ONE derived commit carries consequenceOf = [the event] AND the
    // durable consequence (the argument doc's bump).
    const consequenceRows = engine.database.prepare(
      `SELECT seq, consequence_of FROM "commit"
       WHERE seq > :from_seq AND class = 'derived'
         AND consequence_of IS NOT NULL`,
    ).all({ from_seq: before }) as Array<
      { seq: number; consequence_of: string }
    >;
    const carrying = consequenceRows.filter((row) =>
      row.consequence_of.includes(entry.eventId)
    );
    expect(carrying.length).toBe(1);
    const carryingBatch = observedWaveCommits.find((batch) =>
      batch.consequenceOf.includes(entry.eventId)
    );
    expect(carryingBatch).toBeDefined();
    expect(JSON.stringify(carryingBatch!.operations)).not.toContain(
      "deliveryDeferral",
    );
    await waitUntil(
      () => {
        const doc = Engine.read(engine, {
          id: argument.getAsNormalizedFullLink().id,
        });
        return ((doc?.value as { value?: number })?.value ?? 0) === 1;
      },
      "the handler consequence to land durably",
    );

    // The client: the echo retired (the consequence signal — or the
    // watermark backstop — withdrew it) and the authoritative value
    // renders through the store.
    await waitUntil(
      () => (clientRuntime.speculationOverlay?.entryCount(space) ?? 0) === 0,
      "the echo to retire",
    );
    await waitUntil(
      () => (argument.key("value").get() as number | undefined) === 1,
      "the authoritative value to render",
    );

    // Counters (testing.md §4): the drain counted the event.
    const stats = host!.stats();
    expect(stats.events.appended).toBeGreaterThanOrEqual(1);
    expect(stats.events.processed).toBeGreaterThanOrEqual(1);
    // The durable ack settled — from the DELIVERED append and the
    // consequenced handling, not the local echo — and reads non-error.
    await waitUntil(
      () => ackStatus !== undefined,
      "the durable-ack settle callback",
    );
    expect(ackStatus).not.toBe("error");
    cancelDemand();
  });

  it("exactly-once under an HONEST flush deadline (stage C tuning): a fire that lands while the serving scheduler is mid-settle is drained ONCE — the re-drains that follow every cut cycle skip the still-in-flight copy; the counter reads exactly 1 and ONE commit consequences the event (mutation: the drain's in-flight guard removed → a copy per cut cycle, processed ≫ appended, value ≫ 1)", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "inflight-arg",
      result: "inflight-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // T3's honest deadline: cycles are cut every 100 ms of settle. The
    // host activates on the next ADMISSION (the client's session was
    // already open): a plain authored write triggers it, so the serving
    // runtime exists before the walk is registered.
    host = newHost({ flushDeadlineMs: 100, idleParkMs: 600_000 });
    {
      const poke = clientRuntime.getCell<{ n: number }>(
        space,
        "inflight-activate",
        undefined,
      );
      const tx = clientRuntime.edit();
      poke.withTx(tx).set({ n: 1 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space to activate",
    );
    // Let the boot serve settle so the walk below is the only work.
    const bootSeq = Engine.serverSeq(engine);
    await waitUntil(
      () => readWatermarkSeq(engine) >= bootSeq,
      "the boot serve to settle",
      15_000,
    );
    // A synthetic 1.2-s settle on the SERVING runtime (30 × 40 ms of
    // synchronous work, one sealed write each): the fire's dispatch waits
    // behind it, and ~10 cut cycles re-drain the still-pending entry
    // meanwhile.
    const serving = servingRuntime!;
    const trigger = serving.getCell<{ value: number }>(
      space,
      "inflight-walk-trigger",
      undefined,
    );
    for (let step = 0; step < 30; step++) {
      const out = serving.getCell<{ step: number }>(
        space,
        `inflight-walk-out-${step}`,
        undefined,
      );
      const walk = (tx: IExtendedStorageTransaction): void => {
        trigger.withTx(tx).get();
        const until = performance.now() + 40;
        while (performance.now() < until) {
          // spin
        }
        out.withTx(tx).set({ step });
      };
      serving.scheduler.register(walk, undefined, { isEffect: true });
    }
    // Fire NOW: the append lands mid-walk.
    result.key("bump").send({});
    await clientRuntime.storageManager.synced();

    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the event append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        return value?.entries?.[0]?.consequenced === true;
      },
      "the entry to consequence",
      20_000,
    );
    // Let any duplicate copy that was queued run its course before the
    // negative assertions.
    await serving.idle();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await serving.idle();
    const entry = (Engine.read(engine, { id: sidecarId })
      ?.value as StreamEventsDocValue).entries![0];
    const stats = host.stats();
    // THE PIN: one durable entry, ONE delivery, ONE consequence commit,
    // the counter incremented exactly once — with the guard having
    // skipped at least one re-drain (the cut cycles did re-scan).
    expect(stats.events.appended).toBe(1);
    expect(stats.events.processed).toBe(1);
    expect(stats.events.drainInFlightSkips).toBeGreaterThanOrEqual(1);
    const carrying = (engine.database.prepare(
      `SELECT seq, consequence_of FROM "commit"
       WHERE class = 'derived' AND consequence_of IS NOT NULL`,
    ).all() as Array<{ seq: number; consequence_of: string }>).filter((
      row,
    ) => row.consequence_of.includes(entry.eventId));
    expect(carrying.length).toBe(1);
    const doc = Engine.read(engine, {
      id: argument.getAsNormalizedFullLink().id,
    });
    expect((doc?.value as { value?: number })?.value).toBe(1);
    cancelDemand();
  });

  it("the guard holds through the SEAL→OUTCOME window (stage C tuning; self-review finding 1): a re-drain that reaches the entry AFTER its copy's consequence has SEALED into a wave the store has not yet committed skips it — the copy is released by the wave OUTCOME, never at seal (mutation: release at the seal → that re-drain queues a second copy: processed 2, value 2)", async () => {
    // The window the exactly-once pin above cannot see (it passes with
    // EITHER release point): the copy's mark rides an uncommitted wave
    // while the entry is still pending in the store, and a re-drain
    // whose guard check lands in that window must still skip. Held
    // deterministically here: the re-drain is parked at the sidecar
    // sync (which the drain awaits BEFORE any entry's guard check) until
    // the copy's consequence is visible SEALED on the serving overlay
    // and — witnessed — NOT in the store; then the drain proceeds to the
    // check.
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "sealwindow-arg",
      result: "sealwindow-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost({ flushDeadlineMs: 100, idleParkMs: 600_000 });
    {
      const poke = clientRuntime.getCell<{ n: number }>(
        space,
        "sealwindow-activate",
        undefined,
      );
      const tx = clientRuntime.edit();
      poke.withTx(tx).set({ n: 1 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space to activate",
    );
    const bootSeq = Engine.serverSeq(engine);
    await waitUntil(
      () => readWatermarkSeq(engine) >= bootSeq,
      "the boot serve to settle",
      15_000,
    );
    // The serving-side view of the consequence doc: a SEALED write is
    // visible through it (the open wave's overlay) before the store
    // holds it. Synced before the fire.
    const serving = servingRuntime!;
    const servingArg = serving.getCell<{ value: number }>(
      space,
      "sealwindow-arg",
      undefined,
    );
    await servingArg.sync();
    const argId = argument.getAsNormalizedFullLink().id;
    const storedValue = (): number | undefined =>
      (Engine.read(engine, { id: argId })?.value as
        | { value?: number }
        | undefined)?.value;
    expect(storedValue()).toBe(0);

    // The same 1.2-s synthetic walk as above, ahead of the fire: the
    // copy's dispatch queues BEHIND it (events run at the next execute
    // pass), the honest deadline cuts cycles meanwhile, and every cut
    // cycle re-drains the still-pending entry.
    const trigger = serving.getCell<{ value: number }>(
      space,
      "sealwindow-walk-trigger",
      undefined,
    );
    const outs: Cell<{ step: number }>[] = [];
    for (let step = 0; step < 30; step++) {
      const out = serving.getCell<{ step: number }>(
        space,
        `sealwindow-walk-out-${step}`,
        undefined,
      );
      outs.push(out);
      const walk = (tx: IExtendedStorageTransaction): void => {
        trigger.withTx(tx).get();
        const until = performance.now() + 40;
        while (performance.now() < until) {
          // spin
        }
        out.withTx(tx).set({ step });
      };
      serving.scheduler.register(walk, undefined, { isEffect: true });
    }
    // The walk is under way (its first step sealed) before the fire, so
    // the copy is queued mid-walk, never ahead of it.
    await waitUntil(() => outs[0].get() !== undefined, "the walk to start");

    // The sync gate: engaged for RE-drains only — the drain that queues
    // the copy counts it at its end (`processed`), so the first drain
    // passes and every later one parks after its sidecar sync.
    const gate = Promise.withResolvers<void>();
    servingManager!.syncGate = gate.promise;
    servingManager!.syncGateWhen = (id) =>
      id.startsWith("of:stream-events:") &&
      host!.stats().events.processed >= 1;
    let sidecarId: string;
    try {
      result.key("bump").send({});
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => sidecarIdsIn(engine).length === 1,
        "the event append to land",
      );
      sidecarId = sidecarIdsIn(engine)[0];
      await waitUntil(
        () => host!.stats().events.processed === 1,
        "the copy to be queued once",
      );
      // The copy runs after the walk and its consequence SEALS — visible
      // on the serving overlay while the store still holds the pre-fire
      // value and the entry is unconsequenced: the seal→outcome window
      // is open, and a re-drain is parked in it (the gate was hit).
      await waitUntil(
        () => (servingArg.key("value").get() as number | undefined) === 1,
        "the copy's consequence to SEAL into the open wave",
        20_000,
      );
      expect(storedValue()).toBe(0);
      const sealedEntry = (Engine.read(engine, { id: sidecarId })
        ?.value as StreamEventsDocValue).entries![0];
      expect(sealedEntry.consequenced).not.toBe(true);
      expect(servingManager!.syncGateHits).toBeGreaterThanOrEqual(1);
      expect(host!.stats().events.processed).toBe(1);
      // Let the parked re-drain reach the entry's guard check now — copy
      // sealed, wave uncommitted.
      gate.resolve();
    } finally {
      gate.resolve();
      servingManager!.syncGate = undefined;
      servingManager!.syncGateWhen = undefined;
    }

    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        return value?.entries?.[0]?.consequenced === true;
      },
      "the entry to consequence",
      20_000,
    );
    // Let any duplicate copy that was queued run its course before the
    // negative assertions.
    await serving.idle();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await serving.idle();
    const entry = (Engine.read(engine, { id: sidecarId })
      ?.value as StreamEventsDocValue).entries![0];
    const stats = host.stats();
    // THE PIN: the re-drain that reached the check inside the window
    // SKIPPED the sealed copy (the guard held it `marked` until the wave
    // outcome) — one delivery, ONE consequence commit, value 1. Released
    // at the seal instead, that re-drain queues the second copy:
    // processed 2, value 2.
    expect(stats.events.appended).toBe(1);
    expect(stats.events.processed).toBe(1);
    expect(stats.events.drainInFlightSkips).toBeGreaterThanOrEqual(1);
    const carrying = (engine.database.prepare(
      `SELECT seq, consequence_of FROM "commit"
       WHERE class = 'derived' AND consequence_of IS NOT NULL`,
    ).all() as Array<{ seq: number; consequence_of: string }>).filter((
      row,
    ) => row.consequence_of.includes(entry.eventId));
    expect(carrying.length).toBe(1);
    expect(storedValue()).toBe(1);
    cancelDemand();
  });

  it("exactly-once across restart: an append committed with NO host drains once at activation; a second activation re-runs nothing (serving-loop §6 step 4)", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "restart-arg",
      result: "restart-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // Fire with NO serving host: the append commits durably; nothing
    // processes it — the kill-between-event-and-consequence window.
    result.key("bump").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the event append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    {
      const value = Engine.read(engine, { id: sidecarId })?.value as
        | StreamEventsDocValue
        | undefined;
      expect(value?.entries?.length).toBe(1);
      expect(value?.entries?.[0].consequenced).toBeUndefined();
    }

    // "Restart": the host comes up. A real restart's clients RECONNECT
    // (session open → the activation hook); the emulated fixture keeps
    // sessions alive across the host swap, so an authored poke stands
    // in for the reconnect. Activation's reprocess scan (§6 step 4)
    // then drains the undelivered event exactly once.
    host = newHost();
    {
      const poke = clientRuntime.edit();
      clientRuntime.getCell<number>(space, "restart-activate", undefined)
        .withTx(poke).set(1);
      expect((await poke.commit()).error).toBeUndefined();
    }
    await waitUntil(
      () => {
        const doc = Engine.read(engine, {
          id: argument.getAsNormalizedFullLink().id,
        });
        return ((doc?.value as { value?: number })?.value ?? 0) === 1;
      },
      "the recovered event's consequence",
    );
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        return value?.entries?.[0].consequenced === true;
      },
      "the recovered entry to be marked",
    );

    // Kill AFTER consequences; reactivate: the idempotency rule replays
    // nothing — the consequence value stays exactly-once.
    await host.close();
    host = newHost();
    // A fresh authored poke activates the space again.
    const poke = clientRuntime.edit();
    clientRuntime.getCell<number>(space, "restart-poke", undefined)
      .withTx(poke).set(1);
    expect((await poke.commit()).error).toBeUndefined();
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "reactivation",
    );
    // Give the loop a settle: the value must never reach 2. The
    // negative is sharpened past the bare value read (round-2 thread
    // T24): a wrong re-run's consequence commit carries
    // consequence_of = [the event] — so count those DIRECTLY. Exactly
    // ONE such commit may ever exist, whatever else the loop commits
    // (watermark advances move the seq legitimately, so seq stability
    // is NOT the observable).
    const eventId = (Engine.read(engine, { id: sidecarId })
      ?.value as StreamEventsDocValue).entries![0].eventId;
    const consequenceCommitsFor = () =>
      (engine.database.prepare(
        `SELECT consequence_of FROM "commit"
         WHERE class = 'derived' AND consequence_of IS NOT NULL`,
      ).all() as Array<{ consequence_of: string }>).filter((row) =>
        row.consequence_of.includes(eventId)
      ).length;
    expect(consequenceCommitsFor()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    {
      const doc = Engine.read(engine, {
        id: argument.getAsNormalizedFullLink().id,
      });
      expect((doc?.value as { value?: number })?.value).toBe(1);
      expect(consequenceCommitsFor()).toBe(1);
    }
    cancelDemand();
  });

  it("rapid-fire coalescing under CONSTRUCTED queue depth (the RULED sx2-gate re-tensing, 2026-08-21 — owner: \"i like (3) as well\"): K events queued ahead of ONE drain yield K completed runs, each consequenced exactly once, in EXACTLY ONE consequence-carrying derived commit (D-v2-2's commit-level batching; testing.md §5 row 3's discriminating half)", async () => {
    // The live sx2-events surface cannot assert a derived-commit ratio:
    // its append queue serializes one commit round trip per event, so
    // how many appends a wave finds queued is the ratio of round-trip
    // time to wave time — a LOAD RATIO with no test lever (the census's
    // item-4 flake; ow-sx2-coalescing-gate.md §1 claim 1). This pin
    // CONSTRUCTS the criterion's premise instead: fire K with NO
    // serving host (each append commits durably, nothing processes
    // them), then bring the host up — the activation reprocess scan
    // (serving-loop.md §6 step 4) finds all K pending at once and the
    // wave takes the whole batch. With a flush deadline far above the
    // batch's work there is no deadline cut to split it, so the
    // batching contract is exact and load-independent: ONE derived
    // commit consequences all K (a per-handler-run commit — the v1
    // failure the criterion exists to catch — reads as K commits
    // here, deterministically).
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "coalesce-arg",
      result: "coalesce-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // Fire K with NO host: K durable, unconsequenced entries.
    const K = 10;
    for (let i = 0; i < K; i++) result.key("bump").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the stream sidecar to exist",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        return (value?.entries?.length ?? 0) === K;
      },
      "all K event appends to land durably",
    );
    const queued = Engine.read(engine, { id: sidecarId })
      ?.value as StreamEventsDocValue;
    expect(queued.entries!.every((e) => e.consequenced === undefined)).toBe(
      true,
    );
    const eventIds = queued.entries!.map((e) => e.eventId);
    expect(new Set(eventIds).size).toBe(K);
    const before = Engine.serverSeq(engine);

    // The host comes up with a flush deadline far above the batch's
    // work, so the wave cannot be deadline-cut mid-batch; the authored
    // poke stands in for the reconnect that activates the space (the
    // restart test's shape).
    host = newHost({ flushDeadlineMs: 60_000, idleParkMs: 600_000 });
    {
      const poke = clientRuntime.edit();
      clientRuntime.getCell<number>(space, "coalesce-activate", undefined)
        .withTx(poke).set(1);
      expect((await poke.commit()).error).toBeUndefined();
    }

    // All K non-idempotent effects apply exactly once: value === K.
    await waitUntil(
      () => {
        const doc = Engine.read(engine, {
          id: argument.getAsNormalizedFullLink().id,
        });
        return ((doc?.value as { value?: number })?.value ?? 0) === K;
      },
      "all K handler consequences to land",
    );
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        return value?.entries?.every((e) => e.consequenced === true) === true;
      },
      "every entry to be consequence-marked",
    );

    // Exactly-once per event AND the batching contract: the derived
    // commits after `before` that carry consequence_of must consequence
    // each of the K eventIds exactly once — and there must be EXACTLY
    // ONE such commit (the wave took the whole constructed batch).
    const carrying = engine.database.prepare(
      `SELECT seq, consequence_of FROM "commit"
       WHERE seq > :from_seq AND class = 'derived'
         AND consequence_of IS NOT NULL`,
    ).all({ from_seq: before }) as Array<
      { seq: number; consequence_of: string }
    >;
    for (const eventId of eventIds) {
      expect(
        carrying.filter((row) => row.consequence_of.includes(eventId)).length,
      ).toBe(1);
    }
    expect(carrying.length).toBe(1);

    // Counters agree (testing.md §4): K appended, K processed — and the
    // final value never overshoots (no double delivery hides in the
    // batch).
    const stats = host!.stats();
    expect(stats.events.appended).toBe(K);
    expect(stats.events.processed).toBe(K);
    await new Promise((resolve) => setTimeout(resolve, 250));
    {
      const doc = Engine.read(engine, {
        id: argument.getAsNormalizedFullLink().id,
      });
      expect((doc?.value as { value?: number })?.value).toBe(K);
    }
    cancelDemand();
  });

  it("mark/effects atomicity at the DISPATCH layer (events.md §4, RULED 2026-08-27 — the a04 write-side member): a served dispatch whose handler argument cannot resolve is WITHDRAWN, never sealed — the pre-stamped mark must not commit alone; the entry stays pending, re-drains once the argument resolves, and mark + effects land in ONE commit exactly once (mutation: the finalize withdrawal removed → the a04 1-op mark-only consequence, the event permanently consumed with zero effects)", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(
      clientRuntime,
      GATED_BUMP_PATTERN,
      { arg: "atomicity-arg", result: "atomicity-result" },
    );
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    const before = Engine.serverSeq(engine);
    (result.key("bump") as unknown as { send(value: unknown): unknown })
      .send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the event append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    const readEntry = () =>
      (Engine.read(engine, { id: sidecarId })?.value as
        | StreamEventsDocValue
        | undefined)?.entries?.[0];
    const argumentDocId = argument.getAsNormalizedFullLink().id;
    const argumentValue = () => {
      const doc = Engine.read(engine, { id: argumentDocId });
      return (doc?.value as { value?: number } | undefined)?.value ?? 0;
    };
    const deferrals = () =>
      (host!.stats().events as { handlerNotRunDeferrals?: number })
        .handlerNotRunDeferrals ?? 0;

    // The unresolvable dispatch resolves: post-fix as a counted
    // handler-not-run deferral with the entry still pending; PRE-FIX
    // (watched red) as the a04 shape — the entry consequenced with zero
    // effects before any deferral exists (seqs 53/56: a 1-op 802-byte
    // derived commit carrying ONLY the mark).
    await waitUntil(
      () => deferrals() >= 1 || readEntry()?.consequenced === true,
      "the unresolvable dispatch to resolve (deferral post-fix / mark pre-fix)",
    );
    expect(readEntry()?.consequenced).not.toBe(true);
    expect(readEntry()?.status).toBeUndefined();
    expect(readEntry()?.error).toBeUndefined();
    expect(argumentValue()).toBe(0);
    expect(deferrals()).toBeGreaterThanOrEqual(1);

    // Heal within the deferral budget: supply the gate. The standard
    // re-drain re-delivers and the retried handler's writes land.
    {
      const gateCell = clientRuntime.getCell<{ value: number; gate?: number }>(
        space,
        "atomicity-arg",
        undefined,
      );
      await gateCell.sync();
      const tx = clientRuntime.edit();
      gateCell.key("gate").withTx(tx).set(7);
      expect((await tx.commit()).error).toBeUndefined();
    }

    await waitUntil(
      () => readEntry()?.consequenced === true && argumentValue() === 1,
      "the re-delivered handler's mark + effects to land",
    );
    // (α) exactly once: the non-idempotent effect applied exactly once…
    expect(argumentValue()).toBe(1);
    const entry = readEntry()!;
    expect(entry.error).toBeUndefined();
    expect(entry.status).toBeUndefined();
    // …and exactly ONE durable derived commit names the event.
    const consequenceRows = engine.database.prepare(
      `SELECT seq, consequence_of FROM "commit"
       WHERE seq > :from_seq AND class = 'derived'
         AND consequence_of IS NOT NULL`,
    ).all({ from_seq: before }) as Array<
      { seq: number; consequence_of: string }
    >;
    const carrying = consequenceRows.filter((row) =>
      row.consequence_of.includes(entry.eventId)
    );
    expect(carrying.length).toBe(1);
    // The committing wave batch carries the mark AND the effect together
    // (the atomicity, stated positively): the sidecar's mark op and the
    // argument doc's bump ride ONE home commit.
    const carryingBatches = observedWaveCommits.filter((batch) =>
      batch.consequenceOf.includes(entry.eventId)
    );
    expect(carryingBatches.length).toBeGreaterThanOrEqual(1);
    const committedOps = carryingBatches[carryingBatches.length - 1].operations;
    expect(
      committedOps.some((op) => op.op !== "sqlite" && op.id === sidecarId),
    ).toBe(true);
    expect(
      committedOps.some((op) => op.op !== "sqlite" && op.id === argumentDocId),
    ).toBe(true);
    cancelDemand();
  });

  it('the handler-not-run withdrawal carries the arrival-order BARRIER (events.md §2 + §5, review-6459 F1): a later-arrived same-space served event queued behind the withdrawn head defers with it instead of overtaking, and the healed re-drain lands both consequences in arrival order (mutation: empty the finalize sweep → B seals while A is still pending and the durable log reads ["B","A"] against arrival [a1,b1] — the b01 inversion)', async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);

    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: GATED_ORDERED_LOG_PATTERN }],
    }, { space });
    // The gate is its OWN doc linked into the argument, seeded with a
    // present NON-NUMBER: pushA's `$ctx` schema read fails
    // deterministically (handler-not-run — never a load park, the doc
    // exists) until the heal writes a number, while pushB never reads
    // it. Its own doc also keeps the HEAL commit clean: pushB's
    // client-side speculative run leaves an unresolved overlay on the
    // argument doc while b1 is barrier-deferred server-side, and a heal
    // tx reading that doc would be refused (SpeculativeBasisError).
    const gateCell = clientRuntime.getCell<unknown>(
      space,
      "hnr-barrier-gate",
      undefined,
    );
    const argument = clientRuntime.getCell<{ log: string[]; gate?: unknown }>(
      space,
      "hnr-barrier-arg",
      undefined,
    );
    const result = clientRuntime.getCell<Record<string, unknown>>(
      space,
      "hnr-barrier-result",
      compiled.resultSchema,
    );
    await gateCell.sync();
    await argument.sync();
    await result.sync();
    {
      const seed = clientRuntime.edit();
      gateCell.withTx(seed).set({ pending: true });
      argument.withTx(seed).set({ log: [], gate: gateCell });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    const argumentId = argument.getAsNormalizedFullLink().id;
    const storedLog =
      (): string[] => ((Engine.read(engine, { id: argumentId })?.value as
        | { log?: string[] }
        | undefined)?.log ?? []);
    const send = (stream: "a" | "b") =>
      (result.key(stream) as unknown as { send(value: unknown): unknown })
        .send({});
    const stats = () =>
      host!.stats().events as {
        handlerNotRunDeferrals?: number;
        loadParkDeferrals?: number;
      };

    // a1 first (its handler requires the absent gate), b1 second
    // (healthy closure), each append awaited so the durable arrival
    // order is [a1, b1] by construction.
    send("a");
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () => sidecarIdsIn(engine).length >= 1,
      "a1's append to land",
    );
    send("b");
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () => sidecarIdsIn(engine).length === 2,
      "b1's append to land on its own sidecar",
    );

    // b1's dispatch resolves one way or the other: post-fix it is swept
    // behind the withdrawn a1 (an arrival-barrier deferral, counted in
    // loadParkDeferrals — "every head and barrier deferral"); PRE-FIX
    // (watched red) it dispatches next out of the same pass and SEALS
    // while a1 is still pending — the review's 213ms overtake probe,
    // stored log ["B"].
    await waitUntil(
      () =>
        (stats().handlerNotRunDeferrals ?? 0) >= 1 &&
        ((stats().loadParkDeferrals ?? 0) >= 1 || storedLog().length >= 1),
      "b1's dispatch to resolve (barrier post-fix / overtake pre-fix)",
    );
    expect(storedLog()).toEqual([]);

    // Heal the gate within the deferral budget — a write touching ONLY
    // the gate doc: the standard re-drain re-delivers BOTH entries, in
    // arrival order.
    {
      const tx = clientRuntime.edit();
      gateCell.withTx(tx).set(7);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await waitUntil(
      () => storedLog().length === 2,
      "both consequences to land after the heal",
      30_000,
    );
    // THE PIN: durable consequence order equals arrival order.
    expect(storedLog()).toEqual(["A", "B"]);
    cancelDemand();
  });

  it("a permanently unresolvable argument hardens into a §5 DROP whose notice names the REAL class (review-6459 F2): the handler was runnable and dispatched — the deferrals were withdrawn dispatches, not load attempts, and the durable drop record must not say otherwise", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { result } = await standUp(clientRuntime, GATED_BUMP_PATTERN, {
      arg: "notice-arg",
      result: "notice-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    (result.key("bump") as unknown as { send(value: unknown): unknown })
      .send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the event append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    const readEntry = () =>
      (Engine.read(engine, { id: sidecarId })?.value as
        | StreamEventsDocValue
        | undefined)?.entries?.[0];

    // NEVER heal the gate: the 250ms backstop re-dispatches the entry
    // through the whole 8-deferral budget (~2s), each dispatch
    // withdrawn (handler-not-run), and the terminal §5 notice seals.
    // This also exercises the threshold machinery end-to-end with THIS
    // cause (the review's coverage gap: it was code-traced, not
    // test-run).
    await waitUntil(
      () => readEntry()?.status === "dropped",
      "the terminal §5 DROP notice to seal",
      30_000,
    );
    const entry = readEntry()!;
    // THE PIN: the drop record names the real class. The old
    // boilerplate — "no runnable handler after 8 deferred load
    // attempts" — was false in both clauses for this cause: a handler
    // existed, loaded and runnable, and the deferrals were dispatches
    // whose transaction was withdrawn, not load attempts.
    expect(entry.reason).toContain(
      "handler did not run after 8 withdrawn dispatches",
    );
    expect(entry.reason).not.toContain("no runnable handler");
    // The underlying runner reason still rides the notice.
    expect(entry.reason).toContain("argument is undefined");
    // The disposition machinery is unchanged: counted, and the entry is
    // terminally consumed (the notice IS the consequence).
    expect(
      (host!.stats().events as { dropped?: number }).dropped ?? 0,
    ).toBeGreaterThanOrEqual(1);
    expect(entry.consequenced).toBe(true);
    cancelDemand();
  });

  it("the ERROR arm: a throwing handler's error IS the consequence — the entry carries it and the stream does not wedge (events.md §5)", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, THROW_PATTERN, {
      arg: "error-arg",
      result: "error-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    result.key("explode").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the event append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        const entry = value?.entries?.[0];
        return entry?.consequenced === true &&
          typeof entry?.error === "string" &&
          value?.eventWatermark === entry?.seq;
      },
      "the error consequence + frontier advance",
    );
    const value = Engine.read(engine, { id: sidecarId })
      ?.value as StreamEventsDocValue;
    expect(value.entries![0].error).toContain("handler exploded");
    // No consequence write landed: the arg doc holds the seed value.
    const doc = Engine.read(engine, {
      id: argument.getAsNormalizedFullLink().id,
    });
    expect((doc?.value as { value?: number })?.value).toBe(0);
    cancelDemand();
  });

  it("a typed CFC commit-preparation crash accumulates durable failed-state time, then seals one retained needs-attention cover without conflating it with a deterministic CFC refusal", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "ow54-arg",
      result: "ow54-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // Poison the stored envelope before the serving side exists: the
    // first writer's commit lands, and the stored envelope is then
    // genuinely ambiguous for every later merging writer.
    const poisonedDocName = "ow54-poisoned-envelope";
    {
      const tx = clientRuntime.edit();
      const cell = clientRuntime.getCell(
        space,
        poisonedDocName,
        ow54AmbiguousEnvelopeSchema,
        tx,
      );
      cell.set({ candidates: [{ name: "Bob" }] });
      tx.prepareCfc();
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    let deliveryNow = 10_000;
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      deliveryFailureBudgetMs: 60_000,
      deliveryFailureNow: () => deliveryNow,
    });
    // Warm-up fire through the pattern's own handler: activates the
    // space, lands the sidecar, and hands the probe its stream link.
    result.key("bump").send({ kind: "warmup" });
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the warm-up append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    const entriesOf = () => ((Engine.read(engine, { id: sidecarId })?.value as
      | StreamEventsDocValue
      | undefined)?.entries ?? []);
    const entryByKind = (kind: string) =>
      entriesOf().find((entry) =>
        (entry.payload as { kind?: string } | undefined)?.kind === kind
      );
    const watermarkNow = () =>
      (Engine.read(engine, { id: sidecarId })?.value as
        | StreamEventsDocValue
        | undefined)?.eventWatermark;
    await waitUntil(
      () => entryByKind("warmup")?.consequenced === true,
      "the warm-up event to consequence",
    );
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "the space to activate",
    );

    // The served dispatch target: the entry's self-describing stream
    // link (the same derivation the drain uses).
    const warmup = entryByKind("warmup")!;
    const streamLink = {
      space,
      id: warmup.stream.id as never,
      path: [...warmup.stream.path],
      scope: (warmup.stream.scope ?? "space") as never,
    };
    // The live ordering: the poisoned doc (and its label metadata) is
    // in the serving replica before the served handler's own
    // transaction preps.
    await servingRuntime!.getCell(
      space,
      poisonedDocName,
      ow54AmbiguousEnvelopeSchema,
    ).sync();

    // The probe replaces the pattern's handler on the serving runtime:
    // a served handler whose write meets the stored ambiguous envelope,
    // so its commit-prep records the refusal and the commit is rejected
    // before storage.
    const probeRuns = new Map<string, number>();
    const gatedRetryStarted = Promise.withResolvers<void>();
    const releaseGatedRetry = Promise.withResolvers<void>();
    const cancelProbe = servingRuntime!.scheduler.addEventHandler(
      async (tx, event) => {
        const kind = (event as { kind?: string }).kind ?? "unknown";
        const runs = (probeRuns.get(kind) ?? 0) + 1;
        probeRuns.set(kind, runs);
        if (kind === "gated-retry" && runs > 1) {
          gatedRetryStarted.resolve();
          await releaseGatedRetry.promise;
          return;
        }
        if (kind === "follower" || kind === "gated-follower") return;
        const resolved = servingRuntime!.getCell<{ name: string }>(
          space,
          `${poisonedDocName}-resolved`,
          ow54ProfileViewSchema,
          tx,
        );
        resolved.set({ name: "Ada" });
        servingRuntime!.getCell(
          space,
          poisonedDocName,
          ow54AmbiguousEnvelopeSchema,
          tx,
        ).set({ result: resolved, candidates: [] });
      },
      streamLink,
    );

    const beforePoison = Engine.serverSeq(engine);
    const consequenceCommitsNaming = (eventId: string) =>
      (engine.database.prepare(
        `SELECT seq, consequence_of FROM "commit"
         WHERE seq > :from_seq AND class = 'derived'
           AND consequence_of IS NOT NULL`,
      ).all({ from_seq: beforePoison }) as Array<
        { seq: number; consequence_of: string }
      >).filter((row) => row.consequence_of.includes(eventId));
    // Commit-preparation crashes are not deterministic CFC verdicts, so the
    // old dropped-write report must not claim one occurred.
    const droppedWriteReports: string[] = [];
    const realConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      const line = args.map((a) => String(a)).join(" ");
      if (line.includes("Owner-protected write dropped")) {
        droppedWriteReports.push(line);
        return;
      }
      realConsoleError(...args);
    };
    try {
      let poisonAckStatus: string | undefined;
      (result.key("bump") as unknown as {
        send(
          value: unknown,
          onCommit: (tx: { status(): { status: string } }) => void,
        ): unknown;
      }).send({ kind: "poison-1" }, (tx) => {
        poisonAckStatus = tx.status().status;
      });
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () =>
          entryByKind("poison-1")?.deliveryDeferral?.failureCount !==
            undefined,
        "the first durable commit-preparation checkpoint",
      );
      const deferred = entryByKind("poison-1")!;
      expect(deferred.consequenced).not.toBe(true);
      expect(deferred.error).toBeUndefined();
      expect(deferred.status).toBeUndefined();
      expect(deferred.deliveryDeferral).toMatchObject({
        phase: "commit-preparation",
        failureClass: "unknown",
        state: "failed",
      });

      // Spend the ratified cumulative failed-state budget, then use a real
      // authored append as the causal wake. The follower remains behind the
      // failed head while the head terminalizes.
      deliveryNow += 60_000;
      result.key("bump").send({ kind: "follower" });
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => {
          const entry = entryByKind("poison-1");
          return entry?.consequenced === true &&
            entry.status === "needs-attention" &&
            entry.seq !== undefined &&
            (watermarkNow() ?? 0) >= entry.seq;
        },
        "the commit-preparation failure to seal a terminal cover",
      );
      const poison1 = entryByKind("poison-1")!;
      expect(poison1.error).toBeUndefined();
      expect(poison1.deliveryDeferral).toBeUndefined();
      expect(poison1.attention).toMatchObject({
        phase: "commit-preparation",
        failureClass: "unknown",
        code: "delivery-failure-budget-exhausted",
        accumulatedFailureMs: 60_000,
        recovery: "explicit-retry",
      });
      expect(consequenceCommitsNaming(poison1.eventId).length).toBe(1);
      expect(droppedWriteReports).toEqual([]);
      await waitUntil(
        () => poisonAckStatus !== undefined,
        "the terminal durable acknowledgment",
      );
      expect(poisonAckStatus).toBe("error");
      const attentionIndex = Engine.read(engine, {
        id: SERVER_EXECUTION_ATTENTION_DOC_ID,
      })?.value as {
        entries?: Record<string, Record<string, { sidecarId?: string }>>;
      } | undefined;
      expect(
        attentionIndex?.entries?.[eventAttentionIndexKey(sidecarId)]?.[
          eventAttentionEntryKey(poison1.eventId, poison1.seq!)
        ]?.sidecarId,
      ).toBe(sidecarId);
      const poisonRunsAtTerminal = probeRuns.get("poison-1");
      await waitUntil(
        () => (probeRuns.get("follower") ?? 0) >= 1,
        "the follower to release after the terminal cover",
      );
      expect(probeRuns.get("poison-1")).toBe(poisonRunsAtTerminal);
      expect(consequenceCommitsNaming(poison1.eventId).length).toBe(1);
      expect(host!.stats().events.needsAttention.total).toBe(1);
      expect(
        host!.stats().events.needsAttention.byPhase["commit-preparation"],
      ).toBe(1);

      await waitUntil(
        () => entryByKind("follower")?.consequenced === true,
        "the first terminal cover's follower to consequence",
      );
      result.key("bump").send({ kind: "gated-retry" });
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () =>
          entryByKind("gated-retry")?.deliveryDeferral?.failureCount !==
            undefined,
        "the gated event's first commit-preparation checkpoint",
      );
      await gatedRetryStarted.promise;

      const skipsBefore = host!.stats().events.drainInFlightSkips;
      deliveryNow += 60_000;
      const wake = clientRuntime.edit();
      clientRuntime.getCell<number>(space, "gated-retry-wake", undefined)
        .withTx(wake).set(1);
      expect((await wake.commit()).error).toBeUndefined();
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => host!.stats().events.drainInFlightSkips > skipsBefore,
        "the expired checkpoint scan to observe its in-flight owner",
      );
      const stillRunning = entryByKind("gated-retry")!;
      expect(stillRunning.consequenced).not.toBe(true);
      expect(stillRunning.status).toBeUndefined();
      expect(stillRunning.attention).toBeUndefined();

      releaseGatedRetry.resolve();
      await waitUntil(
        () => entryByKind("gated-retry")?.consequenced === true,
        "the in-flight clean retry to consequence normally",
      );
      const succeeded = entryByKind("gated-retry")!;
      expect(succeeded.status).toBeUndefined();
      expect(succeeded.attention).toBeUndefined();
      expect(succeeded.deliveryDeferral).toBeUndefined();
      expect(probeRuns.get("gated-retry")).toBe(2);
      expect(consequenceCommitsNaming(succeeded.eventId)).toHaveLength(1);
      expect(host!.stats().events.needsAttention.total).toBe(1);
    } finally {
      releaseGatedRetry.resolve();
      console.error = realConsoleError;
      cancelProbe();
      cancelDemand();
    }
  });

  it("an explicit handler abort is proven pre-seal and becomes one safe error consequence instead of re-draining forever", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "giveup-arg",
      result: "giveup-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    result.key("bump").send({ kind: "warmup" });
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the warm-up append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    const entriesOf = () => ((Engine.read(engine, { id: sidecarId })?.value as
      | StreamEventsDocValue
      | undefined)?.entries ?? []);
    const entryByKind = (kind: string) =>
      entriesOf().find((entry) =>
        (entry.payload as { kind?: string } | undefined)?.kind === kind
      );
    await waitUntil(
      () => entryByKind("warmup")?.consequenced === true,
      "the warm-up event to consequence",
    );
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "the space to activate",
    );

    const warmup = entryByKind("warmup")!;
    const streamLink = {
      space,
      id: warmup.stream.id as never,
      path: [...warmup.stream.path],
      scope: (warmup.stream.scope ?? "space") as never,
    };
    // This is the exact explicit-abort sentinel. It proves that no storage
    // commit was attempted, so OQ-23 admits a terminal error consequence.
    let probeRuns = 0;
    const cancelProbe = servingRuntime!.scheduler.addEventHandler(
      (tx, _event) => {
        probeRuns += 1;
        tx.abort(new Error("served give-up cadence probe"));
      },
      streamLink,
    );
    try {
      result.key("bump").send({ kind: "aborted" });
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => {
          const entry = entryByKind("aborted");
          return entry?.consequenced === true &&
            typeof entry.error === "string";
        },
        "the explicit abort to seal an error consequence",
      );
      const aborted = entryByKind("aborted")!;
      expect(probeRuns).toBe(1);
      expect(aborted.error).toBe("Event handler aborted its transaction");
      expect(aborted.status).toBeUndefined();
      expect(
        (Engine.read(engine, { id: sidecarId })?.value as StreamEventsDocValue)
          .eventWatermark,
      ).toBe(aborted.seq);
    } finally {
      cancelProbe();
      cancelDemand();
    }
  });

  it("a served RetryImmediately retry remains settlement and never creates a delivery checkpoint", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "retry-immediately-arg",
      result: "retry-immediately-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    result.key("bump").send({ kind: "warmup" });
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the RetryImmediately stream to become durable",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    const entries = () => ((Engine.read(engine, { id: sidecarId })?.value as
      | StreamEventsDocValue
      | undefined)?.entries ?? []);
    await waitUntil(
      () => entries()[0]?.consequenced === true,
      "the warm-up event to consequence",
    );
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "the RetryImmediately serving runtime to activate",
    );

    const streamLink = {
      space,
      id: entries()[0].stream.id as never,
      path: [...entries()[0].stream.path],
      scope: (entries()[0].stream.scope ?? "space") as never,
    };
    let runs = 0;
    const cancelProbe = servingRuntime!.scheduler.addEventHandler(
      () => {
        runs += 1;
        if (runs === 1) throw new RetryImmediately("test name resolution");
      },
      streamLink,
    );
    try {
      result.key("bump").send({ kind: "retry-immediately" });
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => entries().at(-1)?.consequenced === true && runs === 2,
        "the served name-resolution retry to consequence",
      );
      const retried = entries().at(-1)!;
      expect(retried.deliveryDeferral).toBeUndefined();
      expect(retried.attention).toBeUndefined();
      expect(host!.stats().events.deliveryDeferralsActive).toBe(0);
      expect(host!.stats().events.deliveryFailuresActive).toBe(0);
    } finally {
      cancelProbe();
      cancelDemand();
    }
  });

  it("the renderer-trust attestation rides the durable entry and is RE-MARKED at the served dispatch (fan-out stage B, OW34's sister-mark carriage): a fire whose event carried the process-local renderer-trust mark appends `rendererTrusted: true`, the served handler sees a renderer-trusted event; an unmarked fire appends no attestation and the served handler sees none; a forged attestation value is refused at admission", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "trust-arg",
      result: "trust-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    // A renderer-marked fire (what the reconciler's dispatch does before
    // handing a DOM event to the pattern's handler); its admission
    // activates the space.
    const marked = { kind: "marked" };
    markRendererTrustedEvent(marked);
    result.key("bump").send(marked);
    // An unmarked fire (a pattern-minted event, or a payload that merely
    // CLAIMS renderer provenance — the WeakSet mark is what the runtime
    // attests, never the payload's own fields).
    result.key("bump").send({
      kind: "unmarked",
      provenance: { origin: "dom", trusted: true },
    });
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the appends to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        return (value?.entries?.length ?? 0) >= 2 &&
          value!.entries!.every((entry) => entry.consequenced === true);
      },
      "both events to consequence",
    );
    const entries =
      (Engine.read(engine, { id: sidecarId })?.value as StreamEventsDocValue)
        .entries!;
    const markedEntry = entries.find((entry) =>
      (entry.payload as { kind?: string } | undefined)?.kind === "marked"
    )!;
    const unmarkedEntry = entries.find((entry) =>
      (entry.payload as { kind?: string } | undefined)?.kind === "unmarked"
    )!;
    // THE CARRIAGE: only the runtime-attested fire carries the flag.
    expect(
      (markedEntry as { rendererTrusted?: unknown }).rendererTrusted,
    ).toBe(true);
    expect(
      (unmarkedEntry as { rendererTrusted?: unknown }).rendererTrusted,
    ).toBeUndefined();

    // THE RE-MARK: the served dispatch marks an attested entry's payload
    // — observed by a served handler on the same stream (a probe on the
    // SERVING runtime, live now that the space is active). Fire two more
    // (marked / unmarked) once the probe handler is installed.
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space to activate",
    );
    const seen: Array<{ kind: string; trusted: boolean }> = [];
    // The entry's self-describing stream link IS the dispatch target.
    const streamLink = {
      space,
      id: markedEntry.stream.id as never,
      path: [...markedEntry.stream.path],
      scope: (markedEntry.stream.scope ?? "space") as never,
    };
    const cancelProbe = servingRuntime!.scheduler.addEventHandler(
      (_tx, event: unknown) => {
        seen.push({
          kind: (event as { kind?: string })?.kind ?? "?",
          trusted: isRendererTrustedEvent(event),
        });
      },
      streamLink,
    );
    try {
      const marked2 = { kind: "marked-2" };
      markRendererTrustedEvent(marked2);
      result.key("bump").send(marked2);
      result.key("bump").send({ kind: "unmarked-2" });
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () =>
          seen.some((s) => s.kind === "marked-2") &&
          seen.some((s) => s.kind === "unmarked-2"),
        "the served probe handler to see both fires",
      );
      expect(seen.find((s) => s.kind === "marked-2")!.trusted).toBe(true);
      expect(seen.find((s) => s.kind === "unmarked-2")!.trusted).toBe(false);
    } finally {
      cancelProbe();
    }

    // A caller-supplied attestation VALUE never reaches the entry: the
    // append queue carries only the runtime's `true` (a forged "yes"
    // through the raw append API is dropped at the queue; the engine's
    // admission refuses any non-`true` value that does arrive — pinned
    // in memory's `v2-event-append.test.ts`).
    const forgedManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    try {
      const delivery = await forgedManager.open(space).replica
        .enqueueEventAppend!({
          sidecarId,
          stream: markedEntry.stream,
          eventId: `evt:forged:${sidecarId}`,
          payload: { kind: "forged" } as never,
          ...({ rendererTrusted: "yes" } as Record<string, unknown>),
        });
      expect(delivery.delivered).toBe(true);
    } finally {
      await forgedManager.close();
    }
    await waitUntil(
      () =>
        ((Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined)?.entries ?? []).some((entry) =>
            (entry.payload as { kind?: string } | undefined)?.kind ===
              "forged"
          ),
      "the forged-value append to land (sanitized)",
    );
    const forgedEntry =
      (Engine.read(engine, { id: sidecarId })?.value as StreamEventsDocValue)
        .entries!.find((entry) =>
          (entry.payload as { kind?: string } | undefined)?.kind === "forged"
        )!;
    expect(
      (forgedEntry as { rendererTrusted?: unknown }).rendererTrusted,
    ).toBeUndefined();
    cancelDemand();
  });

  it("the SKIP arm: an at-or-below-horizon duplicate admission is skipped, counted, and passed by the frontier (events.md §4/§5; C2-dedupe)", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "skip-arg",
      result: "skip-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    result.key("bump").send({});
    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the event append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        const entry = value?.entries?.[0];
        return entry?.consequenced === true;
      },
      "the original to consequence",
    );
    const original =
      (Engine.read(engine, { id: sidecarId })?.value as StreamEventsDocValue)
        .entries![0];

    // The at-or-below-horizon duplicate: redelivered via the delegated
    // path (the outbox's re-send shape) AFTER the watermark passed the
    // original — admission lets it through (events.md §4's horizon
    // bound), processing must skip it.
    const delivered = await server.commitDelegatedAppend({
      targetSpace: space,
      targetStream: sidecarId,
      targetStreamLink: original.stream,
      eventId: original.eventId,
      payload: original.payload ?? {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "resend-session",
      capabilityRef: "cap-resend",
      sessionId: `service:${space}`,
      localSeq: 999_001,
    });
    expect(delivered.deduped).toBe(false);

    await waitUntil(
      () => (host!.stats().events.skippedIdempotent ?? 0) >= 1,
      "the duplicate to be skipped and counted",
    );
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        return value?.entries?.length === 2 &&
          value.entries[1].consequenced === true &&
          value.eventWatermark === value.entries[1].seq;
      },
      "the duplicate to be passed by the frontier (non-wedging)",
    );
    // Exactly-once: the consequence ran ONCE.
    const doc = Engine.read(engine, {
      id: argument.getAsNormalizedFullLink().id,
    });
    expect((doc?.value as { value?: number })?.value).toBe(1);
    cancelDemand();
  });

  it("LD1 at cardinality 2: two users' fires run as their OWN actors — firedAt stamps each, and the consequence commits carry each event's acting user (protocol.md §1/§2)", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient(
      aliceSigner,
    ));
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "ld1-arg",
      result: "ld1-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // Bob joins the same piece.
    const bob = openClient(bobSigner);
    extraManagers.push(bob.manager);
    extraRuntimes.push(bob.runtime);
    const bobResult = bob.runtime.getCell<Record<string, unknown>>(
      space,
      "ld1-result",
      undefined,
    );
    await bobResult.sync();

    host = newHost();
    const before = Engine.serverSeq(engine);
    result.key("bump").send({});
    bobResult.key("bump").send({});
    await clientRuntime.idle();
    await bob.runtime.idle();
    await clientRuntime.storageManager.synced();
    await bob.runtime.storageManager.synced();

    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the appends to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        return (value?.entries?.length ?? 0) >= 2 &&
          value!.entries!.every((entry) => entry.consequenced === true);
      },
      "both events to consequence",
    );
    const entries =
      (Engine.read(engine, { id: sidecarId })?.value as StreamEventsDocValue)
        .entries!;
    const actors = new Set(entries.map((entry) => entry.firedAt?.user));
    expect(actors.has(aliceSigner.did())).toBe(true);
    expect(actors.has(bobSigner.did())).toBe(true);

    // The attribution half (protocol.md §1): each event's consequence
    // writes are annotated with ITS actor — the wave ran two handler
    // runs as two principals and never merged them.
    const attributed = new Map<string, string>();
    const derivedRows = engine.database.prepare(
      `SELECT consequence_of, annotations FROM "commit"
       WHERE seq > :from_seq AND class = 'derived'
         AND consequence_of IS NOT NULL AND annotations IS NOT NULL`,
    ).all({ from_seq: before }) as Array<
      { consequence_of: string; annotations: string }
    >;
    for (const row of derivedRows) {
      const consequenceOf = decodeMemoryBoundary(
        row.consequence_of,
      ) as string[];
      const annotations = decodeMemoryBoundary(row.annotations) as Array<
        { actingUser?: string }
      >;
      for (const eventId of consequenceOf) {
        const entry = entries.find((e) => e.eventId === eventId);
        for (const annotation of annotations) {
          if (
            annotation.actingUser !== undefined &&
            entry?.firedAt?.user === annotation.actingUser
          ) {
            attributed.set(eventId, annotation.actingUser);
          }
        }
      }
    }
    const aliceEvent = entries.find(
      (entry) => entry.firedAt?.user === aliceSigner.did(),
    )!;
    const bobEvent = entries.find(
      (entry) => entry.firedAt?.user === bobSigner.did(),
    )!;
    expect(attributed.get(aliceEvent.eventId)).toBe(aliceSigner.did());
    expect(attributed.get(bobEvent.eventId)).toBe(bobSigner.did());

    // Both bumps survived (the two-user semantics — each handler run
    // read the other's committed consequence or requeued and re-ran).
    await waitUntil(
      () => {
        const doc = Engine.read(engine, {
          id: argument.getAsNormalizedFullLink().id,
        });
        return ((doc?.value as { value?: number })?.value ?? 0) === 2;
      },
      "both consequences to land",
    );
    cancelDemand();
  });

  it("the DROP arm: an event whose piece can never start defers through the creation-race window, then drops with the events.md §5 notice", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    host = newHost();
    // An entry whose stream points at a doc that IS no piece and never
    // will be: the drain defers (cold-view creation race) for the
    // bounded window, then hardens into the drop notice.
    const neverAPieceStream = { id: "of:no-such-piece", path: ["stream"] };
    const delivered = await server.commitDelegatedAppend({
      targetSpace: space,
      targetStream: streamEntriesDocId(neverAPieceStream),
      targetStreamLink: neverAPieceStream,
      eventId: "evt-unrunnable",
      payload: {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "drop-session",
      capabilityRef: "cap-drop",
      sessionId: `service:${space}`,
      localSeq: 990_100,
    });
    expect(delivered.deduped).toBe(false);
    await waitUntil(
      () => {
        const value = Engine.read(engine, {
          id: streamEntriesDocId(neverAPieceStream),
        })?.value as StreamEventsDocValue | undefined;
        const entry = value?.entries?.[0];
        return entry?.status === "dropped" &&
          entry?.consequenced === true &&
          value?.eventWatermark === entry?.seq;
      },
      "the dropped-event notice + frontier pass (non-wedging)",
      30_000,
    );
    const entry = (Engine.read(engine, {
      id: streamEntriesDocId(neverAPieceStream),
    })?.value as StreamEventsDocValue).entries![0];
    expect(entry.reason).toContain("no runnable handler");
    // The space can PARK again: the drop cleared the undelivered-events
    // criterion (a perpetual deferral would wedge it active forever).
    expect(Engine.selectPendingStreamEventDocs(engine).length).toBe(0);
  });

  it("a deferral consumes REAL TIME, never back-to-back waves: the drop cannot land inside the creation-race window (verdict blocker, 2026-08-12)", async () => {
    // Pre-fix, a deferral set #eventScanOwed synchronously, #hasWork()
    // spun the next wave at once, and the whole 8-slot budget burned
    // in immediate succession — an event whose creation input was
    // milliseconds away was permanently dropped. Post-fix each retry
    // waits for input or the 250ms backstop tick, so the budget spans
    // >= threshold * tick of wall clock. The pin: at +500ms the entry
    // must still be PENDING (at most ~2 ticks consumed); the drop
    // still arrives eventually (the DROP-arm test above).
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    host = newHost();
    const laggardStream = { id: "of:laggard-piece", path: ["stream"] };
    const delivered = await server.commitDelegatedAppend({
      targetSpace: space,
      targetStream: streamEntriesDocId(laggardStream),
      targetStreamLink: laggardStream,
      eventId: "evt-laggard",
      payload: {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "laggard-session",
      capabilityRef: "cap-laggard",
      sessionId: `service:${space}`,
      localSeq: 990_200,
    });
    expect(delivered.deduped).toBe(false);
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "activation on the delivered event",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const value = Engine.read(engine, {
      id: streamEntriesDocId(laggardStream),
    })?.value as StreamEventsDocValue | undefined;
    const entry = value?.entries?.[0];
    // Still pending: NOT consequenced, NOT dropped — the budget has
    // structurally not had time to exhaust (8 ticks x 250ms >> 500ms).
    expect(entry?.eventId).toBe("evt-laggard");
    expect(entry?.status).toBeUndefined();
    expect(entry?.consequenced).not.toBe(true);
    // The event is still discoverable work (nothing wedged, nothing
    // lost): the drop (or a late-arriving piece) resolves it later.
    expect(Engine.selectPendingStreamEventDocs(engine).length)
      .toBeGreaterThanOrEqual(1);
  });

  it("an event-only admission RACING a park reactivates the space — the fire-time gate honors the undelivered-events criterion, not just live sessions (verdict blocker, 2026-08-12)", async () => {
    // Pre-fix, #reactivateAfterPark's fire-time gate required a live
    // client session: a delegated cross-space delivery (no client
    // anywhere) that raced a park chained the reactivation, which then
    // DECLINED — the delivered event sat unserved until some unrelated
    // trigger. serving-loop.md §1's ACTIVE criterion is sessions OR
    // undelivered events; the gate must check both.
    const engine = await server.engineForSpace(space);
    host = newHost();
    const parkRaceStream = { id: "of:park-race-piece", path: ["stream"] };
    const first = await server.commitDelegatedAppend({
      targetSpace: space,
      targetStream: streamEntriesDocId(parkRaceStream),
      targetStreamLink: parkRaceStream,
      eventId: "evt-park-race-1",
      payload: {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "park-race-session",
      capabilityRef: "cap-park-race",
      sessionId: `service:${space}`,
      localSeq: 990_300,
    });
    expect(first.deduped).toBe(false);
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "activation on the first delivered event",
    );
    const spaceServer = host!.spaceServer(space)!;
    // Start the park, then deliver DURING it: the admission hook sees a
    // registered, no-longer-active server and chains reactivation
    // behind the park.
    const parked = spaceServer.park("test-park-race");
    const second = await server.commitDelegatedAppend({
      targetSpace: space,
      targetStream: streamEntriesDocId(parkRaceStream),
      targetStreamLink: parkRaceStream,
      eventId: "evt-park-race-2",
      payload: {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "park-race-session",
      capabilityRef: "cap-park-race",
      sessionId: `service:${space}`,
      localSeq: 990_301,
    });
    expect(second.deduped).toBe(false);
    await parked;
    // The chained reactivation must FIRE despite zero client sessions:
    // the engine holds undelivered events.
    expect(Engine.selectPendingStreamEventDocs(engine).length)
      .toBeGreaterThanOrEqual(1);
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "reactivation on the event-only admission racing the park",
    );
  });

  it("same-space cascade (LT1): the served handler's send commits a durable wave-carried entry with the INHERITED actor — processed exactly once", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, CASCADE_PATTERN, {
      arg: "cascade-arg",
      result: "cascade-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    result.key("first").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // TWO sidecar docs materialize: the root fire's stream and the
    // cascade's — the served run of `first` emitted `second`'s entry as
    // a WRITE WITHIN its wave (LT1), engine-stamped and declared, and
    // a later wave drained it (the budget-exhausted fallback shape).
    await waitUntil(
      () => {
        const ids = sidecarIdsIn(engine);
        if (ids.length < 2) return false;
        return ids.every((id) => {
          const value = Engine.read(engine, { id })?.value as
            | StreamEventsDocValue
            | undefined;
          return (value?.entries ?? []).every(
            (entry) =>
              entry.consequenced === true &&
              typeof entry.seq === "number" &&
              value?.eventWatermark === entry.seq,
          );
        });
      },
      "both streams' entries to consequence with stamped seqs",
      30_000,
    );
    // The cascade entry carries the INHERITED actor (events.md §2:
    // events run as the session they originated from) — the root
    // (user, session) preserved hop by hop.
    const cascadeEntries = sidecarIdsIn(engine).flatMap((
      id,
    ) => ((Engine.read(engine, { id })?.value as StreamEventsDocValue)
      .entries ?? [])
    );
    expect(cascadeEntries.length).toBe(2);
    for (const entry of cascadeEntries) {
      expect(entry.firedAt?.user).toBe(aliceSigner.did());
    }
    // Exactly once: 1 + 10, never doubled.
    await waitUntil(
      () => {
        const doc = Engine.read(engine, {
          id: argument.getAsNormalizedFullLink().id,
        });
        return ((doc?.value as { value?: number })?.value ?? 0) === 11;
      },
      "the cascade's consequences to land exactly once",
      30_000,
    );
    // Give a settle beat: the value must STAY 11 (no re-run).
    await new Promise((resolve) => setTimeout(resolve, 500));
    const doc = Engine.read(engine, {
      id: argument.getAsNormalizedFullLink().id,
    });
    expect((doc?.value as { value?: number })?.value).toBe(11);
    cancelDemand();
  });

  it("C8d through the PRODUCTION cascade path (review 2026-08-11 M2): a raced parent's requeue folds its same-wave cascade child — no orphan consequence, exactly-once on retry", async () => {
    // The reviewer's failure scenario at 71718250c: the C8d fold keyed
    // on `context.parentEventId`, which NOTHING in production set — the
    // LT1 same-space emission queued its cascade with only
    // {eventId, served:{firedAt}}. So when a drained parent P's
    // consequence raced into REQUEUE, its same-wave cascade child C
    // COMMITTED (the orphan), and P's retry re-emitted the cascade
    // under a FRESH id — C's consequence applied TWICE. This test
    // drives the WHOLE production chain (cell.ts's emission carriage →
    // the dispatch stamp → the SpaceServer's #stampRun → the wave
    // fold), deterministically: the settle gate holds the sealed wave
    // open while a rival authored commit races P's consequence.
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);

    // The CHILD piece: its handler bumps the CHILD's OWN arg doc by 10.
    // A separate doc from the parent's — only the cascade closure ties
    // the two runs' fates (the rival races the PARENT's doc only).
    const CHILD_TEN_PATTERN = [
      "import { handler, pattern, Stream, Writable } from 'commonfabric';",
      "const bump = handler<unknown, { value: Writable<number> }>(",
      "  (_ev, { value }) => { value.set((value.get() ?? 0) + 10); },",
      ");",
      "export default pattern<",
      "  { value: Writable<number> },",
      "  { value: number; bump: Stream<unknown> }",
      ">(({ value }) => ({ value, bump: bump({ value }) }));",
    ].join("\n");
    // The PARENT piece: bumps its own arg doc AND sends on the child's
    // stream (carried in through an argument link) — the LT1 same-space
    // emission, produced by a DRAINED handler run.
    const PARENT_FIRE_PATTERN = [
      "import { handler, pattern, Stream, Writable } from 'commonfabric';",
      "const fire = handler<",
      "  unknown,",
      "  { value: Writable<number>; target: Stream<unknown> }",
      ">((_ev, { value, target }) => {",
      "  value.set((value.get() ?? 0) + 1);",
      "  target.send({});",
      "});",
      "export default pattern<",
      "  { value: Writable<number>; target: Stream<unknown> },",
      "  { value: number; fire: Stream<unknown> }",
      ">(({ value, target }) => ({ value, fire: fire({ value, target }) }));",
    ].join("\n");

    const child = await standUp(clientRuntime, CHILD_TEN_PATTERN, {
      arg: "c8d-child-arg",
      result: "c8d-child-result",
    });
    const parentCompiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: PARENT_FIRE_PATTERN }],
    }, { space });
    const parentArg = clientRuntime.getCell<{
      value: number;
      target: unknown;
    }>(space, "c8d-parent-arg", undefined);
    const parentResult = clientRuntime.getCell<Record<string, unknown>>(
      space,
      "c8d-parent-result",
      parentCompiled.resultSchema,
    );
    await parentArg.sync();
    await parentResult.sync();
    {
      const seed = clientRuntime.edit();
      parentArg.withTx(seed).set({
        value: 0,
        target: child.result.key("bump"),
      } as never);
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, parentCompiled, parentArg, parentResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelChildDemand = child.result.sink(() => {});
    const cancelParentDemand = parentResult.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // A LONG flush deadline: the gated wave must never exhaust while
    // the rival is being injected.
    host = newHost({ flushDeadlineMs: 30_000, idleParkMs: 600_000 });
    // The client's session predates the host — an authored poke
    // activates the space (the restart test's recipe).
    {
      const poke = clientRuntime.edit();
      clientRuntime.getCell<number>(space, "c8d-activate", undefined)
        .withTx(poke).set(1);
      expect((await poke.commit()).error).toBeUndefined();
    }
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "the space to activate",
    );

    const parentArgId = parentArg.getAsNormalizedFullLink().id;
    const childArgId = child.argument.getAsNormalizedFullLink().id;
    const engineValueOf = (id: string): number | undefined =>
      (Engine.read(engine, { id })?.value as { value?: number } | undefined)
        ?.value;

    // WARM-UP fire, ungated: proves the serving side has BOTH pieces
    // demand-loaded and the full cascade path works (parent +1, child
    // +10, everything consequenced). Without it the gated fire's first
    // drain would DEFER on the cold piece load — and the gate holds
    // the later wave the deferral needs.
    parentResult.key("fire").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () =>
        engineValueOf(parentArgId) === 1 && engineValueOf(childArgId) === 10,
      "the warm-up cascade to land",
      30_000,
    );
    await waitUntil(
      () =>
        sidecarIdsIn(engine).every((id) => {
          const value = Engine.read(engine, { id })?.value as
            | StreamEventsDocValue
            | undefined;
          return (value?.entries ?? []).every((entry) =>
            entry.consequenced === true
          );
        }),
      "the warm-up entries to consequence",
      30_000,
    );
    // Let the loop settle into wait-for-input (NOT mid-settle) before
    // the gate closes — a gated PRIOR wave would absorb the rival
    // before the parent ever read. W chases AUTHORED inputs only, so
    // the probe is a fresh authored poke whose head seq W must claim.
    {
      const poke = clientRuntime.edit();
      clientRuntime.getCell<number>(space, "c8d-settle-poke", undefined)
        .withTx(poke).set(1);
      expect((await poke.commit()).error).toBeUndefined();
    }
    await clientRuntime.storageManager.synced();
    const pokeId = clientRuntime.getCell<number>(
      space,
      "c8d-settle-poke",
      undefined,
    ).getAsNormalizedFullLink().id;
    const pokeSeq = Engine.selectDocHead(engine, {
      id: pokeId,
      scopeKey: "space",
    });
    expect(pokeSeq).toBeGreaterThan(0);
    await waitUntil(
      () => readWatermarkSeq(engine) >= pokeSeq,
      "the warm-up cycles to settle",
      30_000,
    );

    // Serving-side views of both consequence docs (read through the
    // wave's sealed overlay), synced BEFORE the gate closes.
    const servingParentArg = servingRuntime!.getCell<{ value: number }>(
      space,
      "c8d-parent-arg",
      undefined,
    );
    const servingChildArg = servingRuntime!.getCell<{ value: number }>(
      space,
      "c8d-child-arg",
      undefined,
    );
    await servingParentArg.sync();
    await servingChildArg.sync();

    const gate = Promise.withResolvers<void>();
    servingManager!.settleGate = gate.promise;
    // Engage only in the cycle that SEALED the raced parent (an idle
    // cycle's settle passes through) — parent==2 is visible ONLY
    // through the open wave's sealed overlay.
    servingManager!.settleGateWhen = () =>
      (servingParentArg.key("value").get() as number | undefined) === 2;
    try {
      // The RACED fire: parent P drains, bumps its doc (1 → 2), emits
      // the cascade; the child C runs in the SAME wave (10 → 20 on its
      // own doc). Both seal; the gated settle holds the wave open.
      parentResult.key("fire").send({});
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () =>
          (servingParentArg.key("value").get() as number | undefined) === 2 &&
          (servingChildArg.key("value").get() as number | undefined) === 20,
        "parent and cascade child to SEAL into the open wave",
      );

      // The rival races P's consequence: a whole-doc set of the
      // PARENT's arg doc (target link preserved) — a semantic conflict
      // no rebase commutes, so P REQUEUES at the wave commit.
      const storedParentArg = Engine.read(engine, { id: parentArgId })
        ?.value as Record<string, unknown>;
      Engine.applyCommit(engine, {
        sessionId: "rival-session",
        principal: "user:rival",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: parentArgId as never,
            value: {
              value: { ...storedParentArg, value: 1000 },
            } as never,
          }],
        },
      });
      gate.resolve();
    } finally {
      gate.resolve();
      servingManager!.settleGate = undefined;
      servingManager!.settleGateWhen = undefined;
    }

    // The wave commits: P requeues (its consequence raced the rival);
    // C FOLDS with it — pre-fix C's +10 COMMITTED here (the orphan),
    // and P's retry re-emitted the cascade under a FRESH id, applying
    // it AGAIN (child 30). With the fold, the retry's re-emission is
    // the ONLY application: the child lands at 20, exactly once, and
    // every entry consequences. (The PARENT's final value is
    // deliberately not pinned tight: the retry's read races the rival
    // frame's integration into the serving view, so it lands as a
    // field-level rebase either over the rival (2) or of it (1001) —
    // C8b's territory, not this fold's.)
    await waitUntil(
      () =>
        engineValueOf(childArgId) === 20 &&
        sidecarIdsIn(engine).every((id) => {
          const value = Engine.read(engine, { id })?.value as
            | StreamEventsDocValue
            | undefined;
          return (value?.entries ?? []).every((entry) =>
            entry.consequenced === true
          );
        }),
      "the folded cascade to land exactly once, everything consequenced",
      30_000,
    );
    // The settle beat: the child value must STAY 20 — never 30 (the
    // pre-fix double: orphan commit + fresh-id re-emission re-apply).
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(engineValueOf(childArgId)).toBe(20);
    expect([2, 1001]).toContain(engineValueOf(parentArgId));
    cancelChildDemand();
    cancelParentDemand();
  });

  // Stage C build W3 — (α): ONE durable entry, ONE completed run
  // (events.md §4, RULED 2026-08-18; register OW35). The pins below drive
  // RAW handlers on the serving runtime (the production chain from the
  // emitting run's `send` through cell.ts's serving arm, the dispatch
  // stamp, the SpaceServer's #stampRun, the wave's batch/fold, and the
  // drain — only the handler bodies are test code, so their timing is
  // controllable): a parent handler that spins past the flush deadline
  // (the QUEUED leftover — #5969's Bob trace, the lunch gate's l1), an
  // async child that is still RUNNING when the deadline closes its wave
  // (the in-flight residue the purge cannot reach), and a DERIVATION
  // emitter whose sidecar append the wave supersedes (the orphan).

  /** Bare stream + value docs for the (α) pins, created by the CLIENT
   * (client commits land natively; the serving runtime's writes must
   * ride stamped waves), plus the serving-side cells and links once the
   * host is active. */
  const w3Setup = async (
    prefix: string,
    policy: { flushDeadlineMs: number },
    clientSigner: Identity = aliceSigner,
  ) => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient(
      clientSigner,
    ));
    const engine = await server.engineForSpace(space);
    const mkStream = async (name: string) => {
      const cell = clientRuntime.getCell<unknown>(space, name, undefined);
      await cell.sync();
      const tx = clientRuntime.edit();
      cell.withTx(tx).setRaw({ $stream: true });
      expect((await tx.commit()).error).toBeUndefined();
      return cell;
    };
    const mkDoc = async (name: string) => {
      const cell = clientRuntime.getCell<{ n?: number; seen?: string[] }>(
        space,
        name,
        undefined,
      );
      await cell.sync();
      const tx = clientRuntime.edit();
      cell.withTx(tx).set({ n: 0, seen: [] });
      expect((await tx.commit()).error).toBeUndefined();
      return cell;
    };
    const s1 = await mkStream(`${prefix}-s1`);
    const s2 = await mkStream(`${prefix}-s2`);
    const counterP = await mkDoc(`${prefix}-counter-p`);
    const counterC = await mkDoc(`${prefix}-counter-c`);
    await clientRuntime.storageManager.synced();

    host = newHost({ ...policy, idleParkMs: 600_000 });
    {
      const poke = clientRuntime.edit();
      clientRuntime.getCell<number>(space, `${prefix}-activate`, undefined)
        .withTx(poke).set(1);
      expect((await poke.commit()).error).toBeUndefined();
    }
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "the space to activate",
    );
    // Let the boot cycle settle into wait-for-input before the pin acts
    // (the C8d recipe): W chases AUTHORED inputs only, so a fresh poke's
    // head seq is the probe W must claim — a pin that seals into a cycle
    // already mid-settle would see its wave close under it.
    {
      const pokeCell = clientRuntime.getCell<number>(
        space,
        `${prefix}-settle-poke`,
        undefined,
      );
      const poke = clientRuntime.edit();
      pokeCell.withTx(poke).set(1);
      expect((await poke.commit()).error).toBeUndefined();
      await clientRuntime.storageManager.synced();
      const pokeSeq = Engine.selectDocHead(engine, {
        id: pokeCell.getAsNormalizedFullLink().id,
        scopeKey: "space",
      });
      expect(pokeSeq).toBeGreaterThan(0);
      await waitUntil(
        () => readWatermarkSeq(engine) >= pokeSeq,
        "the boot cycles to settle (W to cover the poke)",
        30_000,
      );
    }
    const serving = servingRuntime!;
    const servingS1 = serving.getCell<unknown>(
      space,
      `${prefix}-s1`,
      undefined,
    );
    const servingS2 = serving.getCell<unknown>(
      space,
      `${prefix}-s2`,
      undefined,
    );
    const servingP = serving.getCell<{ n?: number }>(
      space,
      `${prefix}-counter-p`,
      undefined,
    );
    const servingC = serving.getCell<{ n?: number }>(
      space,
      `${prefix}-counter-c`,
      undefined,
    );
    await servingS1.sync();
    await servingS2.sync();
    await servingP.sync();
    await servingC.sync();
    const engineN = (cell: { getAsNormalizedFullLink(): { id: string } }) =>
      (Engine.read(engine, { id: cell.getAsNormalizedFullLink().id })?.value as
        | { n?: number }
        | undefined)?.n;
    const sidecarOf = (cell: { getAsNormalizedFullLink(): { id: string } }) =>
      streamEntriesDocId({
        id: cell.getAsNormalizedFullLink().id,
        path: [],
      } as never);
    const entriesOf = (sidecarId: string) =>
      ((Engine.read(engine, { id: sidecarId })?.value ??
        {}) as StreamEventsDocValue).entries ?? [];

    /** Derived commits whose consequenceOf names `eventId` — the
     * store-side per-event completed-run count (events.md §4: per-event
     * run counts are the signature; `processed == appended` is not). */
    const consequenceCommitsOf = (eventId: string): number =>
      (engine.database.prepare(
        `SELECT consequence_of FROM "commit"
         WHERE class = 'derived' AND consequence_of IS NOT NULL`,
      ).all() as Array<{ consequence_of: string }>).filter((row) =>
        row.consequence_of.includes(eventId)
      ).length;
    return {
      engine,
      serving,
      s1,
      s2,
      counterP,
      counterC,
      servingS1,
      servingS2,
      servingP,
      servingC,
      engineN,
      sidecarOf,
      entriesOf,
      consequenceCommitsOf,
    };
  };

  it("(α1)+(α1b)+(α4) the QUEUED leftover and the in-flight one, side by side: a served parent emits TWO LT1 cascade children; the first is still RUNNING when the flush deadline fires (an async handler parked on a test gate), the second sits QUEUED behind it — the deadline decision PURGES the queued copy (no notice on its entry) and the running copy, completing after its wave closed, is REFUSED at the seal; the next drain delivers both entries ONCE each with a streamEntry; per-event: one consequence commit each, the child effect applied exactly twice in total (mutations: purge skipped → the queued copy runs after the close and is refused at the seal instead, `lt1LeftoversPurged` 0 / `lt1LateSealsRefused` 2; seal refusal AND the orphan arm's absent-emitter clause skipped → the effect applied THREE times, the lunch double; all three seats off → four times, observed only with the counter asserts relaxed — as written the pin reddens first on the purge counter)", async () => {
    const w = await w3Setup("w3-purge", { flushDeadlineMs: 100 });
    const cancels: Array<() => void> = [];
    const gate = Promise.withResolvers<void>();
    const childRuns: string[] = [];
    try {
      // The PARENT: bumps its own counter and emits TWO cascade events on
      // s2 — cell.ts's serving arm writes both durable entries INTO this
      // tx and queues both in-process copies (served: {firedAt,
      // parentEventId, lt1}), in send order.
      cancels.push(w.serving.scheduler.addEventHandler(
        (tx: IExtendedStorageTransaction, _event: unknown) => {
          w.servingP.withTx(tx).set({
            n: (w.servingP.withTx(tx).get()?.n ?? 0) + 1,
          });
          w.servingS2.withTx(tx).send({ tag: "c1" } as never);
          w.servingS2.withTx(tx).send({ tag: "c2" } as never);
        },
        w.servingS1.getAsNormalizedFullLink(),
      ));
      // The CHILD handler (async — patterns may be): the FIRST child parks
      // on the gate (in flight across the deadline); the second is a plain
      // bump. The scheduler dispatches one event per pass, so while c1 is
      // parked c2 stays QUEUED — exactly where the deadline finds it.
      cancels.push(w.serving.scheduler.addEventHandler(
        async (tx: IExtendedStorageTransaction, event: unknown) => {
          const tag = (event as { tag?: string })?.tag ?? "?";
          childRuns.push(tag);
          if (tag === "c1") await gate.promise;
          w.servingC.withTx(tx).set({
            n: (w.servingC.withTx(tx).get()?.n ?? 0) + 1,
          });
        },
        w.servingS2.getAsNormalizedFullLink(),
      ));

      w.s1.send({ tag: "root" } as never);
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();

      const s2Sidecar = w.sidecarOf(w.s2);
      // The deadline fired with c1 in flight and c2 queued: c2's copy was
      // purged (counted), the appending wave committed both entries
      // UNMARKED, and the next cycle's drain queued both streamEntry-bearing
      // copies behind the still-parked c1 (processed: root + c1 + c2 = 3).
      await waitUntil(
        () =>
          host!.stats().events.processed === 3 &&
          w.entriesOf(s2Sidecar).length === 2 &&
          w.entriesOf(s2Sidecar).every((entry) => entry.consequenced !== true),
        "both entries to land unmarked and the drain to queue both copies",
        20_000,
      );
      expect(childRuns).toEqual(["c1"]);
      expect(host!.stats().events.lt1LeftoversPurged).toBe(1);
      expect(host!.stats().events.lt1LateSealsRefused).toBe(0);

      // The purge's DISCRIMINATOR (independent review m1): keep the gate
      // held across several more flush deadlines with the drain's
      // `streamEntry`-bearing copies c1'/c2' sitting QUEUED behind the
      // parked c1 — every cut cycle runs the purge over that queue, and
      // the purge must never reach a drain copy (`served.streamEntry !==
      // undefined`). An over-reaching predicate (`served !== undefined`
      // alone) purges them here: the count climbs past 1 and the drop
      // chokepoint writes a `dropped` notice onto the durable entries —
      // a LOST delivery the α pins' original timing could not see.
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(host!.stats().wavesBudgetExhausted).toBeGreaterThan(1);
      expect(host!.stats().events.lt1LeftoversPurged).toBe(1);
      expect(host!.stats().events.processed).toBe(3);
      for (const entry of w.entriesOf(s2Sidecar)) {
        expect(entry.status).toBeUndefined();
        expect(entry.consequenced).not.toBe(true);
      }

      // Open the gate: c1's in-flight copy completes OUTSIDE its appending
      // wave → refused at the seal; the drain's c1' and c2' then run (the
      // gate is open) and complete WITH their marks.
      gate.resolve();
      await waitUntil(
        () =>
          w.entriesOf(s2Sidecar).every((entry) => entry.consequenced === true),
        "the drain's copies to consequence both entries",
        20_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      await w.serving.idle();

      const entries = w.entriesOf(s2Sidecar);
      const stats = host!.stats();
      // THE PIN: one purge (c2's queued copy), one refusal (c1's in-flight
      // copy), the child body ran three times (c1 refused, c1', c2') but its
      // effect landed exactly TWICE — one completed run per entry — and
      // each child event is named by exactly one consequence commit. No
      // notice landed on either entry.
      expect(w.engineN(w.counterC)).toBe(2);
      expect(w.engineN(w.counterP)).toBe(1);
      expect(stats.events.lt1LeftoversPurged).toBe(1);
      expect(stats.events.lt1LateSealsRefused).toBe(1);
      expect(childRuns).toEqual(["c1", "c1", "c2"]);
      for (const entry of entries) {
        expect(w.consequenceCommitsOf(entry.eventId)).toBe(1);
        expect(entry.status).toBeUndefined();
        expect(entry.error).toBeUndefined();
      }
      // The root fire: one append, drained once; the two server-emitted
      // entries each drained once (processed counts drain queues — 3 here
      // — which is why `processed == appended` is NOT the pin).
      expect(stats.events.appended).toBe(1);
      expect(stats.events.processed).toBe(3);
    } finally {
      gate.resolve();
      for (const cancel of cancels) cancel();
    }
  });

  it("(α1b)+(α4) the IN-FLIGHT residue: an LT1 cascade copy still RUNNING when the deadline closes its appending wave seals into a LATER wave and is REFUSED at the seal destination (before it enters any wave — the drain's copy, running next, reads clean state); the drain's copy is the one completed run (mutation: refusal skipped → the copy's consequences commit unmarked beside the drain's marked copy, the child's effect applied twice — the lunch gate's vote-toggle double)", async () => {
    const w = await w3Setup("w3-late", { flushDeadlineMs: 150 });
    const cancels: Array<() => void> = [];
    const childGate = Promise.withResolvers<void>();
    let childRuns = 0;
    try {
      // The PARENT: a quick bump + the cascade emission.
      cancels.push(w.serving.scheduler.addEventHandler(
        (tx: IExtendedStorageTransaction, _event: unknown) => {
          w.servingP.withTx(tx).set({
            n: (w.servingP.withTx(tx).get()?.n ?? 0) + 1,
          });
          w.servingS2.withTx(tx).send({ tag: "child" } as never);
        },
        w.servingS1.getAsNormalizedFullLink(),
      ));
      // The CHILD: an ASYNC handler (patterns may be async — the gmail
      // importer's fetch) that awaits a test-held gate before bumping.
      // Its first dispatch — the LT1 in-process copy — starts inside the
      // appending wave and is STILL RUNNING when the 150-ms deadline
      // closes it; the copy seals only when the test opens the gate, by
      // which time the entry has landed unmarked and the next cycle's
      // drain has queued the streamEntry-bearing copy behind it.
      cancels.push(w.serving.scheduler.addEventHandler(
        async (tx: IExtendedStorageTransaction, _event: unknown) => {
          childRuns += 1;
          await childGate.promise;
          w.servingC.withTx(tx).set({
            n: (w.servingC.withTx(tx).get()?.n ?? 0) + 1,
          });
        },
        w.servingS2.getAsNormalizedFullLink(),
      ));

      w.s1.send({ tag: "root" } as never);
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();

      const s2Sidecar = w.sidecarOf(w.s2);
      // The appending wave has committed (the child's entry is durable,
      // unmarked) and the drain has re-queued it: processed reads 2 (the
      // root fire + the child's entry) while the in-process copy is still
      // parked on the gate — nothing consequenced yet.
      await waitUntil(
        () =>
          host!.stats().events.processed === 2 &&
          w.entriesOf(s2Sidecar).length === 1 &&
          w.entriesOf(s2Sidecar)[0].consequenced !== true,
        "the child's entry to land unmarked and the drain to queue its copy",
        20_000,
      );
      expect(childRuns).toBe(1);
      expect(host!.stats().events.lt1LateSealsRefused).toBe(0);

      // Open the gate: the in-flight copy completes OUTSIDE its appending
      // wave → refused at the seal; the drain's copy then runs (the gate
      // is open) and completes WITH the mark.
      childGate.resolve();
      await waitUntil(
        () => w.entriesOf(s2Sidecar)[0]?.consequenced === true,
        "the drain's copy to consequence the entry",
        20_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      await w.serving.idle();

      const childEntry = w.entriesOf(s2Sidecar)[0];
      const stats = host!.stats();
      // THE PIN: one refusal, zero purges (the copy was never queued at
      // a deadline — it was in flight), the handler body ran twice (the
      // refused copy + the drain's copy) but its effect landed ONCE, and
      // one consequence commit names the event.
      expect(w.engineN(w.counterC)).toBe(1);
      expect(w.engineN(w.counterP)).toBe(1);
      expect(stats.events.lt1LateSealsRefused).toBe(1);
      expect(stats.events.lt1LeftoversPurged).toBe(0);
      expect(childRuns).toBe(2);
      expect(w.consequenceCommitsOf(childEntry.eventId)).toBe(1);
      expect(childEntry.status).toBeUndefined();
      expect(childEntry.error).toBeUndefined();
    } finally {
      childGate.resolve();
      for (const cancel of cancels) cancel();
    }
  });

  it("(α3) the ORPHAN refusal: a DERIVATION emitter's sidecar append that the wave supersedes (a rival append landed between the wave's basis and its commit — the per-doc drop, re-arms nothing) takes the durable entry with it, and the LT1 copy's run in that wave is REFUSED rather than committed with zero entries behind it; the rival's own entry is delivered once (mutation: the orphan arm removed → the copy's consequence commits for an event no sidecar holds)", async () => {
    const w = await w3Setup("w3-orphan", { flushDeadlineMs: 30_000 });
    const cancels: Array<() => void> = [];
    const gate = Promise.withResolvers<void>();
    try {
      // The handler on s2 records every payload tag it handles — the
      // consequence witness (s1 is unused here) — and for the
      // derivation's "ping" it ARMS the settle gate as its first act
      // (#6184's arming, adopted here from the SIBLING step: this
      // step's gate previously polled the sealed overlay, the exact
      // shape #6184 replaced there — CT-2060's open question of
      // whether the remaining polled gates should adopt the arming).
      // `armingGap` is the construction's own discriminator: the QUEUE
      // seam below must have armed the hold BEFORE the copy's run
      // reaches this handler — a gap means the gate could still be
      // sampled unarmed after the copy's contributions sealed, which
      // is exactly the CI flake's window.
      const servingSeen = w.servingC;
      let holdArmed = false;
      let armingGap = false;
      cancels.push(w.serving.scheduler.addEventHandler(
        (tx: IExtendedStorageTransaction, event: unknown) => {
          const tag = (event as { tag?: string })?.tag ?? "?";
          if (tag === "ping") {
            if (!holdArmed) armingGap = true;
            holdArmed = true;
          }
          const current = servingSeen.withTx(tx).get() as
            | { seen?: string[] }
            | undefined;
          servingSeen.withTx(tx).set({
            seen: [...(current?.seen ?? []), tag],
          } as never);
        },
        w.servingS2.getAsNormalizedFullLink(),
      ));
      // The DERIVATION emitter: a registered action (kind `derivation` at
      // the dispatch stamp — the LT6 precedent) that reads a trigger and
      // emits on s2 through cell.ts's serving arm: the entry rides THIS
      // run's tx; the in-process copy is queued for the same wave.
      const trigger = w.serving.getCell<{ v?: number }>(
        space,
        "w3-orphan-trigger",
        undefined,
      );
      await trigger.sync();
      const emitter = (tx: IExtendedStorageTransaction): void => {
        trigger.withTx(tx).get();
        w.servingS2.withTx(tx).send({ tag: "ping" } as never);
      };
      // Serving-side view of the witness doc, synced before the gate.
      const seenView = () =>
        (w.servingC.get() as { seen?: string[] } | undefined)?.seen ?? [];
      expect(seenView()).toEqual([]);

      // Hold the wave open for the cycle that RUNS the copy — the same
      // two-seam arming as the SIBLING step (CT-2060; OW57's owed
      // construction): the QUEUE seam arms when the LT1 copy is queued
      // for dispatch, and the handler arms again as its first act
      // (#6184's belt). The queue seam is the one point every path to
      // the copy's run traverses BEFORE the run — the same-wave
      // in-process copy is queued synchronously with the emitter's
      // sealed append (cell.ts's LT1 arm: the raw entries write and
      // `scheduler.queueEvent` sit in one synchronous block, no
      // interleaving point between them), and the drain's later
      // re-delivery of a durable entry dispatches through the same
      // `queueEvent` (space-server.ts's served dispatch). So no settle
      // can sample an unarmed predicate after any of the copy's
      // contributions sealed. A drain-side sidecar-SYNC seam cannot do
      // this: the same-wave copy's entry is a sealed-wave write the
      // drain's durable query never sees, so nothing syncs the sidecar
      // before the copy runs in that cycle (the Codex P1 finding on
      // this PR, confirmed in code). Idle settles pass: nothing arms
      // until THIS step's stream event is queued.
      const s2StreamId = w.servingS2.getAsNormalizedFullLink().id;
      const originalQueueEvent = w.serving.scheduler.queueEvent.bind(
        w.serving.scheduler,
      );
      (w.serving.scheduler as {
        queueEvent: typeof originalQueueEvent;
      }).queueEvent = (eventLink, ...rest) => {
        if (eventLink.id === s2StreamId) holdArmed = true;
        return originalQueueEvent(eventLink, ...rest);
      };
      servingManager!.settleGate = gate.promise;
      servingManager!.settleGateWhen = () => holdArmed;
      let released = false;
      try {
        await w.serving.scheduler.run(emitter as never);
        await waitUntil(
          () => seenView().includes("ping"),
          "the derivation's cascade copy to SEAL into the open wave",
          20_000,
        );
        // The RIVAL: a client fire on the SAME stream lands a concurrent
        // append on the sidecar — its head advances past the wave's
        // basis, so the derivation's append is superseded at the
        // per-doc CAS and dropped (serving-loop.md §3d).
        w.s2.send({ tag: "rival" } as never);
        await clientRuntime.idle();
        await clientRuntime.storageManager.synced();
        const s2Sidecar = w.sidecarOf(w.s2);
        await waitUntil(
          () =>
            w.entriesOf(s2Sidecar).some((entry) =>
              (entry.payload as { tag?: string } | undefined)?.tag === "rival"
            ),
          "the rival append to land",
        );
        gate.resolve();
        released = true;
      } finally {
        if (!released) gate.resolve();
        (w.serving.scheduler as {
          queueEvent: typeof originalQueueEvent;
        }).queueEvent = originalQueueEvent;
        servingManager!.settleGate = undefined;
        servingManager!.settleGateWhen = undefined;
      }

      // The construction's own discriminator: the hold was armed BEFORE
      // the copy's run reached the handler. Red under handler-only
      // arming (#6184) and under a drain-sync seam alike — both leave
      // the gap the CI flake rode.
      expect(armingGap).toBe(false);

      const s2Sidecar = w.sidecarOf(w.s2);
      // The rival's entry is delivered (once) by the drain.
      await waitUntil(
        () =>
          w.entriesOf(s2Sidecar).length === 1 &&
          w.entriesOf(s2Sidecar)[0].consequenced === true,
        "the rival's entry to be the sidecar's only entry, consequenced",
        20_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      await w.serving.idle();

      const stats = host!.stats();
      const seen =
        (Engine.read(w.engine, { id: w.counterC.getAsNormalizedFullLink().id })
          ?.value as { seen?: string[] } | undefined)?.seen ?? [];
      // THE PIN: the derivation's emitted entry never landed (the
      // sidecar holds only the rival's), its copy's run was refused as an
      // orphan (counted) — "ping" was never consequenced — and the
      // rival's consequence landed once. Every consequenced eventId in
      // the store has a durable entry behind it.
      expect(seen).toEqual(["rival"]);
      expect(stats.events.orphanDeliveriesRefused).toBe(1);
      const consequenced = (w.engine.database.prepare(
        `SELECT consequence_of FROM "commit"
         WHERE class = 'derived' AND consequence_of IS NOT NULL`,
      ).all() as Array<{ consequence_of: string }>).flatMap((row) =>
        decodeMemoryBoundary(row.consequence_of) as unknown as string[]
      );
      const durableIds = new Set(
        sidecarIdsIn(w.engine).flatMap((id) =>
          w.entriesOf(id).map((entry) => entry.eventId)
        ),
      );
      expect(consequenced.length).toBeGreaterThanOrEqual(1);
      for (const id of consequenced) expect(durableIds.has(id)).toBe(true);
    } finally {
      gate.resolve();
      for (const cancel of cancels) cancel();
    }
  });

  // The same-eventId SIBLING shape (independent review of W3, B1 / M1):
  // an event can contribute SEVERAL transactions to one wave — the
  // handler run plus a separate event-handler-stamped tx carrying the
  // same eventId, in production the served navigateTo's intent tx
  // (navigate-to.ts: `stampServerRun(intentTx, {kind: "event-handler",
  // eventId: context.eventId, …}); intentTx.commit()`, committed inline
  // mid-run). The two pins below stamp such a sibling directly from the
  // LT1 child's handler body and pin that neither (α1b) nor (α3) treats
  // the sibling's survival as the handler's: a seq-less entry is marked
  // consequenced only by the LT1 copy's OWN run (`lt1 === true`), and an
  // orphan-refused copy takes its siblings down with it.

  /** A sibling contribution of the running handler's event: a separate
   * event-handler-stamped tx carrying `tx.dispatchedEventId`, committed
   * inline (the served navigateTo intent shape), writing `n + 1` into
   * `sideCell` — a NON-idempotent witness so a doubled or a lost sibling
   * is visible. */
  const stampSibling = (
    serving: Runtime,
    tx: IExtendedStorageTransaction,
    sideCell: Cell<{ n?: number }>,
  ): void => {
    const side = serving.edit();
    serving.stampServerRun(side, {
      actionId: `pin/sibling-intent:${tx.dispatchedEventId}`,
      kind: "event-handler",
      eventId: tx.dispatchedEventId!,
    });
    sideCell.withTx(side).set({
      n: (sideCell.withTx(side).get()?.n ?? 0) + 1,
    });
    side.commit();
  };

  it("(α1b)+(α4) + a same-eventId SIBLING tx (independent review B1 — a LOST delivery on the build tip, a regression vs the W1 base): an ASYNC LT1 cascade child commits a separate event-handler-stamped tx carrying its own eventId (the served navigateTo intent shape) BEFORE an await that spans the flush deadline; the sibling seals into the appending wave and survives, the handler's own tx seals late and is REFUSED — the entry must land UNMARKED (only the LT1 copy's OWN run may mark its seq-less entry, never a sibling) so the drain re-delivers it: the child's effect lands exactly once, one consequence commit names the event, the sibling's write stands (mutation: the `lt1 === true` gate on the seq-less marking removed → the sibling's survival marks the entry consequenced, the refused copy is never re-delivered, the effect lands ZERO times — `processed` 1, `counterC` 0)", async () => {
    const w = await w3Setup("w3-sibling-late", { flushDeadlineMs: 150 });
    const cancels: Array<() => void> = [];
    const childGate = Promise.withResolvers<void>();
    let childRuns = 0;
    // The sibling's target doc, created by the client (native commit).
    const sideClient = clientRuntime.getCell<{ n?: number }>(
      space,
      "w3-sibling-late-side",
      undefined,
    );
    await sideClient.sync();
    {
      const tx = clientRuntime.edit();
      sideClient.withTx(tx).set({ n: 0 });
      expect((await tx.commit()).error).toBeUndefined();
      await clientRuntime.storageManager.synced();
    }
    const sideServing = w.serving.getCell<{ n?: number }>(
      space,
      "w3-sibling-late-side",
      undefined,
    );
    await sideServing.sync();
    try {
      cancels.push(w.serving.scheduler.addEventHandler(
        (tx: IExtendedStorageTransaction, _event: unknown) => {
          w.servingP.withTx(tx).set({
            n: (w.servingP.withTx(tx).get()?.n ?? 0) + 1,
          });
          w.servingS2.withTx(tx).send({ tag: "child" } as never);
        },
        w.servingS1.getAsNormalizedFullLink(),
      ));
      // The CHILD (async): on its FIRST dispatch — the LT1 in-process
      // copy — it commits the sibling tx inline and THEN parks on the
      // gate across the deadline; its consequence (the counter bump) is
      // written after the gate. The drain's re-run (the second dispatch)
      // does not re-issue the sibling: in production the re-run's
      // re-issue is navigateTo's deterministic-nonce append, which the
      // engine dedupes at apply — the sibling's effect is one-shot either
      // way, and this pin's witness is the non-idempotent bump.
      cancels.push(w.serving.scheduler.addEventHandler(
        async (tx: IExtendedStorageTransaction, _event: unknown) => {
          childRuns += 1;
          if (childRuns === 1) stampSibling(w.serving, tx, sideServing);
          await childGate.promise;
          w.servingC.withTx(tx).set({
            n: (w.servingC.withTx(tx).get()?.n ?? 0) + 1,
          });
        },
        w.servingS2.getAsNormalizedFullLink(),
      ));

      w.s1.send({ tag: "root" } as never);
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();

      const s2Sidecar = w.sidecarOf(w.s2);
      await waitUntil(
        () => w.entriesOf(s2Sidecar).length === 1,
        "the child's entry to land",
        20_000,
      );
      // Several deadlines later (the gate still held): the sibling is
      // durable, and the entry it rode beside is UNMARKED — the sibling's
      // survival is not the handler's completion. (On the build tip the
      // entry was marked here: `survivedEventIds` admitted any surviving
      // event-handler contribution with the eventId.)
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(w.engineN(sideServing)).toBe(1);
      expect(w.entriesOf(s2Sidecar)[0].consequenced).not.toBe(true);
      // … so the next drain re-queued the entry's `streamEntry` copy
      // behind the parked in-process one (processed: root + the drain's
      // copy = 2).
      await waitUntil(
        () => host!.stats().events.processed === 2,
        "the drain to queue the entry's copy behind the parked one",
        20_000,
      );
      expect(childRuns).toBe(1);
      expect(host!.stats().events.lt1LateSealsRefused).toBe(0);

      // Open the gate: the in-flight copy seals outside its appending
      // wave → refused; the drain's copy runs next and completes WITH
      // the mark.
      childGate.resolve();
      await waitUntil(
        () => w.entriesOf(s2Sidecar)[0]?.consequenced === true,
        "the drain's copy to consequence the entry",
        20_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      await w.serving.idle();

      const childEntry = w.entriesOf(s2Sidecar)[0];
      const stats = host!.stats();
      // THE PIN: the handler's non-idempotent effect landed exactly ONCE
      // (the drain's completed run — never zero: the RULED sentence is
      // one durable entry, one COMPLETED run), the sibling's write stands
      // once (it survived the appending wave; nothing withdrew it), the
      // handler body ran twice (the refused copy + the drain's), one
      // refusal, no purge, no orphan, no notice on the entry.
      expect(w.engineN(w.counterC)).toBe(1);
      expect(w.engineN(sideServing)).toBe(1);
      expect(w.engineN(w.counterP)).toBe(1);
      expect(childRuns).toBe(2);
      expect(stats.events.lt1LateSealsRefused).toBe(1);
      expect(stats.events.lt1LeftoversPurged).toBe(0);
      expect(stats.events.orphanDeliveriesRefused).toBe(0);
      expect(stats.events.processed).toBe(2);
      expect(stats.events.appended).toBe(1);
      // The store-side per-event commit count reads TWO here — the
      // sibling's contribution named the event in the appending wave's
      // commit, the drain's completed run names it one wave later: the
      // event's contributions SPLIT across two waves (the appending wave
      // "could not process" the entry, events.md §2 — it commits as
      // durable input and reprocesses; the sibling's early landing is
      // idempotent on the re-run by navigateTo's nonce dedupe). Recorded
      // as what it is: this count over-counts a split delivery exactly as
      // it under-counts a same-wave double (W0's l1) — the handler's
      // effect is the run-count witness, never this number.
      expect(w.consequenceCommitsOf(childEntry.eventId)).toBe(2);
      expect(childEntry.consequenced).toBe(true);
      expect(childEntry.status).toBeUndefined();
      expect(childEntry.error).toBeUndefined();
    } finally {
      childGate.resolve();
      for (const cancel of cancels) cancel();
    }
  });

  it("(α3) + a same-eventId SIBLING tx (independent review M1): the LT1 copy of a DERIVATION emitter's superseded append commits a sibling event-handler-stamped tx (the served navigateTo intent shape) inside the same wave; the orphan refusal must take the SIBLING down with the handler's contribution — neither half of an orphan lands (a navigation intent enacted for an event with zero durable entries is events.md §4's FORBIDDEN half-delivery); the refusal is counted once per EVENT (mutation: the sibling fold removed → the handler half is refused, the intent half LANDS — `side` 1) — the commit-sink gate makes the race deterministic", async () => {
    const prefix = "w3-sibling-orphan";
    const w = await w3Setup(prefix, { flushDeadlineMs: 30_000 });
    const cancels: Array<() => void> = [];
    const commitGate = Promise.withResolvers<void>();
    const sideClient = clientRuntime.getCell<{ n?: number }>(
      space,
      `${prefix}-side`,
      undefined,
    );
    await sideClient.sync();
    {
      const tx = clientRuntime.edit();
      sideClient.withTx(tx).set({ n: 0 });
      expect((await tx.commit()).error).toBeUndefined();
      await clientRuntime.storageManager.synced();
    }
    const sideServing = w.serving.getCell<{ n?: number }>(
      space,
      `${prefix}-side`,
      undefined,
    );
    await sideServing.sync();
    try {
      const servingSeen = w.servingC;
      let pingEventId: string | undefined;
      cancels.push(w.serving.scheduler.addEventHandler(
        (tx: IExtendedStorageTransaction, event: unknown) => {
          const tag = (event as { tag?: string })?.tag ?? "?";
          if (tag === "ping") {
            pingEventId = tx.dispatchedEventId;
            stampSibling(w.serving, tx, sideServing);
          }
          const current = servingSeen.withTx(tx).get() as
            | { seen?: string[] }
            | undefined;
          servingSeen.withTx(tx).set({
            seen: [...(current?.seen ?? []), tag],
          } as never);
        },
        w.servingS2.getAsNormalizedFullLink(),
      ));
      const trigger = w.serving.getCell<{ v?: number }>(
        space,
        `${prefix}-trigger`,
        undefined,
      );
      await trigger.sync();
      const emitter = (tx: IExtendedStorageTransaction): void => {
        trigger.withTx(tx).get();
        w.servingS2.withTx(tx).send({ tag: "ping" } as never);
      };
      const seenView = () =>
        (w.servingC.get() as { seen?: string[] } | undefined)?.seen ?? [];
      const sideView = () =>
        (sideServing.get() as { n?: number } | undefined)?.n ?? 0;
      expect(seenView()).toEqual([]);
      expect(sideView()).toBe(0);

      // Pause the exact home-space wave after the emitter append and its
      // handler/sibling consequences have accumulated, but immediately before
      // the WaveCommitSink performs its head-checked store commit. This is the
      // persistence boundary whose race OW57 needs: a rival can now advance
      // the sidecar head deterministically, and releasing this wave exercises
      // the production sink's conflict reconciliation without relying on
      // scheduler timing or the storage manager's earlier settle hook.
      const s2Sidecar = w.sidecarOf(w.s2);
      gateWaveCommitWhen = (batch) =>
        pingEventId !== undefined &&
        batch.eventAppends?.some((append) =>
            append.id === s2Sidecar && append.eventId === pingEventId
          ) === true &&
        batch.consequenceOf.includes(pingEventId);
      waveCommitGate = commitGate.promise;
      let released = false;
      try {
        await w.serving.scheduler.run(emitter as never);
        await waitUntil(
          () => seenView().includes("ping") && sideView() === 1,
          "the derivation's cascade copy AND its sibling to SEAL into the open wave",
          20_000,
        );
        await waitUntil(
          () => waveCommitGateHits === 1,
          "the target wave to reach the commit sink",
          20_000,
        );
        expect(pingEventId).toBeDefined();
        expect(w.entriesOf(s2Sidecar)).toEqual([]);

        w.s2.send({ tag: "rival" } as never);
        await clientRuntime.idle();
        await clientRuntime.storageManager.synced();
        await waitUntil(
          () =>
            w.entriesOf(s2Sidecar).some((entry) =>
              (entry.payload as { tag?: string } | undefined)?.tag === "rival"
            ),
          "the rival append to land",
        );
        commitGate.resolve();
        released = true;
      } finally {
        if (!released) commitGate.resolve();
        gateWaveCommitWhen = undefined;
        waveCommitGate = undefined;
      }

      expect(waveCommitGateHits).toBe(1);

      await waitUntil(
        () =>
          w.entriesOf(s2Sidecar).length === 1 &&
          w.entriesOf(s2Sidecar)[0].consequenced === true,
        "the rival's entry to be the sidecar's only entry, consequenced",
        20_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      await w.serving.idle();

      const stats = host!.stats();
      const seen =
        (Engine.read(w.engine, { id: w.counterC.getAsNormalizedFullLink().id })
          ?.value as { seen?: string[] } | undefined)?.seen ?? [];
      // THE PIN: the handler half never landed ("ping" unseen), the
      // SIBLING half never landed either (the intent doc still reads 0),
      // the refusal counted ONCE for the event (two contributions
      // folded), and every consequenced id has a durable entry.
      expect(seen).toEqual(["rival"]);
      expect(w.engineN(sideServing)).toBe(0);
      expect(stats.events.orphanDeliveriesRefused).toBe(1);
      // Scoped to this construction's stream: the eventId embeds its stream
      // doc id, so the filter remains exact if the harness retains artifacts.
      const s2Id = w.s2.getAsNormalizedFullLink().id;
      const consequenced = (w.engine.database.prepare(
        `SELECT consequence_of FROM "commit"
         WHERE class = 'derived' AND consequence_of IS NOT NULL`,
      ).all() as Array<{ consequence_of: string }>).flatMap((row) =>
        decodeMemoryBoundary(row.consequence_of) as unknown as string[]
      ).filter((id) => id.includes(s2Id));
      const durableIds = new Set(
        w.entriesOf(w.sidecarOf(w.s2)).map((entry) => entry.eventId),
      );
      expect(consequenced.length).toBeGreaterThanOrEqual(1);
      for (const id of consequenced) expect(durableIds.has(id)).toBe(true);
    } finally {
      commitGate.resolve();
      gateWaveCommitWhen = undefined;
      waveCommitGate = undefined;
      for (const cancel of cancels) cancel();
    }
  });

  it("arrival order across streams survives a drain deferral: an earlier-arrived event whose sidecar defers (sync failure here; the view-lag check is the same barrier) HOLDS later arrivals back instead of being overtaken (events.md §2's ordering sentence; the OW45 arm-B b01 red — a deferred Create-Another consequenced after the final Create, leaving the terminal state wrong; mutation: the deferral arms back to `continue` → the log reads A,B,A)", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);

    // Stand the two-stream pattern up (standUp seeds a {value} argument;
    // this pattern's argument is the shared log, seeded inline).
    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: ORDERED_LOG_PATTERN }],
    }, { space });
    const argument = clientRuntime.getCell<{ log: string[] }>(
      space,
      "ordered-log-arg",
      undefined,
    );
    const result = clientRuntime.getCell<Record<string, unknown>>(
      space,
      "ordered-log-result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = clientRuntime.edit();
      argument.withTx(seed).set({ log: [] });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    const argumentId = argument.getAsNormalizedFullLink().id;
    const storedLog =
      (): string[] => ((Engine.read(engine, { id: argumentId })?.value as
        | { log?: string[] }
        | undefined)?.log ?? []);
    const send = (stream: "a" | "b") =>
      (result.key(stream) as unknown as { send(value: unknown): unknown })
        .send({});

    try {
      // Warm the piece and stream `a`'s sidecar: one consequenced send.
      send("a");
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => storedLog().length === 1,
        "the warm-up consequence to land",
      );
      expect(storedLog()).toEqual(["A"]);
      const aSidecarId = sidecarIdsIn(engine)[0];
      expect(aSidecarId).toBeDefined();

      // Make `a`'s sidecar sync fail transiently: the drain's
      // sidecar-sync-failure deferral arm, held armed until a pass has
      // met it with BOTH events pending.
      GatedStorageManager.syncThrowWhen = (id) => id === aSidecarId;

      // A2 arrives first, B1 second — one client's ordered appends.
      send("a");
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => {
          const value = Engine.read(engine, { id: aSidecarId })?.value as
            | StreamEventsDocValue
            | undefined;
          return (value?.entries?.length ?? 0) === 2;
        },
        "A2's append to land",
      );
      send("b");
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => sidecarIdsIn(engine).length === 2,
        "B1's append to land on its own sidecar",
      );

      // Let the drain meet the failure WITH BOTH EVENTS PENDING:
      // baseline the throw counter only after B1's append is durable,
      // then require one more failing pass beyond it — that pass's
      // snapshot holds A2 (sidecar sync failing) AND B1 (healthy
      // sidecar), the exact overtake window.
      const failingPassesBefore = GatedStorageManager.syncThrowHits;
      await waitUntil(
        () => GatedStorageManager.syncThrowHits > failingPassesBefore,
        "a failing drain pass to run with both events pending",
      );
      // Heal: the sidecar syncs again and the deferred entry drains.
      GatedStorageManager.syncThrowWhen = undefined;

      await waitUntil(
        () => storedLog().length === 3,
        "all three consequences to land",
        30_000,
      );
      // THE PIN: consequence order equals arrival order. The pre-barrier
      // drain let B1 (later arrival, warm sidecar) overtake the deferred
      // A2 — the log read A,B,A.
      expect(storedLog()).toEqual(["A", "A", "B"]);
    } finally {
      GatedStorageManager.syncThrowWhen = undefined;
      cancelDemand();
    }
  });

  it("a transient failed head load fails closed when its first checkpoint write rejects, carries no uncommitted age across restart, and retries once after recovery", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);

    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: ORDERED_LOG_PATTERN }],
    }, { space });
    const argument = clientRuntime.getCell<{ log: string[] }>(
      space,
      "load-park-defer-arg",
      undefined,
    );
    const result = clientRuntime.getCell<Record<string, unknown>>(
      space,
      "load-park-defer-result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = clientRuntime.edit();
      argument.withTx(seed).set({ log: [] });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    const argumentLink = argument.getAsNormalizedFullLink();
    const argumentId = argumentLink.id;
    const storedLog =
      (): string[] => ((Engine.read(engine, { id: argumentId })?.value as
        | { log?: string[] }
        | undefined)?.log ?? []);
    const entriesOf = (sidecarId: string) =>
      ((Engine.read(engine, { id: sidecarId })?.value ??
        {}) as StreamEventsDocValue).entries ?? [];
    const allEntries = () =>
      sidecarIdsIn(engine).flatMap((id) => entriesOf(id));
    const send = (stream: "a" | "b") =>
      (result.key(stream) as unknown as { send(value: unknown): unknown })
        .send({});

    GatedStorageManager.loadParkFailHits = 0;
    try {
      // Warm the piece and stream `a`'s sidecar: one consequenced send,
      // with no park armed.
      send("a");
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => storedLog().length === 1,
        "the warm-up consequence to land",
      );
      expect(storedLog()).toEqual(["A"]);
      const aSidecarId = sidecarIdsIn(engine)[0];
      expect(aSidecarId).toBeDefined();

      // Arm the failure on the ARGUMENT doc — the doc BOTH handlers'
      // closures read, so either stream's head event parks on it.
      GatedStorageManager.loadParkFailDocId = argumentId;
      GatedStorageManager.loadParkFailAddress = {
        space,
        scope: "space",
        id: argumentId,
      };
      failNextServingCommit = "result-error";
      failServingCommitActionPrefix =
        "server-execution/event-delivery-checkpoint:";

      // A2 arrives first. Hold B1 until after the failed write is observed so
      // no newer input can legitimately wake a second attempt first.
      send("a");
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => entriesOf(aSidecarId).length === 2,
        "A2's append to land",
      );
      await waitUntil(
        () => host!.stats().events.deliveryCheckpointWriteFailures === 1,
        "the first checkpoint write rejection to be counted",
      );
      expect(rejectedWaveCommits).toBe(0);
      expect(
        allEntries().every((entry) => entry.deliveryDeferral === undefined),
        "uncommitted failure age must not become durable authority",
      ).toBe(true);
      expect(storedLog(), "the failed head stays pending").toEqual(["A"]);

      // Rotate the tenure while no checkpoint exists durably. B1 is both the
      // later arrival whose barrier behavior is under test and the new input
      // that activates the successor tenure. The still-failing A2 is therefore
      // re-observed from durable state and begins at count one.
      await host!.spaceServer(space)!.park("idle");
      servingRuntime = undefined;
      servingManager = undefined;
      rejectWaveCommitWhen = (batch) => {
        const rejects = JSON.stringify(batch.operations).includes(
          '"deliveryDeferral"',
        );
        if (rejects) {
          // Arm both following commit attempts before this rejection returns.
          // The host may start its next drain immediately, so arming either
          // failure after observing the counter races that automatic retry.
          failServingCommitSequence = ["rejection", "synchronous-throw"];
          failServingCommitActionPrefix =
            "server-execution/event-delivery-checkpoint:";
        }
        return rejects;
      };
      send("b");
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => sidecarIdsIn(engine).length === 2,
        "B1's append to land on its own sidecar",
      );

      await waitUntil(
        () => host!.stats().events.deliveryCheckpointWriteFailures >= 2,
        "the whole-wave checkpoint rejection to be counted",
      );
      expect(rejectedWaveCommits).toBe(1);
      rejectWaveCommitWhen = undefined;
      const wakeCheckpointRetry = async (suffix: string, value: number) => {
        const wake = clientRuntime.getCell<{ value: number }>(
          space,
          `checkpoint-write-wake-${suffix}`,
          undefined,
        );
        await wake.sync();
        const tx = clientRuntime.edit();
        wake.withTx(tx).set({ value });
        expect((await tx.commit()).error).toBeUndefined();
      };
      await wakeCheckpointRetry("rejection", 1);
      await waitUntil(
        () => host!.stats().events.deliveryCheckpointWriteFailures >= 3,
        "the rejected checkpoint promise to be counted",
      );
      await wakeCheckpointRetry("throw", 2);
      await waitUntil(
        () => host!.stats().events.deliveryCheckpointWriteFailures >= 4,
        "the synchronously failed checkpoint staging to be counted",
      );
      await wakeCheckpointRetry("success", 3);

      await waitUntil(
        () =>
          allEntries().some((entry) =>
            entry.deliveryDeferral?.phase === "dispatch-load"
          ),
        "the head-event load failure checkpoint to commit",
      );
      const checkpoint = allEntries().find((entry) =>
        entry.deliveryDeferral?.phase === "dispatch-load"
      )!.deliveryDeferral!;
      expect(checkpoint.failureCount).toBe(1);
      expect(checkpoint.recoveryEpoch).toBe(
        `test:load-park:${GatedStorageManager.loadParkRecoveryGeneration}`,
      );

      // PIN 1 — the failure is a DEFERRAL, not a drop: nothing was
      // sealed. Pre-fix both entries carry {status: "dropped",
      // consequenced: true} within a wave of the first failure.
      expect(
        allEntries().filter((entry) =>
          (entry as { status?: string }).status !== undefined
        ),
        "a transient load failure must never seal a dropped-event notice",
      ).toEqual([]);
      expect(
        allEntries().filter((entry) => entry.consequenced === true).length,
        "only the warm-up entry may be consequenced while the load fails",
      ).toBe(1);
      // PIN 2 — the ordering barrier: B1 (later arrival, its own healthy
      // sidecar) must not overtake the deferred A2. PIN 4 is where the
      // barrier actually bites (mutation: skip the barrier loop in
      // `failHeadEventLoadPark` → the log reads ["A","B","A"], the same
      // overtake shape as the OW45 arm-B b01 red).
      expect(storedLog(), "later arrivals hold behind the deferred event")
        .toEqual(["A"]);
      // PIN 3 — the deferral is VISIBLE: the serving stats carry it, and
      // no terminal drop was counted.
      const duringFailure = host!.stats().events;
      expect(duringFailure.loadParkDeferrals).toBeGreaterThan(0);
      // Initial observation plus the four explicitly woken write attempts. An
      // automatic retry may observe the same durable failure between them.
      expect(duringFailure.loadParkFailures).toBeGreaterThanOrEqual(5);
      expect(duringFailure.deliveryDeferralsActive).toBe(1);
      expect(duringFailure.deliveryFailuresActive).toBe(1);
      expect(duringFailure.dropped).toBe(0);

      // Heal: the replica load succeeds and the deferred entries drain.
      GatedStorageManager.loadParkFailDocId = undefined;
      GatedStorageManager.loadParkFailAddress = undefined;
      GatedStorageManager.signalLoadRecovery(servingManager!);

      await waitUntil(
        () => storedLog().length === 3,
        "all three consequences to land after the load failure clears",
        30_000,
      );
      // PIN 4 — exactly-once ((α)) AND arrival order: one consequence per
      // event, A2 before B1. A re-delivery would read ["A","A","A","B"].
      expect(storedLog()).toEqual(["A", "A", "B"]);
      // No-residual-re-delivery, proved CAUSALLY rather than by waiting
      // out a fixed delay (independent review P1: a re-delivery slower
      // than the timer would pass undetected, and the timer taxes every
      // green run). Once every entry is consequenced AND the watermark
      // has advanced past the last of them, the drain's pending-entry
      // scan can no longer select any of them — a re-delivery is
      // excluded by construction, not by having failed to show up yet.
      const lastSeq = Math.max(...allEntries().map((entry) => entry.seq ?? 0));
      await waitUntil(
        () =>
          allEntries().length === 3 &&
          allEntries().every((entry) => entry.consequenced === true) &&
          readWatermarkSeq(engine) >= lastSeq,
        "every entry consequenced and the watermark advanced past them",
      );
      expect(storedLog(), "no residual re-delivery of the deferred event")
        .toEqual(["A", "A", "B"]);
      expect(
        allEntries().filter((entry) => entry.consequenced === true).length,
        "every entry consequenced exactly once",
      ).toBe(3);
      expect(
        allEntries().every((entry) => entry.deliveryDeferral === undefined),
      ).toBe(true);
      expect(host!.stats().events.deliveryDeferralsActive).toBe(0);
      expect(host!.stats().events.deliveryFailuresActive).toBe(0);
      expect(host!.stats().events.dropped).toBe(0);
    } finally {
      rejectWaveCommitWhen = undefined;
      failServingCommitSequence = [];
      GatedStorageManager.loadParkFailDocId = undefined;
      GatedStorageManager.loadParkFailAddress = undefined;
      cancelDemand();
    }
  });

  it('the load-park barrier reaches entries the drain has NOT queued yet: a park failure landing MID-PASS stops the pass, instead of letting the next-arrived entry queue behind the barrier\'s back and overtake (the scheduler-side barrier can only hold what is already IN the event queue, and each new sidecar\'s sync() is an await — so the gap is real; held open here with the drain\'s sync gate on B\'s sidecar. Mutation: drop the #loadParkDeferredInPass check in #drainStreamEvents → B1 queues into the healed load and the log reads ["A","B","A"], the OW45 arm-B b01 overtake shape)', async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);

    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: ORDERED_LOG_PATTERN }],
    }, { space });
    const argument = clientRuntime.getCell<{ log: string[] }>(
      space,
      "load-park-midpass-arg",
      undefined,
    );
    const result = clientRuntime.getCell<Record<string, unknown>>(
      space,
      "load-park-midpass-result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = clientRuntime.edit();
      argument.withTx(seed).set({ log: [] });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    const argumentId = argument.getAsNormalizedFullLink().id;
    const storedLog =
      (): string[] => ((Engine.read(engine, { id: argumentId })?.value as
        | { log?: string[] }
        | undefined)?.log ?? []);
    const entriesOf = (sidecarId: string) =>
      ((Engine.read(engine, { id: sidecarId })?.value ??
        {}) as StreamEventsDocValue).entries ?? [];
    const send = (stream: "a" | "b") =>
      (result.key(stream) as unknown as { send(value: unknown): unknown })
        .send({});

    GatedStorageManager.loadParkFailHits = 0;
    const gate = Promise.withResolvers<void>();
    try {
      // Warm the piece and stream `a`'s sidecar, ungated.
      send("a");
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => storedLog().length === 1,
        "the warm-up consequence to land",
      );
      const aSidecarId = sidecarIdsIn(engine)[0];
      expect(aSidecarId).toBeDefined();
      expect(servingManager).toBeDefined();

      // Hold the drain at B's sidecar sync — the exact point at which A2
      // has been queued and B1 has not. `a`'s sidecar passes through, so
      // A2 still queues in this pass.
      servingManager!.syncGateWhen = (id) =>
        id.startsWith("of:stream-events:") && id !== aSidecarId;
      servingManager!.syncGate = gate.promise;

      // Fail A2's head-event load park while the pass is held.
      GatedStorageManager.loadParkFailDocId = argumentId;
      GatedStorageManager.loadParkFailAddress = {
        space,
        scope: "space",
        id: argumentId,
      };

      send("a");
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => entriesOf(aSidecarId).length === 2,
        "A2's append to land",
      );
      send("b");
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => sidecarIdsIn(engine).length === 2,
        "B1's append to land on its own sidecar",
      );

      // The window: a pass held at B's sidecar sync, with A2's park
      // already failed inside it.
      await waitUntil(
        () =>
          (servingManager?.syncGateHits ?? 0) > 0 &&
          GatedStorageManager.loadParkFailHits > 0,
        "a drain pass held at B's sidecar with A2's park already failed",
      );

      // HEAL FIRST, then release: with the load healthy, an unbarriered
      // pass would queue B1 and dispatch it immediately — the overtake.
      GatedStorageManager.loadParkFailDocId = undefined;
      GatedStorageManager.loadParkFailAddress = undefined;
      servingManager!.syncGateWhen = undefined;
      servingManager!.syncGate = undefined;
      gate.resolve();
      GatedStorageManager.signalLoadRecovery(servingManager!);

      await waitUntil(
        () => storedLog().length === 3,
        "all three consequences to land after the pass resumes",
        30_000,
      );
      // THE PIN: arrival order held across the mid-pass gap.
      expect(storedLog()).toEqual(["A", "A", "B"]);
    } finally {
      GatedStorageManager.loadParkFailDocId = undefined;
      GatedStorageManager.loadParkFailAddress = undefined;
      if (servingManager !== undefined) {
        servingManager.syncGateWhen = undefined;
        servingManager.syncGate = undefined;
      }
      gate.resolve();
      cancelDemand();
    }
  });

  it('the IN-QUEUE arrival-order barrier, discriminated: a later-arrived event whose closure does NOT touch the failing doc — so it is perfectly runnable and already QUEUED behind the parked head — defers with the head instead of overtaking it (events.md §2; independent review F3: the previous construction had both handlers reading the armed doc, so a barrier-less B parked on the same failure and self-deferred through the HEAD arm, making the in-queue half undiscriminable. Here the park rejection is DEFERRED until both entries are provably queued, so the mid-pass half cannot be what saves the order. Mutation: empty the barrier loop in failHeadEventLoadPark → B1 consequences while A2 is deferred and the log reads ["A","B","A"])', async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);

    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: DISJOINT_CLOSURE_LOG_PATTERN }],
    }, { space });
    // `gate` is its OWN doc, linked into the argument: that is what makes
    // pushA's closure a strict superset of pushB's.
    const gateCell = clientRuntime.getCell<number>(
      space,
      "in-queue-barrier-gate",
      undefined,
    );
    const argument = clientRuntime.getCell<
      { log: string[]; gate: unknown }
    >(space, "in-queue-barrier-arg", undefined);
    const result = clientRuntime.getCell<Record<string, unknown>>(
      space,
      "in-queue-barrier-result",
      compiled.resultSchema,
    );
    await gateCell.sync();
    await argument.sync();
    await result.sync();
    {
      const seed = clientRuntime.edit();
      gateCell.withTx(seed).set(0);
      argument.withTx(seed).set({ log: [], gate: gateCell });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    const argumentId = argument.getAsNormalizedFullLink().id;
    const gateId = gateCell.getAsNormalizedFullLink().id;
    // The construction only means anything if the gate really is a separate
    // doc — otherwise arming it would arm both closures again (the F3 trap).
    expect(gateId, "the gate must be its own doc, not a path in the argument")
      .not.toBe(argumentId);
    const storedLog =
      (): string[] => ((Engine.read(engine, { id: argumentId })?.value as
        | { log?: string[] }
        | undefined)?.log ?? []);
    const send = (stream: "a" | "b") =>
      (result.key(stream) as unknown as { send(value: unknown): unknown })
        .send({});

    GatedStorageManager.loadParkFailHits = 0;
    const park = Promise.withResolvers<void>();
    park.promise.catch(() => {});
    try {
      // Warm the piece and stream `a`'s sidecar, unarmed.
      send("a");
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => storedLog().length === 1,
        "the warm-up consequence to land",
      );
      expect(storedLog()).toEqual(["A"]);

      // Arm the failure on the GATE doc — pushA's closure only — and HOLD
      // the park open rather than failing it now.
      GatedStorageManager.loadParkSettle = park.promise;
      GatedStorageManager.loadParkFailDocId = gateId;
      GatedStorageManager.loadParkFailAddress = {
        space,
        scope: "space",
        id: gateId,
      };

      const processedBefore = host!.stats().events.processed;
      send("a"); // A2 arrives first
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      send("b"); // B1 second
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();

      // THE CONSTRUCTION: wait until BOTH entries have been queued into the
      // scheduler (processed counts queueEvent calls per drain pass) and A2
      // is provably PARKED on the held settle. At this instant the queue is
      // [A2 parked at head, B1 behind it] — B1 is exactly what the in-queue
      // sweep must reach, and the mid-pass half is irrelevant because no
      // deferral has happened yet.
      await waitUntil(
        () =>
          host!.stats().events.processed >= processedBefore + 2 &&
          GatedStorageManager.loadParkFailHits > 0,
        "both entries queued with A2 parked on the held load",
      );
      expect(storedLog(), "neither may have run while A2 holds the head")
        .toEqual(["A"]);

      // Now fail the park. A2 defers; the in-queue barrier must take B1 with
      // it even though B1's own closure is perfectly loadable.
      park.reject(new Error("memory session revoked: unauthorized (pin seam)"));
      await waitUntil(
        () => host!.stats().events.loadParkDeferrals >= 2,
        "the head deferral and its barrier victim",
      );
      expect(
        storedLog(),
        "B1 must not consequence while the earlier-arrived A2 is deferred",
      ).toEqual(["A"]);

      // Heal: both re-drain in arrival order.
      GatedStorageManager.loadParkFailDocId = undefined;
      GatedStorageManager.loadParkFailAddress = undefined;
      GatedStorageManager.loadParkSettle = undefined;
      GatedStorageManager.signalLoadRecovery(servingManager!);

      await waitUntil(
        () => storedLog().length === 3,
        "all three consequences to land after the load failure clears",
        30_000,
      );
      // THE PIN: arrival order. Without the in-queue sweep B1 runs at the
      // moment A2 defers and the log reads ["A","B","A"].
      expect(storedLog()).toEqual(["A", "A", "B"]);
      expect(host!.stats().events.dropped).toBe(0);
    } finally {
      GatedStorageManager.loadParkFailDocId = undefined;
      GatedStorageManager.loadParkFailAddress = undefined;
      GatedStorageManager.loadParkSettle = undefined;
      park.reject(new Error("pin teardown"));
      cancelDemand();
    }
  });

  it("a store-time RowLabelCommitError attributes the refused operation to its served event and reaches retained commit-finalization attention", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "row-label-cover-arg",
      result: "row-label-cover-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    const argumentId = argument.getAsNormalizedFullLink().id;
    const storedValue = () =>
      (Engine.read(engine, { id: argumentId })?.value as
        | { value?: number }
        | undefined)?.value ?? 0;
    const entriesOf = (sidecarId: string) =>
      ((Engine.read(engine, { id: sidecarId })?.value ??
        {}) as StreamEventsDocValue).entries ?? [];
    const allEntries = () =>
      sidecarIdsIn(engine).flatMap((id) => entriesOf(id));
    const bump = () =>
      (result.key("bump") as unknown as { send(value: unknown): unknown })
        .send({});

    try {
      // Warm the piece and identify the ordinary handler-write operation that
      // stands in for the sqlite operation rejected by the real engine sink.
      // This decorator sits after the sink's typed producer boundary: the
      // regression below exercises the wave-owner and SpaceServer handoff,
      // while memory's sqlite tests exercise the real evaluator rollback.
      bump();
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(() => storedValue() === 1, "the warm-up bump to land");

      rejectWaveCommitWith = (batch) => {
        if (batch.consequenceOf.length === 0) return undefined;
        const failedOperation = batch.operations.findIndex((operation) =>
          operation.op !== "sqlite" && operation.id === argumentId
        );
        if (failedOperation < 0) return undefined;
        return {
          name: "RowLabelCommitError",
          message: "sqlite commit refused: synthetic row-label verdict",
          failedOperation,
        };
      };
      bump();
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();

      await waitUntil(
        () =>
          allEntries().some((entry) =>
            entry.status === "needs-attention" &&
            entry.attention?.phase === "commit-finalization"
          ),
        "the refused wave to reach commit-finalization attention",
      );
      const terminal = allEntries().find((entry) =>
        entry.status === "needs-attention" &&
        entry.attention?.phase === "commit-finalization"
      )!;
      expect(rejectedWaveCommits).toBe(1);
      expect(storedValue(), "the refused handler write never committed").toBe(
        1,
      );
      expect(terminal.consequenced).toBe(true);
      expect(terminal.deliveryDeferral).toBeUndefined();
      expect(terminal.attention).toMatchObject({
        failureClass: "protocol",
        code: "permanent-delivery-failure",
        recovery: "explicit-retry",
      });
      expect(host!.stats().events.needsAttention.total).toBe(1);
      expect(
        host!.stats().events.needsAttention.byPhase["commit-finalization"],
      ).toBe(1);

      // The refusal proves no consequence committed, so the explicit retry is
      // eligible and runs under a fresh event ID after the synthetic refusal
      // has been consumed.
      const sidecarId = sidecarIdsIn(engine).find((id) =>
        entriesOf(id).some((entry) => entry.eventId === terminal.eventId)
      )!;
      const retried = await clientManager.resolveEventAttention(
        space,
        terminal.eventId,
        terminal.seq!,
        sidecarId,
        "retry",
      );
      expect(retried.resolution.kind).toBe("retried");
      const retryId = (retried.resolution as {
        kind: "retried";
        eventId: string;
      }).eventId;
      await waitUntil(
        () =>
          storedValue() === 2 &&
          allEntries().some((entry) =>
            entry.eventId === retryId && entry.consequenced === true
          ),
        "the explicit retry to consequence exactly once",
      );
      expect(
        allEntries().filter((entry) => entry.retryOf === terminal.eventId),
      ).toHaveLength(1);
    } finally {
      rejectWaveCommitWith = undefined;
      cancelDemand();
    }
  });

  it("a rejected terminal notice keeps the persistent failed head and later arrival blocked until a newer input lets the cover commit in order", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "budget-bypass-arg",
      result: "budget-bypass-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    let deliveryNow = 10_000;
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      deliveryFailureBudgetMs: 60_000,
      deliveryFailureNow: () => deliveryNow,
    });
    const argumentId = argument.getAsNormalizedFullLink().id;
    const storedValue = () =>
      (Engine.read(engine, { id: argumentId })?.value as
        | { value?: number }
        | undefined)?.value ?? 0;
    const entriesOf = (sidecarId: string) =>
      ((Engine.read(engine, { id: sidecarId })?.value ??
        {}) as StreamEventsDocValue).entries ?? [];
    const allEntries = () =>
      sidecarIdsIn(engine).flatMap((id) => entriesOf(id));
    const bump = () =>
      (result.key("bump") as unknown as { send(value: unknown): unknown })
        .send({});

    GatedStorageManager.loadParkFailHits = 0;
    try {
      // Warm the piece and its sidecar, unarmed.
      bump();
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(() => storedValue() === 1, "the warm-up bump to land");

      // A PERSISTENT failure — never healed inside this pin.
      GatedStorageManager.loadParkFailDocId = argumentId;
      GatedStorageManager.loadParkFailAddress = {
        space,
        scope: "space",
        id: argumentId,
      };
      bump();
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();

      await waitUntil(
        () =>
          allEntries().some((entry) =>
            entry.deliveryDeferral?.phase === "dispatch-load"
          ),
        "the failed-head checkpoint to commit",
      );
      deliveryNow += 60_000;
      expect(host!.stats().events.maxAccumulatedDeliveryFailureMs).toBe(
        60_000,
      );
      failNextServingCommit = "result-error";
      failServingCommitActionPrefix = "server-execution/event-consequence:";
      // A successful replacement load is a positive recovery wake. The
      // handler's required load still fails, so the retry re-enters failed
      // state with the accumulated budget and attempts to terminalize
      // immediately. Reject that notice wave: the entry and its arrival
      // barrier must remain pending.
      GatedStorageManager.signalLoadRecovery(servingManager!);
      await waitUntil(
        () => host!.stats().events.needsAttentionSealFailures === 1,
        "the rejected attention notice to be counted",
      );
      expect(rejectedWaveCommits).toBe(0);
      expect(
        allEntries().some((entry) => entry.status === "needs-attention"),
      ).toBe(false);
      expect(
        allEntries().some((entry) => entry.deliveryDeferral !== undefined),
      ).toBe(true);
      expect(storedValue(), "the failed handler remains unrun").toBe(1);
      expect(host!.stats().events.needsAttention.total).toBe(0);

      // Heal, then append one later event. Its newer input is the valid wake
      // for the failed notice write. The original cover must commit first;
      // only then may the later healthy handler consequence land.
      GatedStorageManager.loadParkFailDocId = undefined;
      GatedStorageManager.loadParkFailAddress = undefined;
      rejectWaveCommitWhen = (batch) =>
        JSON.stringify(batch.operations).includes('"attention"');
      bump();
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () => allEntries().length === 3,
        "the later event append to become durable",
      );
      await waitUntil(
        () => host!.stats().events.needsAttentionSealFailures === 2,
        "the whole-wave attention rejection to be counted",
      );
      expect(rejectedWaveCommits).toBe(1);
      rejectWaveCommitWhen = undefined;
      const noticeWake = clientRuntime.getCell<{ value: number }>(
        space,
        "needs-attention-notice-write-wake",
        undefined,
      );
      await noticeWake.sync();
      const wakeTx = clientRuntime.edit();
      noticeWake.withTx(wakeTx).set({ value: 1 });
      expect((await wakeTx.commit()).error).toBeUndefined();
      await waitUntil(
        () =>
          allEntries().some((entry) =>
            entry.status === "needs-attention" &&
            entry.attention?.phase === "dispatch-load"
          ) && storedValue() === 2,
        "the cover to commit before the later healthy consequence",
      );
      const terminal = allEntries().find((entry) =>
        entry.status === "needs-attention"
      )!;
      expect(terminal.consequenced).toBe(true);
      expect(terminal.deliveryDeferral).toBeUndefined();
      expect(terminal.attention).toMatchObject({
        failureClass: "session-revoked",
        code: "delivery-failure-budget-exhausted",
        accumulatedFailureMs: 60_000,
        recovery: "explicit-retry",
      });
      expect(storedValue()).toBe(2);
      const entries = allEntries();
      expect(entries[1].status).toBe("needs-attention");
      expect(entries[2].consequenced).toBe(true);
      expect(host!.stats().events.dropped).toBe(0);
      expect(host!.stats().events.needsAttention.total).toBe(1);
      expect(
        host!.stats().events.needsAttention.byPhase["dispatch-load"],
      ).toBe(1);
      expect(host!.stats().events.deliveryDeferralsActive).toBe(0);
      expect(host!.stats().events.deliveryFailuresActive).toBe(0);

      // Explicit Retry is one fresh durable event with exact provenance. A
      // lost-response replay returns the recorded ID and never appends or runs
      // a second successor.
      const retryResult = await clientManager.resolveEventAttention(
        space,
        terminal.eventId,
        terminal.seq!,
        sidecarIdsIn(engine)[0],
        "retry",
      );
      expect(retryResult.resolution.kind).toBe("retried");
      const retryId = (retryResult.resolution as {
        kind: "retried";
        eventId: string;
      }).eventId;
      await waitUntil(
        () =>
          storedValue() === 3 &&
          allEntries().some((entry) =>
            entry.eventId === retryId && entry.consequenced === true
          ),
        "the one explicit retry to consequence",
      );
      const replay = await clientManager.resolveEventAttention(
        space,
        terminal.eventId,
        terminal.seq!,
        sidecarIdsIn(engine)[0],
        "retry",
      );
      expect(replay.resolution).toEqual(retryResult.resolution);
      expect(
        allEntries().filter((entry) => entry.retryOf === terminal.eventId),
      ).toHaveLength(1);
      expect(host!.stats().events.explicitRetries).toBe(1);
    } finally {
      rejectWaveCommitWhen = undefined;
      GatedStorageManager.loadParkFailDocId = undefined;
      GatedStorageManager.loadParkFailAddress = undefined;
      cancelDemand();
    }
  });
});
