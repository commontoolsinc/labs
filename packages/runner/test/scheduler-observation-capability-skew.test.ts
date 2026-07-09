/**
 * Capability-skew regression: a persistentSchedulerState=ON client against a
 * server that did NOT advertise the capability at hello.
 *
 * Scheduler-state persistence is an OPTIONAL protocol capability
 * (memory/v2.ts `compatibleMemoryProtocolFlags`): peers with different
 * scheduler flags must still share memory data. A flag-off server strips
 * scheduler payloads at `transact` (memory/v2/server.ts), so an
 * observation-only batch commit (`operations: []`) arrives empty and is
 * TERMINALLY rejected by the engine ("memory v2 commit requires at least one
 * operation", memory/v2/engine.ts). Because the client flushes pending
 * observation batches BEFORE every semantic commit (storage/v2.ts
 * `pushCommit`), that one rejection used to spread to every subsequent
 * semantic commit: event handlers logged "dropping the write without retry"
 * and the whole session's writes starved — the flag-ON
 * cfc-group-chat-demo-multi-runtime failure, where the worker runtimes ran
 * flag-ON while the harness realm's standalone server had the flag off.
 *
 * The contract pinned here: the client reads the server's hello-advertised
 * flags (`client.serverFlags`) and fails CLOSED — observations are dropped
 * client-side (never sent), semantic commits flow untouched, and the
 * snapshot listing degrades to "no snapshots" without a wire request.
 */

import { assertEquals } from "@std/assert";
import {
  jsonFromValue,
  valueFromJson,
} from "@commonfabric/data-model/codec-json";
import { EmptyReconstructionContext } from "@commonfabric/data-model/codec-common";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/api";
import type { URI } from "@commonfabric/memory/interface";
import {
  type ClientCommit,
  getMemoryProtocolFlags,
  resetPersistentSchedulerStateConfig,
  setPersistentSchedulerStateConfig,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import {
  SingleSessionFactory,
  TEST_HELLO_SESSION_OPEN,
  testSessionOpenAuthMetadata,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase(
  "scheduler-observation-capability-skew",
);
const space = signer.did();
const DOCUMENT_MIME = "application/json" as const;
const DOC = "of:capability-skew-doc" as URI;

const reconstructionContext = new EmptyReconstructionContext(
  true,
  "no cell reconstruction in capability-skew transport",
);

type WireTransact = {
  localSeq: number;
  operationCount: number;
  carriesObservations: boolean;
};

/**
 * Minimal in-process stand-in for a memory v2 server whose ambient
 * `persistentSchedulerState` is OFF: hello.ok advertises the capability as
 * absent, and `transact` reproduces the flag-off server verbatim — scheduler
 * payloads are stripped, and a commit that is empty after stripping is
 * rejected exactly like memory/v2/engine.ts does.
 */
class FlagOffServerTransport implements MemoryV2Client.Transport {
  #receiver: (payload: string) => void = () => {};
  #serverSeq = 0;
  #sessionOpenCount = 0;
  readonly transacts: WireTransact[] = [];
  readonly requestTypes: string[] = [];

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = valueFromJson(payload, reconstructionContext) as {
      type: string;
      requestId?: string;
      session?: { sessionId?: string };
      commit?: ClientCommit;
    };
    this.requestTypes.push(message.type);

    switch (message.type) {
      case "hello":
        this.respond({
          type: "hello.ok",
          protocol: "memory",
          // The one divergence from this realm's ambient flags: the server
          // never advertises persistentSchedulerState (an off-flag or older
          // deployment). Everything else mirrors the real handshake.
          flags: {
            ...getMemoryProtocolFlags(),
            persistentSchedulerState: false,
          },
          sessionOpen: TEST_HELLO_SESSION_OPEN,
        });
        break;
      case "session.open":
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: message.session?.sessionId ?? "session:skew",
            serverSeq: this.#serverSeq,
            sessionOpen: testSessionOpenAuthMetadata(
              `skew-open-${++this.#sessionOpenCount}`,
            ),
          },
        });
        break;
      case "session.watch.set":
      case "session.watch.add":
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: this.#serverSeq,
            sync: {
              type: "sync",
              fromSeq: this.#serverSeq,
              toSeq: this.#serverSeq,
              upserts: [],
              removes: [],
            },
          },
        });
        break;
      case "session.ack":
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: { serverSeq: this.#serverSeq },
        });
        break;
      case "transact": {
        const commit = message.commit!;
        this.transacts.push({
          localSeq: commit.localSeq,
          operationCount: commit.operations.length,
          carriesObservations: commit.schedulerObservation !== undefined ||
            (commit.schedulerObservationBatch?.length ?? 0) > 0,
        });
        // Faithful flag-off server: strip scheduler payloads
        // (memory/v2/server.ts `transact`), then apply engine validation
        // (memory/v2/engine.ts `applyCommitTransaction`) — an empty commit
        // rejects terminally.
        const hasPreconditions = (commit.preconditions?.length ?? 0) > 0;
        if (commit.operations.length === 0 && !hasPreconditions) {
          this.respond({
            type: "response",
            requestId: message.requestId!,
            error: {
              name: "TransactionError",
              message: "memory v2 commit requires at least one operation",
            },
          });
          break;
        }
        const seq = ++this.#serverSeq;
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            seq,
            branch: "",
            revisions: commit.operations.map((operation, index) => ({
              id: (operation as { id: URI }).id,
              branch: "",
              seq,
              opIndex: index,
              commitSeq: seq,
              op: operation.op,
            })),
          },
        });
        break;
      }
      default:
        throw new Error(`Unhandled capability-skew message: ${message.type}`);
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private respond(message: unknown): void {
    this.#receiver(jsonFromValue(message as FabricValue));
  }
}

type ReplicaSurface = {
  commitNative(
    transaction: {
      operations: Array<
        { op: "set"; id: URI; type: typeof DOCUMENT_MIME; value: unknown }
      >;
      schedulerObservation?: unknown;
    },
  ): Promise<
    { ok?: Record<PropertyKey, never>; error?: { message?: string } }
  >;
  listSchedulerActionSnapshots(query: Record<never, never>): Promise<{
    serverSeq: number;
    snapshots: unknown[];
  }>;
};

const schedulerObservation = {
  version: 1,
  branch: "",
  pieceId: "of:skew-piece",
  processGeneration: 1,
  actionId: "action:skew",
  actionKind: "computation",
  implementationFingerprint: "impl:skew",
  runtimeFingerprint: "runtime:skew",
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads: [],
  shallowReads: [],
  actualChangedWrites: [],
  currentKnownWrites: [],
  declaredWrites: [],
  materializerWriteEnvelopes: [],
  status: "success",
};

Deno.test("flag-ON client degrades observation traffic against a server that did not advertise the capability", async () => {
  setPersistentSchedulerStateConfig(true);
  const transport = new FlagOffServerTransport();
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL(`memory://capability-skew-${crypto.randomUUID()}`),
  }, new SingleSessionFactory(transport));
  try {
    const provider = storageManager.open(space) as unknown as {
      replica: ReplicaSurface;
    };
    const replica = provider.replica;

    // An action run's observation-only commit: must resolve ok WITHOUT a wire
    // commit (nothing to send it to — the server would reject it as empty
    // after stripping, and that rejection used to poison the next semantic
    // commit through the flush-before-commit ordering in pushCommit).
    const observationResult = await replica.commitNative({
      operations: [],
      schedulerObservation,
    });
    assertEquals(observationResult, { ok: {} });

    // The semantic write that used to be starved: an event-handler-style
    // commit right behind the observation. This is THE regression assertion —
    // before the capability gate it failed with the server's "memory v2
    // commit requires at least one operation" and the handler dropped the
    // write without retry.
    const writeResult = await replica.commitNative({
      operations: [{
        op: "set",
        id: DOC,
        type: DOCUMENT_MIME,
        value: { value: { label: "post-observation write" } },
      }],
    });
    assertEquals(writeResult, { ok: {} });

    // Exactly one transact reached the wire (the semantic write), and no
    // scheduler payload of any kind rode along on an observation-only commit.
    assertEquals(
      transport.transacts.map((entry) => ({
        operationCount: entry.operationCount,
        carriesObservations: entry.carriesObservations &&
          entry.operationCount === 0,
      })),
      [{ operationCount: 1, carriesObservations: false }],
    );

    // The resume path degrades to "no snapshots" without asking the server
    // for a capability it never offered.
    const listed = await replica.listSchedulerActionSnapshots({});
    assertEquals(listed, { serverSeq: 0, snapshots: [] });
    assertEquals(
      transport.requestTypes.filter((type) =>
        type === "scheduler.snapshot.list"
      ),
      [],
    );
  } finally {
    await storageManager.close();
    resetPersistentSchedulerStateConfig();
  }
});
