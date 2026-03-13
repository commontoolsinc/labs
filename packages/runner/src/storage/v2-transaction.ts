import { unclaimed } from "@commontools/memory/fact";
import type { StorableDatum } from "@commontools/memory/interface";
import { deepEqual } from "@commontools/utils/deep-equal";
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
  MemorySpace,
  ReaderError,
  ReadError,
  Result,
  StorageTransactionFailed,
  StorageTransactionRejected,
  StorageTransactionStatus,
  TransactionWriteDetail,
  Unit,
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
    return result;
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
    const previous = readAttestation(doc.current, address);
    const result = writeAttestation(doc.current, address, value);
    if (result.error) {
      return { error: result.error.from(space) };
    }

    doc.current = result.ok as RootAttestation;
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
      value,
      previousValue: existing?.previousValue ?? previous.ok?.value,
    });

    return result;
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

    const transaction = this.buildTransaction(writeSpace);
    if (transaction.facts.length === 0) {
      const result = { ok: {} } satisfies Result<Unit, CommitError>;
      this.#state = { status: "done", result };
      return result;
    }

    const replica = this.storage.open(writeSpace).replica;
    const promise = replica.commit(transaction, this);
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

  private parseDocKey(key: string): { id: string; type: string } {
    const [id, type] = key.split("|");
    return { id, type };
  }
}
