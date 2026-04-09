import {
  assert,
  assertEquals,
  assertExists,
  assertStrictEquals,
} from "@std/assert";
import {
  resetDataModelConfig,
  setDataModelConfig,
} from "@commonfabric/data-model/fabric-value";
import {
  jsonFromValue,
  resetJsonEncodingConfig,
  setJsonEncodingConfig,
  valueFromJson,
} from "@commonfabric/data-model/json-encoding";
import { FabricEpochNsec } from "@commonfabric/data-model/fabric-epoch";
import { Identity } from "@commonfabric/identity";
import type { FabricValue, MIME, URI } from "@commonfabric/memory/interface";
import {
  type EntityDocument,
  getMemoryV2Flags,
  type PatchOp,
} from "@commonfabric/memory/v2";
import type { ReconstructionContext } from "@commonfabric/data-model/interface";
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
  SingleSessionFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-stacked-commit");
const space = signer.did();
const DOCUMENT_MIME = "application/json" as const;
const helloOk = () => ({
  type: "hello.ok",
  protocol: "memory/v2",
  flags: getMemoryV2Flags(),
} as const);
const testReconstructionContext: ReconstructionContext = {
  getCell() {
    throw new Error("getCell is not available in stacked commit transport");
  },
};
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

type RootValue = Record<string, FabricValue> | undefined;
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
type RejectedRecord = {
  localSeq: number;
  commit: ClientCommit;
  error: { name: string; message: string };
};
type ScriptedOutcome =
  | { kind: "accept"; remoteInterleave?: RemoteCommit }
  | {
    kind: "rejectConflict";
    message?: string;
    remoteInterleave?: RemoteCommit;
  }
  | { kind: "dropThenReplayAccept"; remoteInterleave?: RemoteCommit }
  | {
    kind: "dropThenReplayReject";
    message?: string;
    remoteInterleave?: RemoteCommit;
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
    error: { name: string; message: string };
  } | { type: "drop" } {
    this.transactLocalSeqs.push(commit.localSeq);

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

    const readError = this.validateReads(commit);
    if (readError) {
      return this.reject(commit, readError);
    }

    const shouldDrop = scripted.kind === "dropThenReplayAccept" ||
      scripted.kind === "dropThenReplayReject";
    const shouldReject = scripted.kind === "rejectConflict" ||
      scripted.kind === "dropThenReplayReject";

    if (shouldReject) {
      const rejected = this.reject(commit, {
        name: "ConflictError",
        message: scripted.message ?? "synthetic conflict",
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
  ): { name: string; message: string } | null {
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
    error: { name: string; message: string },
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
    const revisions = commit.operations.map((operation, index) => ({
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

class ScriptedModelTransport implements MemoryV2Client.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};

  constructor(readonly model: ScriptedServerModel) {}

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = valueFromJson(
      payload,
      testReconstructionContext,
    ) as {
      type: string;
      requestId?: string;
      session?: { sessionId?: string };
      commit?: ClientCommit;
    };

    switch (message.type) {
      case "hello":
        this.model.connectionCount += 1;
        this.respond(helloOk());
        break;
      case "session.open":
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: message.session?.sessionId ?? this.model.sessionId,
            serverSeq: this.model.serverSeq,
          },
        });
        break;
      case "session.watch.set":
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
      case "session.ack":
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: this.model.serverSeq,
          },
        });
        break;
      case "transact": {
        setTimeout(() => {
          const commit = message.commit!;
          const response = this.model.transact(commit);
          if (response.type === "drop") {
            this.#closeReceiver(new Error("disconnect"));
            return;
          }
          this.respond({
            type: "response",
            requestId: message.requestId!,
            ...(response.type === "accept"
              ? { ok: response.applied }
              : { error: response.error }),
          });
        }, 0);
        break;
      }
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
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

type Harness = ReturnType<typeof createHarness>;

const createHarness = () => {
  const model = new ScriptedServerModel();
  const transport = new ScriptedModelTransport(model);
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    address: new URL(`memory://runner-v2-stacked-${crypto.randomUUID()}`),
    memoryVersion: "v2",
  }, sessionFactory);
  const notifications = new NotificationRecorder();
  const provider = storageManager.open(space) as TestProvider;
  storageManager.subscribe(notifications);

  const replica = provider.replica as unknown as {
    commitNative(
      transaction: {
        operations: Array<
          | { op: "set"; id: URI; type: MIME; value: unknown }
          | {
            op: "patch";
            id: URI;
            type: MIME;
            patches: PatchOp[];
            value: unknown;
          }
          | { op: "delete"; id: URI; type: MIME }
        >;
      },
      source?: unknown,
    ): Promise<
      { ok: Record<PropertyKey, never>; error?: undefined } | {
        ok?: undefined;
        error: { name?: string; message?: string };
      }
    >;
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
  };

  let nextLocalSeq = 1;
  const dispatch = (
    operations: RootOp[],
    source?: unknown,
  ): { localSeq: number; promise: Promise<any> } => {
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
  if (operation.op !== "patch") {
    return [{ id: operation.id as URI, paths: [[]] }];
  }
  const paths = operation.patches.flatMap((patch) => {
    switch (patch.op) {
      case "replace":
      case "splice":
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

const assertResultOk = async (promise: Promise<any>) => {
  assertEquals(await promise, { ok: {} });
};

const assertConflict = async (
  promise: Promise<any>,
  contains?: string,
) => {
  const result = await promise;
  assertExists(result.error);
  assertEquals(result.error.name, "ConflictError");
  if (contains) {
    assert(String(result.error.message).includes(contains));
  }
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
    promise: Promise<any>;
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

    const replica = harness.replica as unknown as {
      commitNative(
        transaction: {
          operations: Array<
            {
              op: "patch";
              id: URI;
              type: MIME;
              patches: PatchOp[];
              value: { value: RootValue };
            }
          >;
        },
      ): Promise<any>;
    };

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
    const session = await client.mount(space);
    model.setOutcome(1, { kind: "accept" });
    const commit: ClientCommit = {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: DOCS.A,
        value: { value: valueFor("dup") as any } as any,
      }],
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

Deno.test("memory v2 stacked commits: pending visibility preserves rich fabric values", async () => {
  setDataModelConfig(true);
  setJsonEncodingConfig(true);
  const harness = await createHarness();
  let commitPromise: Promise<any> | undefined;
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
    resetDataModelConfig();
    resetJsonEncodingConfig();
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
