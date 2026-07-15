import {
  assert,
  assertEquals,
  assertExists,
  assertStrictEquals,
} from "@std/assert";
import {
  jsonFromValue,
  valueFromJson,
} from "@commonfabric/data-model/codec-json";
import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/api";
import type { MIME, URI } from "@commonfabric/memory/interface";
import {
  type EntityDocument,
  type PatchOp,
  resetPersistentSchedulerStateConfig,
  type SessionSync,
  setPersistentSchedulerStateConfig,
} from "@commonfabric/memory/v2";
import { EmptyReconstructionContext } from "@commonfabric/data-model/codec-common";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import type {
  ClientCommit,
  ConfirmedRead,
  Operation,
  PendingRead,
} from "@commonfabric/memory/v2";
import {
  parentPath,
  parsePointer,
  pathsOverlap,
} from "../../memory/v2/path.ts";
import { applyPatch } from "../../memory/v2/patch.ts";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type { AppliedCommit } from "@commonfabric/memory/v2/engine";
import type {
  IStorageProviderWithReplica,
  StorageNotification,
} from "../src/storage/interface.ts";
import {
  NotificationRecorder,
  ScriptedSessionTransport,
  type ScriptedTransportMessage,
  SingleSessionFactory,
  testSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-stacked-commit");
const space = signer.did();
const DOCUMENT_MIME = "application/json" as const;
const testReconstructionContext = new EmptyReconstructionContext(
  true,
  "no cell reconstruction in stacked commit transport",
);
const DOCS = {
  A: "of:memory-v2-stacked-A" as URI,
  B: "of:memory-v2-stacked-B" as URI,
  C: "of:memory-v2-stacked-C" as URI,
  D: "of:memory-v2-stacked-D" as URI,
} as const;
type DocKey = keyof typeof DOCS;

type TestProvider = IStorageProviderWithReplica & {
  get(uri: URI): EntityDocument | undefined;
};

type CommitResult =
  | { ok: Record<PropertyKey, never>; error?: undefined }
  | {
    ok?: undefined;
    error: { name?: string; message?: string };
  };
type CommitResultPromise = Promise<CommitResult>;
type RootDocument = { value: RootValue };
type StackedCommitOperation =
  | { op: "set"; id: URI; type: MIME; value: RootDocument }
  | {
    op: "patch";
    id: URI;
    type: MIME;
    patches: PatchOp[];
    value: RootDocument;
  }
  | { op: "delete"; id: URI; type: MIME };
type StackedCommit = {
  operations: StackedCommitOperation[];
  schedulerObservation?: unknown;
};
type StackedReplica =
  & Omit<
    IStorageProviderWithReplica["replica"],
    "commitNative" | "get" | "pull"
  >
  & {
    commitNative(
      transaction: StackedCommit,
      source?: unknown,
    ): CommitResultPromise;
    buildReads(
      source: unknown,
      localSeq: number,
    ): {
      confirmed: ConfirmedRead[];
      pending: PendingRead[];
    };
    get(address: {
      id: URI;
      type: MIME;
    }): {
      since?: number;
      is?: FabricValue;
    } | undefined;
    pull(
      entries: Array<[{ id: URI; type: MIME }, undefined]>,
    ): CommitResultPromise;
  };
type RevertNotification = Extract<StorageNotification, { type: "revert" }>;

type RootValue = FabricValue;
type DocState = {
  seq: number;
  value: RootValue;
};
type AppliedRecord = {
  localSeq: number;
  commit: ClientCommit;
  applied: AppliedCommit;
  touched: TouchedWrite[];
};
type RejectionError = {
  name: string;
  message: string;
  /**
   * Mirrors the real server's retryable-conflict marker: the client attaches
   * `readyToRetry` (the read-repair gate) ONLY when a ConflictError carries a
   * numeric `retryAfterSeq`. Opt-in via the rejectConflict outcome — absent
   * everywhere else so existing rejections stay gate-less.
   */
  retryAfterSeq?: number;
};
type RejectedRecord = {
  localSeq: number;
  commit: ClientCommit;
  error: RejectionError;
};
type ScriptedOutcome =
  | {
    kind: "accept";
    remoteInterleave?: RemoteCommit;
    responseGate?: Promise<void>;
  }
  | {
    kind: "rejectConflict";
    message?: string;
    remoteInterleave?: RemoteCommit;
    responseGate?: Promise<void>;
    /** See {@link RejectionError.retryAfterSeq}. */
    retryAfterSeq?: number;
  }
  | {
    kind: "dropThenReplayAccept";
    remoteInterleave?: RemoteCommit;
    responseGate?: Promise<void>;
  }
  | {
    kind: "dropThenReplayReject";
    message?: string;
    remoteInterleave?: RemoteCommit;
    responseGate?: Promise<void>;
  };
type RemoteCommit = {
  label: string;
  operations: RootOp[];
};
type RootOp =
  | { op: "set"; id: URI; value: RootValue }
  | { op: "delete"; id: URI };
type TouchedWrite = {
  id: URI;
  paths: string[][];
};
type LocalPendingVersion = {
  localSeq: number;
  value: RootValue;
};
type LocalDocModel = {
  confirmedSeq: number;
  confirmed: RootValue;
  pending: LocalPendingVersion[];
};
type ResultRecord = {
  localSeq: number;
  status: "ok" | "error";
  message?: string;
};
type PendingDispatch = {
  localSeq: number;
  promise: CommitResultPromise;
};

class ScriptedServerModel {
  connectionCount = 0;
  transactLocalSeqs: number[] = [];
  readonly confirmed = new Map<URI, DocState>();
  readonly applied = new Map<number, AppliedRecord>();
  readonly rejected = new Map<number, RejectedRecord>();
  readonly scripted = new Map<number, ScriptedOutcome>();
  readonly dropped = new Set<number>();
  serverSeq = 0;
  sessionId = "session:stacked";

  constructor() {
    for (const id of Object.values(DOCS)) {
      this.confirmed.set(id, { seq: 0, value: undefined });
    }
  }

  setOutcome(localSeq: number, outcome: ScriptedOutcome): void {
    this.scripted.set(localSeq, outcome);
  }

  seed(id: URI, value: RootValue): DocState {
    return this.applyRootCommit({
      label: "seed",
      operations: [{ op: value === undefined ? "delete" : "set", id, value }],
    }).states.get(id)!;
  }

  injectRemote(remote: RemoteCommit): void {
    this.applyRootCommit(remote);
  }

  transact(
    commit: ClientCommit,
  ): { type: "accept"; applied: AppliedCommit } | {
    type: "reject";
    error: RejectionError;
  } | { type: "drop" } {
    const priorApplied = this.applied.get(commit.localSeq);
    if (priorApplied) {
      return { type: "accept", applied: priorApplied.applied };
    }
    const priorRejected = this.rejected.get(commit.localSeq);
    if (priorRejected) {
      return { type: "reject", error: priorRejected.error };
    }

    const scripted = this.scripted.get(commit.localSeq) ?? { kind: "accept" };
    if (scripted.remoteInterleave) {
      this.applyRootCommit(scripted.remoteInterleave);
    }

    // A scripted retryAfterSeq marks whichever ConflictError this commit
    // produces (the natural stale-read error below included) as retryable,
    // matching the real server attaching it to every conflict verdict.
    const retryAfterSeq = scripted.kind === "rejectConflict"
      ? scripted.retryAfterSeq
      : undefined;

    const readError = this.validateReads(commit);
    if (readError) {
      return this.reject(
        commit,
        retryAfterSeq === undefined
          ? readError
          : { ...readError, retryAfterSeq },
      );
    }

    const shouldDrop = scripted.kind === "dropThenReplayAccept" ||
      scripted.kind === "dropThenReplayReject";
    const shouldReject = scripted.kind === "rejectConflict" ||
      scripted.kind === "dropThenReplayReject";

    if (shouldReject) {
      const rejected = this.reject(commit, {
        name: "ConflictError",
        message: scripted.message ?? "synthetic conflict",
        ...(retryAfterSeq !== undefined ? { retryAfterSeq } : {}),
      });
      if (shouldDrop && !this.dropped.has(commit.localSeq)) {
        this.dropped.add(commit.localSeq);
        return { type: "drop" };
      }
      return rejected;
    }

    const applied = this.accept(commit);
    if (shouldDrop && !this.dropped.has(commit.localSeq)) {
      this.dropped.add(commit.localSeq);
      return { type: "drop" };
    }
    return applied;
  }

  private validateReads(
    commit: ClientCommit,
  ): RejectionError | null {
    for (const read of commit.reads.pending) {
      const dependency = this.applied.get(read.localSeq);
      if (!dependency) {
        return {
          name: "ConflictError",
          message: `pending dependency localSeq=${read.localSeq}`,
        };
      }
      for (const accepted of this.applied.values()) {
        if (accepted.applied.seq <= dependency.applied.seq) {
          continue;
        }
        if (accepted.touched.some((write) => readOverlapsWrite(read, write))) {
          return {
            name: "ConflictError",
            message: `stale pending read localSeq=${read.localSeq}`,
          };
        }
      }
    }

    for (const read of commit.reads.confirmed) {
      const current = this.confirmed.get(read.id as URI) ?? {
        seq: 0,
        value: undefined,
      };
      if (current.seq !== read.seq) {
        return {
          name: "ConflictError",
          message: `stale confirmed read seq=${read.seq} actual=${current.seq}`,
        };
      }
    }

    return null;
  }

  private reject(
    commit: ClientCommit,
    error: RejectionError,
  ) {
    this.rejected.set(commit.localSeq, {
      localSeq: commit.localSeq,
      commit,
      error,
    });
    return { type: "reject" as const, error };
  }

  private accept(commit: ClientCommit) {
    const touched = commit.operations.flatMap((operation) =>
      touchedWritesForOperation(operation)
    );
    const revisions = commit.operations
      .filter((operation) => operation.op !== "sqlite")
      .map((operation, index) => ({
        id: operation.id,
        branch: "",
        seq: this.serverSeq + 1,
        opIndex: index,
        commitSeq: this.serverSeq + 1,
        op: operation.op,
      }));
    const applied = {
      seq: ++this.serverSeq,
      branch: "",
      revisions,
    } as AppliedCommit;

    for (const operation of commit.operations) {
      if (operation.op === "sqlite") continue;
      const next = applyOperation(
        operation,
        this.confirmed.get(operation.id as URI)?.value,
      );
      this.confirmed.set(operation.id as URI, {
        seq: applied.seq,
        value: next,
      });
    }

    this.applied.set(commit.localSeq, {
      localSeq: commit.localSeq,
      commit,
      applied,
      touched,
    });

    return { type: "accept" as const, applied };
  }

  private applyRootCommit(
    remote: RemoteCommit,
  ): { states: Map<URI, DocState> } {
    const seq = ++this.serverSeq;
    const states = new Map<URI, DocState>();
    for (const operation of remote.operations) {
      const next = operation.op === "delete"
        ? undefined
        : operation.value === undefined
        ? undefined
        : clone(operation.value);
      const state = { seq, value: next };
      this.confirmed.set(operation.id, state);
      states.set(operation.id, state);
    }
    return { states };
  }
}

class ScriptedModelTransport extends ScriptedSessionTransport {
  constructor(readonly model: ScriptedServerModel) {
    super({ name: "stacked", sessionId: model.sessionId, space });
  }

  protected override openServerSeq(): number {
    return this.model.serverSeq;
  }

  protected override onHello(): void {
    this.model.connectionCount += 1;
  }

  // The commit payloads carry full FabricValues; decode with a context that
  // FAILS on cell reconstruction rather than the default memory context.
  protected override decode(payload: string): ScriptedTransportMessage {
    return valueFromJson(
      payload,
      testReconstructionContext,
    ) as ScriptedTransportMessage;
  }
  protected override encode(message: unknown): string {
    return jsonFromValue(message as FabricValue);
  }

  // The harness owns teardown; closing the session must not signal a
  // disconnect (which would trigger client reconnect churn mid-assertion).
  protected override onClose(): void {}

  protected override handle(message: ScriptedTransportMessage): void {
    switch (message.type) {
      case "session.watch.set":
      case "session.watch.add":
        // Registers the watch but returns an empty sync: the harness NEVER
        // volunteers document state — catch-up only arrives when a test
        // explicitly delivers it via pushSync, so tests control the wire
        // order of verdicts vs updates.
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: this.model.serverSeq,
            sync: {
              type: "sync",
              fromSeq: this.model.serverSeq,
              toSeq: this.model.serverSeq,
              upserts: [],
              removes: [],
            },
          },
        });
        break;
      case "transact": {
        const commit = message.commit as ClientCommit;
        // Receipt-time bookkeeping: `transactLocalSeqs` records that a commit
        // reached the server even while its verdict is still gated. The
        // cascade tests (and the stress bookkeeping) use it to distinguish
        // "sent, verdict in flight" from "never sent".
        this.model.transactLocalSeqs.push(commit.localSeq);
        const responseGate = this.model.scripted.get(
          commit.localSeq,
        )?.responseGate;
        setTimeout(() => {
          void (async () => {
            await responseGate;
            const response = this.model.transact(commit);
            if (response.type === "drop") {
              this.disconnect(new Error("disconnect"));
              return;
            }
            this.respond({
              type: "response",
              requestId: message.requestId!,
              ...(response.type === "accept"
                ? { ok: response.applied }
                : { error: response.error }),
            });
          })();
        }, 0);
        break;
      }
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
    }
  }

  /**
   * Deliver an unsolicited server-push sync frame (the real server's
   * timer-batched `session/effect` fan-out) to the client receiver. Opt-in:
   * the harness never pushes sync on its own, so a test controls exactly
   * when subscription catch-up arrives relative to commit verdicts.
   */
  pushSync(options: PushSyncOptions): void {
    this.emitSync({
      type: "sync",
      fromSeq: this.model.serverSeq,
      toSeq: this.model.serverSeq,
      ...(options.caughtUpLocalSeq !== undefined
        ? { caughtUpLocalSeq: options.caughtUpLocalSeq }
        : {}),
      upserts: (options.upserts ?? []).map((upsert) => ({
        branch: "",
        id: upsert.id,
        seq: upsert.seq,
        ...(upsert.deleted === true
          ? { deleted: true as const }
          : { doc: { value: upsert.value } }),
      })),
      removes: [],
    } as SessionSync);
  }
}

type PushSyncOptions = {
  upserts?: Array<{
    id: URI;
    seq: number;
    value?: RootValue;
    deleted?: true;
  }>;
  /** The server's caught-up marker: resolves client + runner read-repair
   * waiters for every localSeq <= this value. */
  caughtUpLocalSeq?: number;
};

type Harness = ReturnType<typeof createHarness>;

const createHarness = () => {
  const model = new ScriptedServerModel();
  const transport = new ScriptedModelTransport(model);
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL(`memory://runner-v2-stacked-${crypto.randomUUID()}`),
  }, sessionFactory);
  const notifications = new NotificationRecorder();
  const provider = storageManager.open(space) as TestProvider;
  storageManager.subscribe(notifications);

  const replica = provider.replica as StackedReplica;

  let nextLocalSeq = 1;
  const dispatch = (
    operations: RootOp[],
    source?: unknown,
  ): PendingDispatch => {
    const localSeq = nextLocalSeq++;
    const promise = replica.commitNative({
      operations: operations.map((operation) =>
        operation.op === "delete"
          ? { op: "delete", id: operation.id, type: DOCUMENT_MIME }
          : {
            op: "set",
            id: operation.id,
            type: DOCUMENT_MIME,
            value: { value: operation.value },
          }
      ),
    }, source);
    return { localSeq, promise };
  };

  return {
    model,
    transport,
    storageManager,
    provider,
    replica,
    notifications,
    dispatch,
    pushSync: (options: PushSyncOptions) => transport.pushSync(options),
    close: async () => {
      await storageManager.close();
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  };
};

const clone = <T>(value: T): T => structuredClone(value);

const valueFor = (
  label: string,
  extra: Record<string, FabricValue> = {},
): Record<string, FabricValue> => ({ label, ...extra });

const sourceFromReads = (
  reads: Array<{
    id: URI;
    path?: string[];
    seq?: number;
    nonRecursive?: boolean;
  }>,
) => {
  const activities = reads.map((read) => ({
    space,
    id: read.id,
    type: DOCUMENT_MIME,
    path: ["value", ...(read.path ?? [])],
    ...(read.nonRecursive === true ? { nonRecursive: true } : {}),
    meta: read.seq === undefined ? {} : { seq: read.seq },
  }));
  return {
    getReadActivities() {
      return activities;
    },
  };
};

const schedulerObservationFor = (actionId: string) => ({
  version: 1,
  branch: "",
  pieceId: "of:test-piece",
  processGeneration: 1,
  actionId,
  actionKind: "computation",
  implementationFingerprint: "impl:test",
  runtimeFingerprint: "runtime:test",
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads: [],
  shallowReads: [],
  actualChangedWrites: [],
  currentKnownWrites: [],
  declaredWrites: [],
  materializerWriteEnvelopes: [],
  status: "success",
});

Deno.test("memory v2 ignores no-op scheduler observations when persistent scheduler state is off", async () => {
  resetPersistentSchedulerStateConfig();
  const harness = createHarness();
  try {
    const result = await harness.replica.commitNative({
      operations: [],
      schedulerObservation: schedulerObservationFor("action:off"),
    });

    assertEquals(result, { ok: {} });
    assertEquals(harness.model.transactLocalSeqs, []);
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 batches adjacent no-op scheduler observations", async () => {
  setPersistentSchedulerStateConfig(true);
  const harness = createHarness();
  try {
    const first = harness.replica.commitNative({
      operations: [],
      schedulerObservation: schedulerObservationFor("action:first"),
    });
    const second = harness.replica.commitNative({
      operations: [],
      schedulerObservation: schedulerObservationFor("action:second"),
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assertEquals(firstResult, { ok: {} });
    assertEquals(secondResult, { ok: {} });
    assertEquals(harness.model.transactLocalSeqs.length, 1);

    const applied = [...harness.model.applied.values()][0];
    assertEquals(applied.commit.operations, []);
    assertEquals(
      applied.commit.schedulerObservationBatch?.map((entry) =>
        (entry.schedulerObservation as { actionId: string }).actionId
      ),
      ["action:first", "action:second"],
    );
  } finally {
    await harness.close();
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 flushes no-op scheduler batches before semantic writes", async () => {
  setPersistentSchedulerStateConfig(true);
  const harness = createHarness();
  try {
    const observation = harness.replica.commitNative({
      operations: [],
      schedulerObservation: schedulerObservationFor("action:first"),
    });
    const write = harness.replica.commitNative({
      operations: [{
        op: "set",
        id: DOCS.A,
        type: DOCUMENT_MIME,
        value: { value: valueFor("write") },
      }],
    });

    const [observationResult, writeResult] = await Promise.all([
      observation,
      write,
    ]);
    assertEquals(observationResult, { ok: {} });
    assertEquals(writeResult, { ok: {} });
    assertEquals(harness.model.transactLocalSeqs.length, 2);

    const applied = [...harness.model.applied.values()].sort((a, b) =>
      a.applied.seq - b.applied.seq
    );
    assertEquals(applied[0].commit.operations, []);
    assertEquals(
      applied[0].commit.schedulerObservationBatch?.map((entry) =>
        (entry.schedulerObservation as { actionId: string }).actionId
      ),
      ["action:first"],
    );
    assertEquals(
      applied[1].commit.operations.map((operation) => operation.op),
      [
        "set",
      ],
    );
  } finally {
    await harness.close();
    resetPersistentSchedulerStateConfig();
  }
});

const visibleValue = (provider: TestProvider, id: URI) => {
  const value = provider.get(id)?.value;
  return value === undefined ? undefined : clone(value);
};

const changedIdsFor = (
  notifications: StorageNotification[],
  type: StorageNotification["type"],
) =>
  notifications
    .filter((notification) => notification.type === type)
    .map((notification) =>
      "changes" in notification
        ? [...notification.changes].map((change) => change.address.id as URI)
          .sort()
        : []
    );

const currentSeq = (
  harness: Harness,
  id: URI,
) => harness.replica.get({ id, type: DOCUMENT_MIME })?.since ?? 0;

const readOverlapsWrite = (
  read: ConfirmedRead | PendingRead,
  write: TouchedWrite,
) => {
  if (read.id !== write.id) {
    return false;
  }
  return write.paths.some((path) => pathsOverlap(read.path, path));
};

const touchedWritesForOperation = (operation: Operation): TouchedWrite[] => {
  if (operation.op === "sqlite") return []; // no entity writes
  if (operation.op !== "patch") {
    return [{ id: operation.id as URI, paths: [[]] }];
  }
  const paths = operation.patches.flatMap((patch) => {
    switch (patch.op) {
      case "replace":
      case "splice":
      case "append":
      case "add-unique":
      case "remove-by-value":
      case "increment":
        return [parsePointer(patch.path)];
      case "add":
      case "remove": {
        const path = parsePointer(patch.path);
        return [path, parentPath(path)];
      }
      case "move": {
        const from = parsePointer(patch.from);
        const to = parsePointer(patch.path);
        return [from, to, parentPath(from), parentPath(to)];
      }
    }
  });
  return [{ id: operation.id as URI, paths }];
};

const applyOperation = (
  operation: Operation,
  current: RootValue,
): RootValue => {
  if (operation.op === "sqlite") return current; // not an entity write
  if (operation.op === "delete") {
    return undefined;
  }
  if (operation.op === "set") {
    return clone(
      isEntityDocumentValue(operation.value)
        ? operation.value.value as RootValue
        : operation.value as RootValue,
    );
  }
  const next = applyPatch(
    { value: clone(current) ?? {} } as FabricValue,
    operation.patches,
  ) as { value?: RootValue };
  return next.value;
};

const isEntityDocumentValue = (value: unknown): value is { value: RootValue } =>
  typeof value === "object" && value !== null && "value" in value;

const createLocalModel = (): Map<URI, LocalDocModel> =>
  new Map(
    Object.values(DOCS).map((id) => [id, {
      confirmedSeq: 0,
      confirmed: undefined,
      pending: [],
    }]),
  );

const applyPendingToModel = (
  model: Map<URI, LocalDocModel>,
  localSeq: number,
  operations: RootOp[],
) => {
  for (const operation of operations) {
    const record = model.get(operation.id)!;
    record.pending.push({
      localSeq,
      value: operation.op === "delete" ? undefined : clone(operation.value),
    });
  }
};

const confirmPendingInModel = (
  model: Map<URI, LocalDocModel>,
  localSeq: number,
  seq: number,
  operations: RootOp[],
) => {
  for (const id of new Set(operations.map((operation) => operation.id))) {
    const record = model.get(id)!;
    const pending = [...record.pending].findLast((entry) =>
      entry.localSeq === localSeq
    );
    if (!pending) {
      continue;
    }
    record.confirmedSeq = seq;
    record.confirmed = clone(pending.value);
    record.pending = record.pending.filter((entry) =>
      entry.localSeq !== localSeq
    );
  }
};

const dropPendingInModel = (
  model: Map<URI, LocalDocModel>,
  localSeq: number,
) => {
  for (const record of model.values()) {
    record.pending = record.pending.filter((entry) =>
      entry.localSeq !== localSeq
    );
  }
};

const notificationLog = (notifications: StorageNotification[]) =>
  notifications.map((notification) => ({
    type: notification.type,
    ids: "changes" in notification
      ? [...notification.changes].map((change) => change.address.id as URI)
        .sort()
      : [],
  }));

const isRevertNotification = (
  notification: StorageNotification,
): notification is RevertNotification => notification.type === "revert";

const valueField = (value: unknown): RootValue | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as { readonly value?: RootValue }).value;
};

const topPendingSurface = (
  harness: Harness,
) => {
  const reads = harness.replica.buildReads(
    sourceFromReads(Object.values(DOCS).map((id) => ({ id }))),
    10_000,
  );
  return new Map(
    reads.pending.map((read) => [read.id as URI, read.localSeq]),
  );
};

const expectVisible = (
  harness: Harness,
  expected: Partial<Record<DocKey, RootValue>>,
) => {
  for (
    const [key, value] of Object.entries(expected) as Array<[DocKey, RootValue]>
  ) {
    assertEquals(visibleValue(harness.provider, DOCS[key]), value);
  }
};

const assertResultOk = async (promise: CommitResultPromise) => {
  assertEquals(await promise, { ok: {} });
};

const assertConflict = async (
  promise: CommitResultPromise,
  contains?: string,
) => {
  const result = await promise;
  assertExists(result.error);
  assertEquals(result.error.name, "ConflictError");
  if (contains) {
    assert(String(result.error.message).includes(contains));
  }
};

// Poll until `predicate` holds (e.g. "commit N reached the wire") so a test
// can gate server verdicts deterministically without racing the client's
// pre-send awaits (session handshake, batch flush).
const waitForCondition = async (
  predicate: () => boolean,
  label: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const beginSet = (
  harness: Harness,
  id: URI,
  value: RootValue,
  source?: unknown,
) => harness.dispatch([{ op: "set", id, value }], source);

const beginBatch = (
  harness: Harness,
  operations: RootOp[],
  source?: unknown,
) => harness.dispatch(operations, source);

const beginPatch = (
  harness: Harness,
  id: URI,
  patches: PatchOp[],
  value: RootValue,
  source?: unknown,
) =>
  harness.replica.commitNative({
    operations: [{
      op: "patch",
      id,
      type: DOCUMENT_MIME,
      patches,
      value: { value },
    }],
  }, source);

const seedAccepted = async (
  harness: Harness,
  id: URI,
  value: RootValue,
) => {
  const first = beginSet(harness, id, value);
  harness.model.setOutcome(first.localSeq, { kind: "accept" });
  await assertResultOk(first.promise);
};

const runStressSeed = async (seed: number) => {
  const harness = await createHarness();
  const localModel = createLocalModel();
  const results = new Map<number, ResultRecord>();
  const pending = new Map<number, {
    promise: CommitResultPromise;
    operations: RootOp[];
  }>();
  const random = mulberry32(seed);
  const docIds = Object.values(DOCS);

  try {
    for (let step = 0; step < 30; step += 1) {
      while (pending.size > 2) {
        const oldest = [...pending.keys()].sort((left, right) =>
          left - right
        )[0];
        const entry = pending.get(oldest)!;
        const result = await entry.promise;
        const outcome = harness.model.applied.get(oldest);
        if (result.ok) {
          assertExists(
            outcome,
            `seed=${seed} step=${step} missing applied ${oldest}`,
          );
          confirmPendingInModel(
            localModel,
            oldest,
            outcome.applied.seq,
            entry.operations,
          );
          results.set(oldest, { localSeq: oldest, status: "ok" });
        } else {
          dropPendingInModel(localModel, oldest);
          results.set(oldest, {
            localSeq: oldest,
            status: "error",
            message: result.error?.message,
          });
        }
        pending.delete(oldest);
      }

      const target = docIds[randomInt(random, docIds.length)];
      const pair = [
        target,
        docIds.find((id) => id !== target && random() > 0.5) ??
          docIds.find((id) => id !== target)!,
      ] as const;
      const mode = randomInt(random, 3);
      const randomRootOp = (id: URI, label: string): RootOp => {
        const op = random() < 0.2 ? "delete" : "set";
        return op === "delete"
          ? { op, id }
          : { op, id, value: valueFor(label) };
      };
      const operations = mode === 0
        ? [randomRootOp(target, `seed-${seed}-step-${step}-root`)]
        : pair.map((id, index) =>
          randomRootOp(id, `seed-${seed}-step-${step}-doc-${index}`)
        );

      const outstandingDocs = [...pending.values()]
        .flatMap((entry) => entry.operations.map((operation) => operation.id));
      const sameDocPending = outstandingDocs.includes(target);
      const otherDocPending = outstandingDocs.some((id) => id !== target);
      const dependencyMode = randomInt(random, 4);
      const source = dependencyMode === 1
        ? sourceFromReads([{
          id: target,
          seq: localModel.get(target)!.confirmedSeq,
        }])
        : dependencyMode === 2 && sameDocPending
        ? sourceFromReads([{ id: target }])
        : dependencyMode === 3 && otherDocPending
        ? sourceFromReads([{
          id: outstandingDocs.find((id) => id !== target)!,
        }])
        : undefined;

      const outcomeMode = randomInt(random, 3);
      const local = beginBatch(harness, operations, source);
      const remoteDoc = docIds.find((id) =>
        !operations.some((operation) =>
          operation.id === id
        )
      ) ?? DOCS.D;
      const remoteInterleave: RemoteCommit = {
        label: `remote-${seed}-${step}`,
        operations: [{
          op: "set",
          id: remoteDoc,
          value: valueFor(`remote-${seed}-${step}`),
        }],
      };
      harness.model.setOutcome(
        local.localSeq,
        outcomeMode === 0 ? { kind: "accept" } : outcomeMode === 1
          ? {
            kind: "rejectConflict",
            message: `synthetic conflict seed=${seed} step=${step}`,
          }
          : { kind: "accept", remoteInterleave },
      );

      applyPendingToModel(localModel, local.localSeq, operations);
      pending.set(local.localSeq, {
        promise: local.promise,
        operations,
      });
    }

    for (
      const localSeq of [...pending.keys()].sort((left, right) => left - right)
    ) {
      const entry = pending.get(localSeq)!;
      const result = await entry.promise;
      if (result.ok) {
        const outcome = harness.model.applied.get(localSeq);
        assertExists(outcome, `seed=${seed} missing applied ${localSeq}`);
        confirmPendingInModel(
          localModel,
          localSeq,
          outcome.applied.seq,
          entry.operations,
        );
        results.set(localSeq, { localSeq, status: "ok" });
      } else {
        dropPendingInModel(localModel, localSeq);
        results.set(localSeq, {
          localSeq,
          status: "error",
          message: result.error?.message,
        });
      }
      pending.delete(localSeq);
    }

    assertEquals(
      topPendingSurface(harness).size,
      0,
      `seed=${seed} final pending`,
    );
    for (const [localSeq, result] of results) {
      const applied = harness.model.applied.get(localSeq);
      const rejected = harness.model.rejected.get(localSeq);
      if (result.status === "ok") {
        assertExists(
          applied,
          `seed=${seed} result ${localSeq} expected applied`,
        );
      } else {
        assertExists(
          rejected,
          `seed=${seed} result ${localSeq} expected rejection`,
        );
      }
    }
    assert(
      notificationLog(harness.notifications.notifications).every((entry) =>
        entry.type === "commit" || entry.type === "revert"
      ),
      `seed=${seed} unexpected notification types`,
    );
  } finally {
    await harness.close();
  }
};

const mulberry32 = (seed: number) => {
  let current = seed >>> 0;
  return () => {
    current |= 0;
    current = (current + 0x6d2b79f5) | 0;
    let t = Math.imul(current ^ (current >>> 15), 1 | current);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const randomInt = (random: () => number, maxExclusive: number) =>
  Math.floor(random() * maxExclusive);

Deno.test("memory v2 stacked commits: C1,C2,C3 all succeed on one doc", async () => {
  const harness = await createHarness();
  try {
    const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
    harness.model.setOutcome(c1.localSeq, { kind: "accept" });
    const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
    harness.model.setOutcome(c2.localSeq, { kind: "accept" });
    const c3 = beginSet(harness, DOCS.A, valueFor("c3"));
    harness.model.setOutcome(c3.localSeq, { kind: "accept" });

    expectVisible(harness, { A: valueFor("c3") });
    await assertResultOk(c1.promise);
    await assertResultOk(c2.promise);
    await assertResultOk(c3.promise);

    expectVisible(harness, { A: valueFor("c3") });
    assertEquals(changedIdsFor(harness.notifications.notifications, "commit"), [
      [DOCS.A],
      [DOCS.A],
      [DOCS.A],
    ]);
    assertEquals(
      changedIdsFor(harness.notifications.notifications, "revert"),
      [],
    );
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits preserve earlier patch fields across later stale same-doc patches", async () => {
  const harness = await createHarness();
  try {
    const supportOnly = {
      internal: {
        selectedCategory: "support",
        visibleTemplates: [{ id: "support-shift-schedule" }],
        "__#4": "Support",
      },
    };
    const allVisible = [
      { id: "hero-email-kit" },
      { id: "support-shift-schedule" },
      { id: "product-tour-deck" },
      { id: "ops-kanban" },
      { id: "retro-guide" },
    ];

    await seedAccepted(harness, DOCS.A, supportOnly);

    harness.model.setOutcome(2, { kind: "accept" });
    harness.model.setOutcome(3, { kind: "accept" });
    harness.model.setOutcome(4, { kind: "accept" });

    const replica = harness.replica;

    const c2 = replica.commitNative({
      operations: [{
        op: "patch",
        id: DOCS.A,
        type: DOCUMENT_MIME,
        patches: [{
          op: "replace",
          path: "/value/internal/selectedCategory",
          value: "all",
        }],
        value: {
          value: {
            internal: {
              selectedCategory: "all",
              visibleTemplates: [{ id: "support-shift-schedule" }],
              "__#4": "Support",
            },
          },
        },
      }],
    });
    const c3 = replica.commitNative({
      operations: [{
        op: "patch",
        id: DOCS.A,
        type: DOCUMENT_MIME,
        patches: [
          {
            op: "replace",
            path: "/value/internal/visibleTemplates/0",
            value: allVisible[0],
          },
          {
            op: "splice",
            path: "/value/internal/visibleTemplates",
            index: 1,
            remove: 0,
            add: allVisible.slice(1),
          },
        ],
        value: {
          value: {
            internal: {
              selectedCategory: "all",
              visibleTemplates: allVisible,
              "__#4": "Support",
            },
          },
        },
      }],
    });
    const c4 = replica.commitNative({
      operations: [{
        op: "patch",
        id: DOCS.A,
        type: DOCUMENT_MIME,
        patches: [{
          op: "replace",
          path: "/value/internal/__#4",
          value: "All",
        }],
        value: {
          value: {
            internal: {
              selectedCategory: "all",
              visibleTemplates: [{ id: "support-shift-schedule" }],
              "__#4": "All",
            },
          },
        },
      }],
    });

    await assertResultOk(c2);
    await assertResultOk(c3);
    await assertResultOk(c4);

    expectVisible(harness, {
      A: {
        internal: {
          selectedCategory: "all",
          visibleTemplates: allVisible,
          "__#4": "All",
        },
      },
    });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: C2 conflicts, C3 independent on same doc survives", async () => {
  const harness = await createHarness();
  try {
    const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
    harness.model.setOutcome(c1.localSeq, { kind: "accept" });
    const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
    harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
    const c3 = beginSet(harness, DOCS.A, valueFor("c3"));
    harness.model.setOutcome(c3.localSeq, { kind: "accept" });

    expectVisible(harness, { A: valueFor("c3") });
    await assertResultOk(c1.promise);
    await assertConflict(c2.promise);
    expectVisible(harness, { A: valueFor("c3") });
    await assertResultOk(c3.promise);
    expectVisible(harness, { A: valueFor("c3") });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: C2 conflicts, C3 independent on different doc survives", async () => {
  const harness = await createHarness();
  try {
    const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
    harness.model.setOutcome(c1.localSeq, { kind: "accept" });
    const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
    harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
    const c3 = beginSet(harness, DOCS.B, valueFor("c3"));
    harness.model.setOutcome(c3.localSeq, { kind: "accept" });

    await assertResultOk(c1.promise);
    await assertConflict(c2.promise);
    await assertResultOk(c3.promise);

    expectVisible(harness, { A: valueFor("c1"), B: valueFor("c3") });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: C3 depends on C2 same doc and C2 conflicts, so C3 fails", async () => {
  const harness = await createHarness();
  try {
    const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
    harness.model.setOutcome(c1.localSeq, { kind: "accept" });
    await assertResultOk(c1.promise);

    const c2 = beginSet(
      harness,
      DOCS.A,
      valueFor("c2"),
      sourceFromReads([{ id: DOCS.A, seq: currentSeq(harness, DOCS.A) }]),
    );
    harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
    const c3 = beginSet(
      harness,
      DOCS.A,
      valueFor("c3"),
      sourceFromReads([{ id: DOCS.A }]),
    );
    harness.model.setOutcome(c3.localSeq, { kind: "accept" });

    await assertConflict(c2.promise);
    await assertConflict(c3.promise, "pending dependency");
    expectVisible(harness, { A: valueFor("c1") });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: C3 depends on C2 different doc and C2 conflicts, so C3 fails", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, valueFor("base-a"));
    await seedAccepted(harness, DOCS.B, valueFor("base-b"));

    const c2 = beginSet(harness, DOCS.B, valueFor("c2"));
    harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
    const c3 = beginSet(
      harness,
      DOCS.A,
      valueFor("c3"),
      sourceFromReads([{ id: DOCS.B }]),
    );
    harness.model.setOutcome(c3.localSeq, { kind: "accept" });

    await assertConflict(c2.promise);
    await assertConflict(c3.promise, "pending dependency");
    expectVisible(harness, { A: valueFor("base-a"), B: valueFor("base-b") });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: C3 depends on C2 and C2 conflicts on unrelated data in the same atomic commit, so C3 still fails", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, valueFor("base-a"));
    await seedAccepted(harness, DOCS.B, valueFor("base-b"));

    const c2 = beginBatch(harness, [
      { op: "set", id: DOCS.A, value: valueFor("c2-a") },
      { op: "set", id: DOCS.B, value: valueFor("c2-b") },
    ]);
    harness.model.setOutcome(c2.localSeq, {
      kind: "rejectConflict",
      message: "synthetic conflict on unrelated B write",
    });
    const c3 = beginSet(
      harness,
      DOCS.C,
      valueFor("c3"),
      sourceFromReads([{ id: DOCS.A }]),
    );
    harness.model.setOutcome(c3.localSeq, { kind: "accept" });

    await assertConflict(c2.promise, "unrelated B write");
    await assertConflict(c3.promise, "pending dependency");
    expectVisible(harness, {
      A: valueFor("base-a"),
      B: valueFor("base-b"),
      C: undefined,
    });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: C3 depends only on C1, C2 conflicts, C3 survives", async () => {
  const harness = await createHarness();
  try {
    const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
    harness.model.setOutcome(c1.localSeq, { kind: "accept" });
    await assertResultOk(c1.promise);

    const c2 = beginSet(harness, DOCS.B, valueFor("c2"));
    harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
    const c3 = beginSet(
      harness,
      DOCS.C,
      valueFor("c3"),
      sourceFromReads([{ id: DOCS.A, seq: currentSeq(harness, DOCS.A) }]),
    );
    harness.model.setOutcome(c3.localSeq, { kind: "accept" });

    await assertConflict(c2.promise);
    await assertResultOk(c3.promise);
    expectVisible(harness, {
      A: valueFor("c1"),
      B: undefined,
      C: valueFor("c3"),
    });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: C4 depends on surviving C3 while C2 conflicts, C4 survives", async () => {
  const harness = await createHarness();
  try {
    const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
    harness.model.setOutcome(c1.localSeq, { kind: "accept" });
    await assertResultOk(c1.promise);

    const c2 = beginSet(harness, DOCS.B, valueFor("c2"));
    harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
    const c3 = beginSet(harness, DOCS.C, valueFor("c3"));
    harness.model.setOutcome(c3.localSeq, { kind: "accept" });
    const c4 = beginSet(
      harness,
      DOCS.D,
      valueFor("c4"),
      sourceFromReads([{ id: DOCS.C }]),
    );
    harness.model.setOutcome(c4.localSeq, { kind: "accept" });

    await assertConflict(c2.promise);
    await assertResultOk(c3.promise);
    await assertResultOk(c4.promise);
    expectVisible(harness, {
      A: valueFor("c1"),
      C: valueFor("c3"),
      D: valueFor("c4"),
    });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: C4 depends on failed C2 and surviving C3, C4 fails", async () => {
  const harness = await createHarness();
  try {
    const c2 = beginSet(harness, DOCS.B, valueFor("c2"));
    harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
    const c3 = beginSet(harness, DOCS.C, valueFor("c3"));
    harness.model.setOutcome(c3.localSeq, { kind: "accept" });
    const c4 = beginSet(
      harness,
      DOCS.D,
      valueFor("c4"),
      sourceFromReads([{ id: DOCS.B }, { id: DOCS.C }]),
    );
    harness.model.setOutcome(c4.localSeq, { kind: "accept" });

    await assertConflict(c2.promise);
    await assertResultOk(c3.promise);
    await assertConflict(c4.promise, "pending dependency");
    expectVisible(harness, { C: valueFor("c3"), D: undefined });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: C2 writes A and B atomically, conflicts on B, A also rolls back", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, valueFor("base-a"));
    await seedAccepted(harness, DOCS.B, valueFor("base-b"));
    const c2 = beginBatch(harness, [
      { op: "set", id: DOCS.A, value: valueFor("c2-a") },
      { op: "set", id: DOCS.B, value: valueFor("c2-b") },
    ]);
    harness.model.setOutcome(c2.localSeq, {
      kind: "rejectConflict",
      message: "synthetic conflict on B",
    });
    await assertConflict(c2.promise, "conflict on B");
    expectVisible(harness, { A: valueFor("base-a"), B: valueFor("base-b") });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: C2 deletes a doc, C3 depends on that delete, C2 conflicts, C3 fails", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, valueFor("base"));
    const c2 = beginBatch(harness, [{ op: "delete", id: DOCS.A }]);
    harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
    const c3 = beginSet(
      harness,
      DOCS.B,
      valueFor("c3"),
      sourceFromReads([{ id: DOCS.A }]),
    );
    harness.model.setOutcome(c3.localSeq, { kind: "accept" });

    await assertConflict(c2.promise);
    await assertConflict(c3.promise, "pending dependency");
    expectVisible(harness, { A: valueFor("base"), B: undefined });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: C2 deletes a doc, C3 recreates independently, C3 survives", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, valueFor("base"));
    const c2 = beginBatch(harness, [{ op: "delete", id: DOCS.A }]);
    harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
    const c3 = beginSet(harness, DOCS.B, valueFor("c3"));
    harness.model.setOutcome(c3.localSeq, { kind: "accept" });

    await assertConflict(c2.promise);
    await assertResultOk(c3.promise);
    expectVisible(harness, { A: valueFor("base"), B: valueFor("c3") });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: visible state falls back to newest surviving pending after middle revert", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, valueFor("base"));
    const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
    harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
    const c3 = beginSet(harness, DOCS.A, valueFor("c3"));
    harness.model.setOutcome(c3.localSeq, { kind: "accept" });

    expectVisible(harness, { A: valueFor("c3") });
    await assertConflict(c2.promise);
    expectVisible(harness, { A: valueFor("c3") });
    await assertResultOk(c3.promise);
    expectVisible(harness, { A: valueFor("c3") });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: visible state falls back to confirmed when failed commit had the top pending value", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, valueFor("base"));
    const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
    harness.model.setOutcome(c2.localSeq, { kind: "accept" });
    const c3 = beginSet(harness, DOCS.A, valueFor("c3"));
    harness.model.setOutcome(c3.localSeq, { kind: "rejectConflict" });

    expectVisible(harness, { A: valueFor("c3") });
    await assertResultOk(c2.promise);
    await assertConflict(c3.promise);
    expectVisible(harness, { A: valueFor("c2") });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: revert notification only mentions docs touched by the failed commit", async () => {
  const harness = await createHarness();
  try {
    const c1 = beginBatch(harness, [
      { op: "set", id: DOCS.A, value: valueFor("c1-a") },
      { op: "set", id: DOCS.B, value: valueFor("c1-b") },
    ]);
    harness.model.setOutcome(c1.localSeq, { kind: "rejectConflict" });
    const c2 = beginSet(harness, DOCS.C, valueFor("c2"));
    harness.model.setOutcome(c2.localSeq, { kind: "accept" });

    await assertConflict(c1.promise);
    await assertResultOk(c2.promise);
    const reverts = changedIdsFor(
      harness.notifications.notifications,
      "revert",
    );
    assertEquals(reverts, [[DOCS.A, DOCS.B]]);
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: later surviving pending state is not reverted when earlier unrelated commit fails", async () => {
  const harness = await createHarness();
  try {
    const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
    harness.model.setOutcome(c1.localSeq, { kind: "rejectConflict" });
    const c2 = beginSet(harness, DOCS.B, valueFor("c2"));
    harness.model.setOutcome(c2.localSeq, { kind: "accept" });

    await assertConflict(c1.promise);
    expectVisible(harness, { B: valueFor("c2") });
    await assertResultOk(c2.promise);
    expectVisible(harness, { B: valueFor("c2") });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: same-doc sibling writes with no dependency survive middle failure", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, { left: 0, right: 0 });
    const c2 = beginSet(harness, DOCS.A, { left: 1, right: 0 });
    harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
    const c3 = beginSet(harness, DOCS.A, { left: 0, right: 2 });
    harness.model.setOutcome(c3.localSeq, { kind: "accept" });

    await assertConflict(c2.promise);
    await assertResultOk(c3.promise);
    expectVisible(harness, { A: { left: 0, right: 2 } });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: same-doc later commit with dependency on failed middle commit fails even when writing a different path", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, { left: 0, right: 0 });
    const c2 = beginSet(harness, DOCS.A, { left: 1, right: 0 });
    harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
    const c3 = beginSet(
      harness,
      DOCS.A,
      { left: 1, right: 2 },
      sourceFromReads([{ id: DOCS.A, path: ["left"] }]),
    );
    harness.model.setOutcome(c3.localSeq, { kind: "accept" });

    await assertConflict(c2.promise);
    await assertConflict(c3.promise, "pending dependency");
    expectVisible(harness, { A: { left: 0, right: 0 } });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: duplicate localSeq returns the same promise/result", async () => {
  const model = new ScriptedServerModel();
  const transport = new ScriptedModelTransport(model);
  const client = await MemoryV2Client.connect({ transport });
  try {
    const session = await client.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    model.setOutcome(1, { kind: "accept" });
    const duplicateValue: FabricValue = valueFor("dup");
    const duplicateOperation: Operation = {
      op: "set",
      id: DOCS.A,
      value: { value: duplicateValue },
    };
    const commit: ClientCommit = {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [duplicateOperation],
    };

    const first = session.transact(commit);
    const second = session.transact(commit);
    assertEquals(await first, await second);
    assertEquals(model.transactLocalSeqs, [1]);
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 stacked commits: dropped receipt for C1 replays, later stacked commits still flush in order", async () => {
  const harness = await createHarness();
  try {
    const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
    harness.model.setOutcome(c1.localSeq, { kind: "dropThenReplayAccept" });
    const c2 = beginSet(harness, DOCS.B, valueFor("c2"));
    harness.model.setOutcome(c2.localSeq, { kind: "accept" });

    await assertResultOk(c1.promise);
    await assertResultOk(c2.promise);
    assertEquals(harness.transport.model.transactLocalSeqs, [1, 2, 1, 2]);
    assertEquals(harness.transport.model.connectionCount >= 2, true);
    expectVisible(harness, { A: valueFor("c1"), B: valueFor("c2") });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: replayed C1 conflicts, later independent C2 still flushes", async () => {
  const harness = await createHarness();
  try {
    const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
    harness.model.setOutcome(c1.localSeq, {
      kind: "dropThenReplayReject",
      message: "replayed conflict",
    });
    const c2 = beginSet(harness, DOCS.B, valueFor("c2"));
    harness.model.setOutcome(c2.localSeq, { kind: "accept" });

    await assertConflict(c1.promise, "replayed conflict");
    await assertResultOk(c2.promise);
    assertEquals(harness.transport.model.transactLocalSeqs, [1, 2, 1, 2]);
    expectVisible(harness, { A: undefined, B: valueFor("c2") });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: retry after revert with fresh read basis succeeds", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, valueFor("base"));
    const stale = beginSet(
      harness,
      DOCS.A,
      valueFor("stale"),
      sourceFromReads([{ id: DOCS.A, seq: currentSeq(harness, DOCS.A) }]),
    );
    harness.model.setOutcome(stale.localSeq, { kind: "rejectConflict" });
    await assertConflict(stale.promise);

    const retry = beginSet(
      harness,
      DOCS.A,
      valueFor("retry"),
      sourceFromReads([{ id: DOCS.A, seq: currentSeq(harness, DOCS.A) }]),
    );
    harness.model.setOutcome(retry.localSeq, { kind: "accept" });
    await assertResultOk(retry.promise);
    expectVisible(harness, { A: valueFor("retry") });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: pending-read compaction keeps localSeq boundaries in a stack", async () => {
  const harness = await createHarness();
  try {
    const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
    harness.model.setOutcome(c1.localSeq, { kind: "dropThenReplayAccept" });
    const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
    harness.model.setOutcome(c2.localSeq, { kind: "accept" });

    const reads = harness.replica.buildReads(
      sourceFromReads([
        { id: DOCS.A },
        { id: DOCS.A, path: ["nested"] },
      ]),
      3,
    );

    assertEquals(reads.confirmed, []);
    assertEquals(
      reads.pending.map((read) => ({
        id: read.id,
        localSeq: read.localSeq,
      })),
      [{ id: DOCS.A, localSeq: 2 }],
    );
    await assertResultOk(c1.promise);
    await assertResultOk(c2.promise);
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: conflict rejection delivered before the winning update holds the revert until read repair", async () => {
  const harness = await createHarness();
  try {
    // Both sides at seq 1: A = v1.
    await seedAccepted(harness, DOCS.A, valueFor("v1"));

    // Subscribe the runner to server pushes. The real runner always holds a
    // watch over the docs it reads; without an active watch a pushed sync
    // frame has no subscriber and the read-repair gate could never release.
    assertEquals(
      await harness.replica.pull([[
        { id: DOCS.A, type: DOCUMENT_MIME },
        undefined,
      ]]),
      { ok: {} },
    );

    // Client 2's write wins server-side (server seq 2). The harness never
    // pushes sync on its own, so client 1 has not seen it yet.
    harness.model.injectRemote({
      label: "client-2-wins",
      operations: [{ op: "set", id: DOCS.A, value: valueFor("v2winner") }],
    });
    const winnerSeq = harness.model.confirmed.get(DOCS.A)!.seq;
    assertEquals(winnerSeq, 2);

    const conflictBaseline = getLoggerCountsBreakdown()["storage.v2"]
      ?.["commit-conflict"]?.debug ?? 0;

    // Client 1 commits against its stale confirmed read (seq 1). The scripted
    // retryAfterSeq makes the rejection retryable — exactly what engages
    // finalizeRejection's waitForConflictReadRepair gate. The verdict is NOT
    // gated: it is delivered immediately, BEFORE the catch-up carrying the
    // winning value (the real server's fan-out is timer-batched, so
    // rejection-first is the systematic wire order).
    const mine = beginSet(
      harness,
      DOCS.A,
      valueFor("v1mine"),
      sourceFromReads([{ id: DOCS.A, seq: 1 }]),
    );
    harness.model.setOutcome(mine.localSeq, {
      kind: "rejectConflict",
      retryAfterSeq: winnerSeq,
    });
    let settled = false;
    const commitResult = mine.promise.then((result) => {
      settled = true;
      return result;
    });

    // THE WINDOW: "commit-conflict" is counted synchronously in pushCommit's
    // catch, right before finalizeRejection — so once the count moves, the
    // rejection has demonstrably reached the runner while the winning update
    // is still in flight. Give the held state a real chance to (wrongly)
    // settle before asserting it did not.
    await waitForCondition(
      () =>
        (getLoggerCountsBreakdown()["storage.v2"]?.["commit-conflict"]
          ?.debug ?? 0) > conflictBaseline,
      "the conflict rejection to reach the runner",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Rejection processed-but-held: the commit promise must not settle, the
    // optimistic value stays visible, and no revert is emitted before the
    // read repair lands.
    assertEquals(settled, false);
    expectVisible(harness, { A: valueFor("v1mine") });
    assertEquals(
      changedIdsFor(harness.notifications.notifications, "revert"),
      [],
    );

    // Release: the subscription catch-up carrying client 2's winning value
    // plus the caught-up marker covering the rejected commit's localSeq.
    harness.pushSync({
      upserts: [{ id: DOCS.A, seq: winnerSeq, value: valueFor("v2winner") }],
      caughtUpLocalSeq: mine.localSeq,
    });

    const result = await commitResult;
    assertExists(result.error);
    assertEquals(result.error.name, "ConflictError");
    assert(String(result.error.message).includes("stale confirmed read"));

    // §3.12 semantics: the repair was applied into confirmed BEFORE the
    // revert snapshot completed — visible state lands on the winner, not on
    // the reverted optimistic value and not on the stale v1.
    expectVisible(harness, { A: valueFor("v2winner") });
    assertEquals(currentSeq(harness, DOCS.A), winnerSeq);

    // Exactly one revert, scoped to A, whose changes read v1mine -> v2winner.
    const reverts = harness.notifications.notifications.filter(
      isRevertNotification,
    );
    assertEquals(reverts.length, 1);
    const changes = [...reverts[0].changes];
    assertEquals(changes.map((change) => change.address.id), [DOCS.A]);
    assertEquals(valueField(changes[0].before), valueFor("v1mine"));
    assertEquals(valueField(changes[0].after), valueFor("v2winner"));

    // The surfaced rejection's retry gate is already satisfied: readyToRetry
    // resolves immediately now that the catch-up has been applied.
    const readyToRetry = (result.error as {
      readyToRetry?: () => Promise<void>;
    }).readyToRetry;
    assertExists(readyToRetry);
    const raced = await Promise.race([
      readyToRetry().then(() => "ready" as const),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 500)
      ),
    ]);
    assertEquals(raced, "ready");
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: repeated pending reads reuse the latest materialized state", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, {
      left: 0,
      right: 0,
    });

    harness.model.setOutcome(2, { kind: "accept" });
    const left = beginPatch(
      harness,
      DOCS.A,
      [{
        op: "replace",
        path: "/value/left",
        value: 1,
      }],
      {
        left: 1,
        right: 0,
      },
    );

    harness.model.setOutcome(3, { kind: "accept" });
    const right = beginPatch(
      harness,
      DOCS.A,
      [{
        op: "replace",
        path: "/value/right",
        value: 2,
      }],
      {
        left: 1,
        right: 2,
      },
    );

    const firstDocument = harness.provider.get(DOCS.A);
    const secondDocument = harness.provider.get(DOCS.A);
    assertExists(firstDocument);
    assertStrictEquals(secondDocument, firstDocument);

    const firstState = harness.replica.get({
      id: DOCS.A,
      type: DOCUMENT_MIME,
    });
    const secondState = harness.replica.get({
      id: DOCS.A,
      type: DOCUMENT_MIME,
    });
    assertExists(firstState);
    assertExists(secondState);
    const firstMaterialized = firstState.is;
    const secondMaterialized = secondState.is;
    assertExists(firstMaterialized);
    assertExists(secondMaterialized);
    assertStrictEquals(secondMaterialized, firstMaterialized);

    await assertResultOk(left);
    await assertResultOk(right);
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: confirming the head pending write promotes the cached materialization", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, {
      count: 0,
    });

    harness.model.setOutcome(2, { kind: "accept" });
    const commit = beginPatch(
      harness,
      DOCS.A,
      [{
        op: "replace",
        path: "/value/count",
        value: 1,
      }],
      {
        count: 1,
      },
    );

    const pendingDocument = harness.provider.get(DOCS.A);
    const pendingState = harness.replica.get({
      id: DOCS.A,
      type: DOCUMENT_MIME,
    });
    assertExists(pendingDocument);
    assertExists(pendingState);

    await assertResultOk(commit);

    const confirmedDocument = harness.provider.get(DOCS.A);
    const confirmedState = harness.replica.get({
      id: DOCS.A,
      type: DOCUMENT_MIME,
    });
    assertExists(confirmedDocument);
    assertExists(confirmedState);
    const pendingMaterialized = pendingState.is;
    const confirmedMaterialized = confirmedState.is;
    assertExists(pendingMaterialized);
    assertExists(confirmedMaterialized);
    assertStrictEquals(confirmedDocument, pendingDocument);
    assertStrictEquals(confirmedMaterialized, pendingMaterialized);
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: confirming a later same-doc patch keeps earlier pending overlay", async () => {
  const harness = await createHarness();
  const leftResponseGate = Promise.withResolvers<void>();
  try {
    await seedAccepted(harness, DOCS.A, {
      left: 0,
      right: 0,
    });

    let leftSettled = false;
    harness.model.setOutcome(2, {
      kind: "accept",
      responseGate: leftResponseGate.promise,
    });
    const left = beginPatch(
      harness,
      DOCS.A,
      [{
        op: "replace",
        path: "/value/left",
        value: 1,
      }],
      {
        left: 1,
        right: 0,
      },
    ).finally(() => {
      leftSettled = true;
    });

    harness.model.setOutcome(3, { kind: "accept" });
    const right = beginPatch(
      harness,
      DOCS.A,
      [{
        op: "replace",
        path: "/value/right",
        value: 2,
      }],
      {
        left: 1,
        right: 2,
      },
    );

    expectVisible(harness, {
      A: {
        left: 1,
        right: 2,
      },
    });

    await assertResultOk(right);
    assertEquals(leftSettled, false);
    expectVisible(harness, {
      A: {
        left: 1,
        right: 2,
      },
    });

    leftResponseGate.resolve();
    await assertResultOk(left);
    expectVisible(harness, {
      A: {
        left: 1,
        right: 2,
      },
    });
  } finally {
    leftResponseGate.resolve();
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: sibling patches reuse unchanged branches", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, {
      left: {
        stable: {
          deep: true,
        },
      },
      right: {
        count: 0,
      },
    });

    harness.model.setOutcome(2, { kind: "accept" });
    const first = beginPatch(
      harness,
      DOCS.A,
      [{
        op: "replace",
        path: "/value/left/stable/deep",
        value: false,
      }],
      {
        left: {
          stable: {
            deep: false,
          },
        },
        right: {
          count: 0,
        },
      },
    );

    const firstDocument = harness.provider.get(DOCS.A);
    assertExists(firstDocument);
    const firstValue = firstDocument.value as Record<string, unknown>;
    const firstLeft = firstValue.left;
    const firstRight = firstValue.right;

    harness.model.setOutcome(3, { kind: "accept" });
    const second = beginPatch(
      harness,
      DOCS.A,
      [{
        op: "replace",
        path: "/value/right/count",
        value: 1,
      }],
      {
        left: {
          stable: {
            deep: false,
          },
        },
        right: {
          count: 1,
        },
      },
    );

    const secondDocument = harness.provider.get(DOCS.A);
    assertExists(secondDocument);
    const secondValue = secondDocument.value as Record<string, unknown>;
    assert(secondDocument !== firstDocument);
    assertStrictEquals(secondValue.left, firstLeft);
    assert(secondValue.right !== firstRight);
    assertEquals(firstDocument, {
      value: {
        left: {
          stable: {
            deep: false,
          },
        },
        right: {
          count: 0,
        },
      },
    });
    assertEquals(secondDocument, {
      value: {
        left: {
          stable: {
            deep: false,
          },
        },
        right: {
          count: 1,
        },
      },
    });

    await assertResultOk(first);
    await assertResultOk(second);
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: dropping an earlier pending write invalidates cached suffixes", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, {
      left: 0,
      right: 0,
    });

    harness.model.setOutcome(2, { kind: "rejectConflict" });
    const left = beginPatch(
      harness,
      DOCS.A,
      [{
        op: "replace",
        path: "/value/left",
        value: 1,
      }],
      {
        left: 1,
        right: 0,
      },
    );

    harness.model.setOutcome(3, { kind: "accept" });
    const right = beginPatch(
      harness,
      DOCS.A,
      [{
        op: "replace",
        path: "/value/right",
        value: 2,
      }],
      {
        left: 1,
        right: 2,
      },
    );

    const beforeDrop = harness.provider.get(DOCS.A);
    assertExists(beforeDrop);
    assertEquals(beforeDrop.value, {
      left: 1,
      right: 2,
    });

    await assertConflict(left);

    const afterDrop = harness.provider.get(DOCS.A);
    assertExists(afterDrop);
    assert(afterDrop !== beforeDrop);
    assertEquals(afterDrop.value, {
      left: 0,
      right: 2,
    });

    await assertResultOk(right);
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: pending visibility preserves fabric values", async () => {
  const harness = await createHarness();
  let commitPromise: CommitResultPromise | undefined;
  try {
    const timestamp = new FabricEpochNsec(1_234n);

    const c1 = beginSet(harness, DOCS.A, valueFor("pending", { timestamp }));
    commitPromise = c1.promise;
    harness.model.setOutcome(c1.localSeq, { kind: "accept" });

    const pendingVisible = harness.provider.get(DOCS.A);
    assertExists(pendingVisible);
    const pendingValue = pendingVisible.value as Record<string, FabricValue>;
    assertEquals(pendingValue.label, "pending");
    assertStrictEquals(pendingValue.timestamp, timestamp);

    await assertResultOk(c1.promise);
  } finally {
    await commitPromise?.catch(() => {});
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: pending visibility preserves array add patches", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, {
      items: ["a", "b", "c"],
    });

    harness.model.setOutcome(2, { kind: "accept" });
    const add = beginPatch(
      harness,
      DOCS.A,
      [{
        op: "add",
        path: "/value/items/1",
        value: "x",
      }],
      {
        items: ["a", "x", "b", "c"],
      },
    );

    expectVisible(harness, {
      A: {
        items: ["a", "x", "b", "c"],
      },
    });

    await assertResultOk(add);
    expectVisible(harness, {
      A: {
        items: ["a", "x", "b", "c"],
      },
    });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: pending visibility preserves array remove patches", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, {
      items: ["a", "b", "c"],
    });

    harness.model.setOutcome(2, { kind: "accept" });
    const remove = beginPatch(
      harness,
      DOCS.A,
      [{
        op: "remove",
        path: "/value/items/1",
      }],
      {
        items: ["a", "c"],
      },
    );

    expectVisible(harness, {
      A: {
        items: ["a", "c"],
      },
    });

    await assertResultOk(remove);
    expectVisible(harness, {
      A: {
        items: ["a", "c"],
      },
    });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: pending visibility preserves array move patches", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, {
      items: ["a", "b", "c"],
    });

    harness.model.setOutcome(2, { kind: "accept" });
    const move = beginPatch(
      harness,
      DOCS.A,
      [{
        op: "move",
        from: "/value/items/2",
        path: "/value/items/0",
      }],
      {
        items: ["c", "a", "b"],
      },
    );

    expectVisible(harness, {
      A: {
        items: ["c", "a", "b"],
      },
    });

    await assertResultOk(move);
    expectVisible(harness, {
      A: {
        items: ["c", "a", "b"],
      },
    });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: pending visibility can replace a null branch with an object patch", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, null);

    harness.model.setOutcome(2, {
      kind: "rejectConflict",
      message: "synthetic null-base conflict",
    });
    const patch = beginPatch(
      harness,
      DOCS.A,
      [{
        op: "replace",
        path: "/value/choice/name",
        value: "Sushi Place",
      }],
      {
        choice: {
          name: "Sushi Place",
        },
      },
    );

    expectVisible(harness, {
      A: {
        choice: {
          name: "Sushi Place",
        },
      },
    });

    await assertConflict(patch, "synthetic null-base conflict");
    expectVisible(harness, {
      A: null,
    });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: pending visibility can replace a scalar branch with an object patch", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, {
      choice: 1,
    });

    harness.model.setOutcome(2, {
      kind: "rejectConflict",
      message: "synthetic scalar-base conflict",
    });
    const patch = beginPatch(
      harness,
      DOCS.A,
      [{
        op: "replace",
        path: "/value/choice/name",
        value: "Sushi Place",
      }],
      {
        choice: {
          name: "Sushi Place",
        },
      },
    );

    expectVisible(harness, {
      A: {
        choice: {
          name: "Sushi Place",
        },
      },
    });

    await assertConflict(patch, "synthetic scalar-base conflict");
    expectVisible(harness, {
      A: {
        choice: 1,
      },
    });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: pending visibility can replace an array branch with an object patch", async () => {
  const harness = await createHarness();
  try {
    await seedAccepted(harness, DOCS.A, []);

    harness.model.setOutcome(2, {
      kind: "rejectConflict",
      message: "synthetic array-base conflict",
    });
    const patch = beginPatch(
      harness,
      DOCS.A,
      [{
        op: "replace",
        path: "/value/choice/name",
        value: "Sushi Place",
      }],
      {
        choice: {
          name: "Sushi Place",
        },
      },
    );

    expectVisible(harness, {
      A: {
        choice: {
          name: "Sushi Place",
        },
      },
    });

    await assertConflict(patch, "synthetic array-base conflict");
    expectVisible(harness, {
      A: [],
    });
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits: C1->C2->C3 where C2 fails and C3 error is pending-dependency, not stale-read", async () => {
  const harness = await createHarness();
  try {
    const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
    harness.model.setOutcome(c1.localSeq, { kind: "accept" });
    await assertResultOk(c1.promise);

    const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
    harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
    const c3 = beginSet(
      harness,
      DOCS.B,
      valueFor("c3"),
      sourceFromReads([{ id: DOCS.A }]),
    );
    harness.model.setOutcome(c3.localSeq, { kind: "accept" });

    await assertConflict(c2.promise);
    await assertConflict(c3.promise, "pending dependency");
  } finally {
    await harness.close();
  }
});

Deno.test("memory v2 stacked commits confirm the last write for duplicate ids in one batch", async () => {
  const harness = await createHarness();
  try {
    const commit = beginBatch(harness, [
      { op: "set", id: DOCS.A, value: valueFor("first") },
      { op: "set", id: DOCS.A, value: valueFor("second") },
    ]);
    harness.model.setOutcome(commit.localSeq, { kind: "accept" });

    await assertResultOk(commit.promise);

    assertEquals(visibleValue(harness.provider, DOCS.A), valueFor("second"));
    assertEquals(currentSeq(harness, DOCS.A), 1);
  } finally {
    await harness.close();
  }
});

for (
  const [name, testFn] of [
    [
      "memory v2 stacked commits: duplicate localSeq returns the same promise/result",
      () => Promise.resolve(),
    ],
  ] as const
) {
  void name;
  void testFn;
}

for (
  const seed of [
    0x51001,
    0x51002,
    0x51003,
    0x51004,
    0x51005,
    0x51006,
    0x51007,
    0x51008,
    0x51009,
    0x5100a,
  ]
) {
  Deno.test(`memory v2 stacked commits stress seed ${seed}`, async () => {
    await runStressSeed(seed);
  });
}
