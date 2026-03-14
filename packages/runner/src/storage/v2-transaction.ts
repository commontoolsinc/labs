import { unclaimed } from "@commontools/memory/fact";
import { deepFreeze } from "@commontools/memory/deep-freeze";
import {
  getExperimentalStorableConfig,
  isArrayIndexPropertyName,
} from "@commontools/memory/storable-value";
import type { StorableDatum } from "@commontools/memory/interface";
import { deepEqual } from "@commontools/utils/deep-equal";
import { isRecord } from "@commontools/utils/types";
import type {
  Activity,
  ChangeGroup,
  CommitError,
  IAttestation,
  IMemoryAddress,
  IMemorySpaceAddress,
  InactiveTransactionError,
  IReadActivity,
  IReadOptions,
  IStorageManager,
  IStorageTransaction,
  IStorageTransactionInconsistent,
  ITransactionJournal,
  ITransactionReader,
  ITransactionWriter,
  ITransactionWriteRequest,
  MediaType,
  MemorySpace,
  NativeStorageCommit,
  NativeStorageCommitOperation,
  ReaderError,
  ReadError,
  Result,
  StorageTransactionFailed,
  StorageTransactionRejected,
  StorageTransactionStatus,
  TransactionWriteDetail,
  Unit,
  URI,
  WriteError,
  WriterError,
} from "./interface.ts";
import {
  claim,
  load as loadInline,
  read as readAttestation,
  write as writeAttestation,
} from "./transaction/attestation.ts";
import { ReadOnlyAddressError } from "./transaction/chronicle.ts";
import {
  TransactionAborted,
  TransactionCompleteError,
  WriteIsolationError,
} from "./transaction.ts";
import { reactivityLogFromActivities } from "./reactivity-log.ts";

type RootAttestation = IAttestation;

type DocumentEntry = {
  initial: RootAttestation;
  current: RootAttestation;
  seq?: number;
  writeDetails: Map<string, TransactionWriteDetail>;
};

type SpaceBranch = {
  replica: ReturnType<IStorageManager["open"]>["replica"];
  docs: Map<string, DocumentEntry>;
  validations: Map<string, RootAttestation>;
  reader?: ITransactionReader;
  writer?: ITransactionWriter;
};

type ReadyState = {
  status: "ready";
};

type PendingState = {
  status: "pending";
  promise: Promise<Result<Unit, StorageTransactionRejected>>;
};

type DoneState = {
  status: "done";
  result: Result<Unit, StorageTransactionFailed>;
};

type TxState = ReadyState | DoneState | PendingState;

const isolateTransactionValue = <T>(
  value: T,
  seen: Map<object, unknown> = new Map(),
): T => {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return seen.get(value) as T;
  }

  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    seen.set(value, copy);
    for (let i = 0; i < value.length; i++) {
      if (i in value) {
        copy[i] = isolateTransactionValue(value[i], seen);
      }
    }
    return copy as T;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }

  const copy = Object.create(prototype) as Record<PropertyKey, unknown>;
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    copy[key] = isolateTransactionValue(
      (value as Record<PropertyKey, unknown>)[key],
      seen,
    );
  }
  return copy as T;
};

const createMissingContainer = (
  nextKey: string,
): StorableDatum => isArrayIndexPropertyName(nextKey) ? [] : {};

const ensureParentContainers = (
  root: StorableDatum,
  path: readonly string[],
  lastKey: string,
): StorableDatum => {
  if (path.length === 0) {
    return root;
  }

  let current = root as Record<string, StorableDatum> | StorableDatum[];
  for (let index = 0; index < path.length; index += 1) {
    const key = path[index]!;
    const nextKey = path[index + 1] ?? lastKey;
    const container = createMissingContainer(nextKey);

    if (Array.isArray(current)) {
      const slot = Number(key);
      const existing = current[slot];
      if (!isRecord(existing) && !Array.isArray(existing)) {
        current[slot] = container;
      }
      current = current[slot] as
        | Record<string, StorableDatum>
        | StorableDatum[];
      continue;
    }

    const existing = current[key];
    if (!isRecord(existing) && !Array.isArray(existing)) {
      current[key] = container;
    }
    current = current[key] as Record<string, StorableDatum> | StorableDatum[];
  }

  return root;
};

const freezeReadValue = <T extends StorableDatum | undefined>(value: T): T => {
  if (
    value === undefined || value === null ||
    typeof value !== "object"
  ) {
    return value;
  }
  return deepFreeze(isolateTransactionValue(value)) as T;
};

class V2TransactionJournal implements ITransactionJournal {
  constructor(private readonly tx: V2StorageTransaction) {}

  activity(): Iterable<Activity> {
    return this.tx.activity();
  }

  novelty(space: MemorySpace): Iterable<IAttestation> {
    return (function* (tx: V2StorageTransaction) {
      for (const detail of tx.getWriteDetails(space) ?? []) {
        yield {
          address: {
            id: detail.address.id,
            type: detail.address.type,
            path: detail.address.path,
          },
          value: detail.value,
        };
      }
    })(this.tx);
  }

  history(space: MemorySpace): Iterable<IAttestation> {
    return (function* (tx: V2StorageTransaction) {
      for (const detail of tx.getWriteDetails(space) ?? []) {
        yield {
          address: {
            id: detail.address.id,
            type: detail.address.type,
            path: detail.address.path,
          },
          value: detail.previousValue,
        };
      }
    })(this.tx);
  }
}

class V2Reader implements ITransactionReader {
  constructor(
    protected readonly tx: V2StorageTransaction,
    private readonly space: MemorySpace,
  ) {}

  did(): MemorySpace {
    return this.space;
  }

  read(
    address: IMemoryAddress,
    options?: IReadOptions,
  ): Result<IAttestation, ReadError> {
    return this.tx.read({ ...address, space: this.space }, options);
  }
}

class V2Writer extends V2Reader implements ITransactionWriter {
  write(
    address: IMemoryAddress,
    value?: StorableDatum,
  ): Result<IAttestation, WriteError> {
    return this.tx.writeWithinSpace(this.did(), address, value);
  }
}

export class V2StorageTransaction implements IStorageTransaction {
  changeGroup?: ChangeGroup;
  immediate?: boolean;

  readonly journal = new V2TransactionJournal(this);

  #state: TxState = { status: "ready" };
  #branches = new Map<MemorySpace, SpaceBranch>();
  #activity: Activity[] = [];
  #readActivities: IReadActivity[] = [];
  #writeSpace?: MemorySpace;

  constructor(private readonly storage: IStorageManager) {}

  static create(manager: IStorageManager): IStorageTransaction {
    return new this(manager);
  }

  activity(): Iterable<Activity> {
    return this.#activity;
  }

  status(): StorageTransactionStatus {
    if (this.#state.status === "done") {
      if (this.#state.result.error) {
        return {
          status: "error",
          journal: this.journal,
          error: this.#state.result.error,
        };
      }
      return { status: "done", journal: this.journal };
    }
    if (this.#state.status === "pending") {
      return { status: "pending", journal: this.journal };
    }
    return { status: "ready", journal: this.journal };
  }

  getReadActivities() {
    return this.#readActivities;
  }

  getReactivityLog() {
    return reactivityLogFromActivities(this.#activity);
  }

  getNativeCommit(space: MemorySpace): NativeStorageCommit | undefined {
    const branch = this.#branches.get(space);
    if (!branch) {
      return undefined;
    }

    const operations: NativeStorageCommitOperation[] = [];
    for (const [key, doc] of branch.docs.entries()) {
      if (doc.writeDetails.size === 0) {
        continue;
      }
      if (deepEqual(doc.current.value, doc.initial.value)) {
        continue;
      }

      const { id, type } = this.parseDocKey(key);
      operations.push({
        id,
        type,
        ...(doc.current.value === undefined
          ? {}
          : { value: doc.current.value }),
      });
    }

    return { operations };
  }

  *getWriteDetails(space: MemorySpace): Iterable<TransactionWriteDetail> {
    const branch = this.#branches.get(space);
    if (!branch) {
      return;
    }
    for (const entry of branch.docs.values()) {
      yield* entry.writeDetails.values();
    }
  }

  reader(space: MemorySpace): Result<ITransactionReader, ReaderError> {
    const ready = this.editable();
    if (ready.error) {
      return { error: ready.error };
    }
    const branch = this.branch(space);
    branch.reader ??= new V2Reader(this, space);
    return { ok: branch.reader };
  }

  writer(space: MemorySpace): Result<ITransactionWriter, WriterError> {
    const ready = this.editable();
    if (ready.error) {
      return { error: ready.error };
    }
    if (this.#writeSpace !== undefined && this.#writeSpace !== space) {
      return {
        error: WriteIsolationError({
          open: this.#writeSpace,
          requested: space,
        }),
      };
    }
    this.#writeSpace = space;
    const branch = this.branch(space);
    branch.writer ??= new V2Writer(this, space);
    return { ok: branch.writer };
  }

  read(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): Result<IAttestation, ReadError> {
    const ready = this.editable();
    if (ready.error) {
      return { error: ready.error };
    }

    const branch = this.branch(address.space);
    const { doc, meta } = this.document(branch, address);
    const readMeta = {
      ...(options?.meta ?? {}),
      ...(typeof meta.seq === "number" ? { seq: meta.seq } : {}),
    };

    this.#activity.push({
      read: {
        space: address.space,
        id: address.id,
        type: address.type,
        path: address.path,
        meta: readMeta,
        ...(options?.nonRecursive === true ? { nonRecursive: true } : {}),
      },
    });
    this.#readActivities.push({
      space: address.space,
      id: address.id,
      type: address.type,
      path: address.path,
      meta: readMeta,
      ...(options?.nonRecursive === true ? { nonRecursive: true } : {}),
    });

    if (options?.trackReadWithoutLoad === true) {
      return { ok: { address, value: undefined } };
    }

    const { space: _, ...memoryAddress } = address;
    const result = readAttestation(doc.current, memoryAddress);
    if (
      !address.id.startsWith("data:") &&
      !branch.validations.has(this.docKey(address))
    ) {
      branch.validations.set(this.docKey(address), doc.initial);
    }
    if (result.error) {
      return { error: result.error.from(address.space) };
    }
    if (!getExperimentalStorableConfig().richStorableValues) {
      return result;
    }

    return {
      ok: {
        ...result.ok,
        value: freezeReadValue(result.ok.value),
      },
    };
  }

  write(
    address: IMemorySpaceAddress,
    value?: StorableDatum,
  ): Result<IAttestation, WriterError | WriteError> {
    const { error } = this.writer(address.space);
    if (error) {
      return { error };
    }
    return this.writeWithinSpace(address.space, address, value);
  }

  writeBatch(
    writes: Iterable<ITransactionWriteRequest>,
  ): Result<Unit, WriterError | WriteError> {
    for (const { address, value } of writes) {
      const { error } = this.writer(address.space);
      if (error) {
        return { error };
      }
      const result = this.writeWithinSpaceCreatingParents(
        address.space,
        address,
        value,
      );
      if (result.error) {
        return { error: result.error };
      }
    }
    return { ok: {} };
  }

  writeWithinSpace(
    space: MemorySpace,
    address: IMemoryAddress,
    value?: StorableDatum,
  ): Result<IAttestation, WriteError> {
    if (address.id.startsWith("data:")) {
      return { error: ReadOnlyAddressError(address).from(space) };
    }

    const branch = this.branch(space);
    const { doc } = this.document(branch, address);
    const current = doc.current;
    const previous = readAttestation(doc.current, address);
    if (previous.ok && deepEqual(previous.ok.value, value)) {
      return { ok: current };
    }
    const isolatedValue = value === undefined
      ? undefined
      : isolateTransactionValue(value) as StorableDatum;
    const result = writeAttestation(current, address, isolatedValue);
    if (result.error) {
      return { error: result.error.from(space) };
    }

    const next = result.ok as RootAttestation;
    if (next === current) {
      return { ok: next };
    }

    doc.current = next;
    this.#activity.push({
      write: {
        space,
        id: address.id,
        type: address.type,
        path: address.path,
      },
    });

    const key = JSON.stringify(address.path);
    const existing = doc.writeDetails.get(key);
    doc.writeDetails.set(key, {
      address: { ...address, space },
      value: isolatedValue,
      previousValue: existing?.previousValue ?? previous.ok?.value,
    });

    return { ok: next };
  }

  private writeWithinSpaceCreatingParents(
    space: MemorySpace,
    address: IMemoryAddress,
    value?: StorableDatum,
  ): Result<IAttestation, WriteError> {
    const direct = this.writeWithinSpace(space, address, value);
    if (direct.ok || direct.error?.name !== "NotFoundError") {
      return direct;
    }

    if (value === undefined) {
      return { ok: this.document(this.branch(space), address).doc.current };
    }

    const branch = this.branch(space);
    const { doc } = this.document(branch, address);
    const errorPath = direct.error.path;
    const lastExistingPath = errorPath.slice(0, -1);
    const remainingPath = address.path.slice(lastExistingPath.length);
    if (remainingPath.length === 0) {
      return direct;
    }

    let parentValue: StorableDatum;
    if (lastExistingPath.length === 0) {
      parentValue = {};
    } else {
      const parentRead = readAttestation(doc.current, {
        ...address,
        path: lastExistingPath,
      });
      if (parentRead.error) {
        return { error: parentRead.error.from(space) };
      }
      const existingParent = parentRead.ok.value;
      if (!isRecord(existingParent) && !Array.isArray(existingParent)) {
        return direct;
      }
      parentValue = isolateTransactionValue(existingParent) as StorableDatum;
    }

    const seededParent = ensureParentContainers(
      parentValue,
      remainingPath.slice(0, -1),
      remainingPath[remainingPath.length - 1]!,
    );
    const isolatedValue = isolateTransactionValue(value) as StorableDatum;
    const parentWrite = writeAttestation(
      {
        address: {
          id: address.id,
          type: address.type,
          path: lastExistingPath,
        },
        value: seededParent,
      },
      address,
      isolatedValue,
    );
    if (parentWrite.error) {
      return { error: parentWrite.error.from(space) };
    }

    const rootWrite = writeAttestation(doc.current, {
      ...address,
      path: lastExistingPath,
    }, parentWrite.ok.value);
    if (rootWrite.error) {
      return { error: rootWrite.error.from(space) };
    }

    const next = rootWrite.ok as RootAttestation;
    if (next === doc.current) {
      return { ok: next };
    }

    doc.current = next;
    this.#activity.push({
      write: {
        space,
        id: address.id,
        type: address.type,
        path: address.path,
      },
    });

    const key = JSON.stringify(address.path);
    const existing = doc.writeDetails.get(key);
    doc.writeDetails.set(key, {
      address: { ...address, space },
      value: isolatedValue,
      previousValue: existing?.previousValue,
    });

    return { ok: next };
  }
  abort(reason?: unknown): Result<Unit, InactiveTransactionError> {
    const ready = this.editable();
    if (ready.error) {
      return { error: ready.error };
    }
    this.#state = {
      status: "done",
      result: { error: TransactionAborted(reason) },
    };
    return { ok: {} };
  }

  async commit(): Promise<Result<Unit, CommitError>> {
    const ready = this.editable();
    if (ready.error) {
      return { error: ready.error };
    }

    const validation = this.validate();
    if (validation.error) {
      this.#state = {
        status: "done",
        result: { error: validation.error },
      };
      return { error: validation.error };
    }

    const writeSpace = this.#writeSpace;
    if (!writeSpace) {
      const result = { ok: {} } satisfies Result<Unit, CommitError>;
      this.#state = { status: "done", result };
      return result;
    }

    const replica = this.storage.open(writeSpace).replica;
    const native = this.getNativeCommit(writeSpace);
    const operations = native?.operations ?? [];
    if (operations.length === 0) {
      const result = { ok: {} } satisfies Result<Unit, CommitError>;
      this.#state = { status: "done", result };
      return result;
    }

    const promise = replica.commitNative
      ? replica.commitNative(native!, this)
      : replica.commit(this.buildTransaction(writeSpace), this);
    this.#state = { status: "pending", promise };
    const result = await promise;
    this.#state = { status: "done", result };
    return result;
  }

  private editable(): Result<Unit, InactiveTransactionError> {
    if (this.#state.status === "ready") {
      return { ok: {} };
    }
    return {
      error: this.#state.status === "done" && this.#state.result.error
        ? this.#state.result.error
        : TransactionCompleteError(),
    };
  }

  private branch(space: MemorySpace): SpaceBranch {
    let branch = this.#branches.get(space);
    if (!branch) {
      branch = {
        replica: this.storage.open(space).replica,
        docs: new Map(),
        validations: new Map(),
      };
      this.#branches.set(space, branch);
    }
    return branch;
  }

  private document(
    branch: SpaceBranch,
    address: Pick<IMemoryAddress, "id" | "type">,
  ): { doc: DocumentEntry; meta: { seq?: number } } {
    const key = this.docKey(address);
    let doc = branch.docs.get(key);
    if (!doc) {
      const loaded = this.loadRoot(branch, address);
      const seq = this.readSeq(branch, address);
      doc = {
        initial: loaded,
        current: loaded,
        seq,
        writeDetails: new Map(),
      };
      branch.docs.set(key, doc);
    }
    return {
      doc,
      meta: { ...(typeof doc.seq === "number" ? { seq: doc.seq } : {}) },
    };
  }

  private loadRoot(
    branch: SpaceBranch,
    address: Pick<IMemoryAddress, "id" | "type">,
  ): RootAttestation {
    if (address.id.startsWith("data:")) {
      const loaded = loadInline({ id: address.id, type: address.type });
      if (loaded.error) {
        throw loaded.error;
      }
      return loaded.ok as RootAttestation;
    }

    const state = branch.replica.get({
      id: address.id,
      type: address.type,
    }) ?? unclaimed({
      of: address.id,
      the: address.type,
    });

    return {
      address: { id: address.id, type: address.type, path: [] },
      value: state.is,
    };
  }

  private readSeq(
    branch: SpaceBranch,
    address: Pick<IMemoryAddress, "id" | "type">,
  ): number | undefined {
    if (address.id.startsWith("data:")) {
      return undefined;
    }
    const state = branch.replica.get({
      id: address.id,
      type: address.type,
    }) as { since?: number } | undefined;
    return typeof state?.since === "number" ? state.since : undefined;
  }

  private validate(): Result<Unit, IStorageTransactionInconsistent> {
    for (const branch of this.#branches.values()) {
      for (const invariant of branch.validations.values()) {
        const result = claim(invariant, branch.replica);
        if (result.error) {
          return { error: result.error };
        }
      }
    }
    return { ok: {} };
  }

  private buildTransaction(
    space: MemorySpace,
  ): { facts: any[]; claims: any[] } {
    const branch = this.#branches.get(space);
    if (!branch) {
      return { facts: [], claims: [] };
    }

    const facts: any[] = [];
    for (const [key, doc] of branch.docs.entries()) {
      if (doc.writeDetails.size === 0) {
        continue;
      }
      if (deepEqual(doc.current.value, doc.initial.value)) {
        continue;
      }
      const { id, type } = this.parseDocKey(key);
      if (doc.current.value === undefined) {
        facts.push({ the: type, of: id });
      } else {
        facts.push({ the: type, of: id, is: doc.current.value });
      }
    }
    return { facts, claims: [] };
  }

  private docKey(address: Pick<IMemoryAddress, "id" | "type">): string {
    return `${address.id}|${address.type}`;
  }

  private parseDocKey(key: string): { id: URI; type: MediaType } {
    const [id, type] = key.split("|");
    return { id: id as URI, type: type as MediaType };
  }
}
