import { unclaimed } from "@commontools/memory/fact";
import { deepFreeze } from "@commontools/memory/deep-freeze";
import type { PatchOp } from "@commontools/memory/v2";
import {
  getExperimentalStorableConfig,
  isArrayIndexPropertyName,
} from "@commontools/memory/storable-value";
import type { JSONValue, StorableDatum } from "@commontools/memory/interface";
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
  ITypeMismatchError,
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
  TransactionReactivityLog,
  TransactionWriteDetail,
  Unit,
  URI,
  WriteError,
  WriterError,
} from "./interface.ts";
import {
  claim,
  load as loadInline,
  NotFound,
  read as readAttestation,
  TypeMismatchError,
  write as writeAttestation,
} from "./transaction/attestation.ts";
import { ReadOnlyAddressError } from "./transaction/chronicle.ts";
import {
  TransactionAborted,
  TransactionCompleteError,
  WriteIsolationError,
} from "./transaction.ts";
import {
  isMutableTransactionReadAllowed,
  isReadIgnoredForScheduling,
  isReadMarkedAsPotentialWrite,
} from "./reactivity-log.ts";

type RootAttestation = IAttestation;

type DocumentEntry = {
  initial: RootAttestation;
  current: RootAttestation;
  seq?: number;
  validated: boolean;
  frozenReads: Map<string, StorableDatum | undefined>;
  writeDetails: Map<string, TransactionWriteDetail>;
};

type SpaceBranch = {
  replica: ReturnType<IStorageManager["open"]>["replica"];
  docs: Map<string, DocumentEntry>;
  reader?: ITransactionReader;
  writer?: ITransactionWriter;
};

type ActivityOrderEntry = number;

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

const sparseArrayCopy = <T>(array: T[]): T[] => {
  const copy = new Array<T>(array.length);
  array.forEach((value, index) => {
    copy[index] = value;
  });
  return copy;
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

const EMPTY_META = Object.freeze({});

const isPrefixPath = (
  prefix: readonly string[],
  path: readonly string[],
): boolean => {
  if (prefix.length > path.length) {
    return false;
  }
  return prefix.every((segment, index) => path[index] === segment);
};

const pathsOverlap = (
  left: readonly string[],
  right: readonly string[],
): boolean => isPrefixPath(left, right) || isPrefixPath(right, left);

const encodePointer = (path: readonly string[]): string => {
  if (path.length === 0) {
    return "";
  }
  return `/${
    path.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
      .join("/")
  }`;
};

const isJSONPatchValue = (
  value: StorableDatum | undefined,
): value is JSONValue | undefined => {
  if (
    value === undefined || value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (typeof value === "bigint") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJSONPatchValue(entry as StorableDatum));
  }

  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  return Object.values(value).every((entry) =>
    isJSONPatchValue(entry as StorableDatum)
  );
};

const readPathValue = (
  value: StorableDatum | undefined,
  path: readonly string[],
): StorableDatum | undefined => {
  let current: unknown = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (segment === "length") {
        current = current.length;
        continue;
      }
      if (!isArrayIndexPropertyName(segment)) {
        return undefined;
      }
      current = current[Number(segment)];
      continue;
    }
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current as StorableDatum | undefined;
};

type PathInspection =
  | {
    kind: "ok";
    value: StorableDatum | undefined;
  }
  | {
    kind: "notFound";
    path: readonly string[];
  }
  | {
    kind: "typeMismatch";
    path: readonly string[];
    actualType: string;
  };

const inspectPath = (
  value: StorableDatum | undefined,
  path: readonly string[],
): PathInspection => {
  if (path.length === 0) {
    return { kind: "ok", value };
  }

  let current: unknown = value;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]!;

    if (current === undefined) {
      return {
        kind: "notFound",
        path: path.slice(0, index),
      };
    }

    if (Array.isArray(current)) {
      if (segment === "length") {
        current = current.length;
        continue;
      }
      if (!isArrayIndexPropertyName(segment)) {
        return {
          kind: "typeMismatch",
          path: path.slice(0, index + 1),
          actualType: "array",
        };
      }
      current = current[Number(segment)];
      continue;
    }

    if (isRecord(current)) {
      current = current[segment];
      continue;
    }

    return {
      kind: "typeMismatch",
      path: path.slice(0, index + 1),
      actualType: getValueTypeName(current as StorableDatum | undefined),
    };
  }

  return {
    kind: "ok",
    value: current as StorableDatum | undefined,
  };
};

const isContainerValue = (
  value: StorableDatum | undefined,
): value is Record<string, StorableDatum> | StorableDatum[] =>
  Array.isArray(value) || isRecord(value);

const getValueTypeName = (value: StorableDatum | undefined): string => {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
};

const isDocumentEnvelopeValue = (
  value: StorableDatum | undefined,
): value is Record<string, StorableDatum> =>
  isRecord(value) &&
  (
    Object.hasOwn(value, "value") ||
    Object.hasOwn(value, "source")
  );

const collapseEmptyDocumentEnvelope = (
  currentRoot: StorableDatum | undefined,
  nextRoot: StorableDatum | undefined,
  type: MediaType,
): StorableDatum | undefined => {
  if (
    type === "application/json" &&
    isDocumentEnvelopeValue(currentRoot) &&
    isRecord(nextRoot) &&
    Object.keys(nextRoot).length === 0
  ) {
    return undefined;
  }
  return nextRoot;
};

type MutableWriteResult = {
  root: StorableDatum | undefined;
  previousValue: StorableDatum | undefined;
  changed: boolean;
};

const applyMutablePathWrite = (
  currentRoot: StorableDatum | undefined,
  address: IMemoryAddress,
  value: StorableDatum | undefined,
): Result<MutableWriteResult, ITypeMismatchError> => {
  const sourceRoot = currentRoot;
  if (address.path.length === 0) {
    return {
      ok: {
        root: value,
        previousValue: currentRoot,
        changed: !deepEqual(currentRoot, value),
      },
    };
  }

  if (currentRoot === undefined) {
    if (value === undefined) {
      return {
        ok: {
          root: currentRoot,
          previousValue: undefined,
          changed: false,
        },
      };
    }
    currentRoot = createMissingContainer(address.path[0]!);
  } else if (!isContainerValue(currentRoot)) {
    return {
      error: TypeMismatchError(
        { ...address, path: address.path.slice(0, 1) },
        getValueTypeName(currentRoot),
        "write",
      ),
    };
  }

  const root = currentRoot;
  let current = root as Record<string, StorableDatum> | StorableDatum[];
  let parent: Record<string, StorableDatum> | StorableDatum[] | undefined;
  let parentKey: string | number | undefined;

  for (let index = 0; index < address.path.length; index += 1) {
    const key = address.path[index]!;
    const isLast = index === address.path.length - 1;

    if (Array.isArray(current)) {
      if (key === "length") {
        if (!isLast) {
          return {
            error: TypeMismatchError(
              { ...address, path: address.path.slice(0, index + 1) },
              "number",
              "write",
            ),
          };
        }
        const previousValue = current.length;
        const changed = !deepEqual(previousValue, value);
        if (changed) {
          const nextLength = value as number;
          const replacement = nextLength < current.length || nextLength < 0 ||
              !Number.isFinite(nextLength)
            ? current.slice(0, nextLength)
            : (() => {
              const copy = sparseArrayCopy(current);
              copy.length = nextLength;
              return copy;
            })();
          if (parent === undefined) {
            return {
              ok: {
                root: collapseEmptyDocumentEnvelope(
                  sourceRoot,
                  replacement,
                  address.type,
                ),
                previousValue,
                changed: true,
              },
            };
          }
          if (Array.isArray(parent)) {
            parent[parentKey as number] = replacement;
          } else {
            parent[parentKey as string] = replacement;
          }
        }
        return {
          ok: {
            root,
            previousValue,
            changed,
          },
        };
      }

      if (!isArrayIndexPropertyName(key)) {
        return {
          error: TypeMismatchError(
            { ...address, path: address.path.slice(0, index + 1) },
            "array",
            "write",
          ),
        };
      }

      const slot = Number(key);
      if (isLast) {
        const previousValue = current[slot];
        if (deepEqual(previousValue, value)) {
          return { ok: { root, previousValue, changed: false } };
        }
        if (value === undefined) {
          delete current[slot];
        } else {
          current[slot] = value;
        }
        return {
          ok: {
            root: collapseEmptyDocumentEnvelope(sourceRoot, root, address.type),
            previousValue,
            changed: true,
          },
        };
      }

      parent = current;
      parentKey = slot;
      let next = current[slot];
      if (next === undefined) {
        next = createMissingContainer(address.path[index + 1]!);
        current[slot] = next;
      } else if (!isContainerValue(next)) {
        return {
          error: TypeMismatchError(
            { ...address, path: address.path.slice(0, index + 1) },
            getValueTypeName(next),
            "write",
          ),
        };
      }
      current = next as Record<string, StorableDatum> | StorableDatum[];
      continue;
    }

    if (isLast) {
      const previousValue = current[key];
      if (deepEqual(previousValue, value)) {
        return { ok: { root, previousValue, changed: false } };
      }
      if (value === undefined) {
        delete current[key];
      } else {
        current[key] = value;
      }
      return {
        ok: {
          root: collapseEmptyDocumentEnvelope(sourceRoot, root, address.type),
          previousValue,
          changed: true,
        },
      };
    }

    parent = current;
    parentKey = key;
    let next = current[key];
    if (next === undefined) {
      next = createMissingContainer(address.path[index + 1]!);
      current[key] = next;
    } else if (!isContainerValue(next)) {
      return {
        error: TypeMismatchError(
          { ...address, path: address.path.slice(0, index + 1) },
          getValueTypeName(next),
          "write",
        ),
      };
    }
    current = next as Record<string, StorableDatum> | StorableDatum[];
  }

  return { ok: { root, previousValue: undefined, changed: false } };
};

const resolveArrayPatchPath = (
  before: StorableDatum | undefined,
  after: StorableDatum | undefined,
  path: readonly string[],
): readonly string[] | null => {
  let deepestArrayPath: readonly string[] | null = null;

  for (let index = 0; index < path.length; index += 1) {
    const prefix = path.slice(0, index);
    const beforeValue = readPathValue(before, prefix);
    const afterValue = readPathValue(after, prefix);
    if (Array.isArray(beforeValue) || Array.isArray(afterValue)) {
      deepestArrayPath = prefix;
    }
  }

  if (deepestArrayPath) {
    return deepestArrayPath;
  }

  const firstArrayLikeSegment = path.findIndex((segment) =>
    segment === "length" || isArrayIndexPropertyName(segment)
  );
  return firstArrayLikeSegment === -1
    ? null
    : path.slice(0, firstArrayLikeSegment);
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
  #readActivities: IReadActivity[] = [];
  #writeActivities: IMemorySpaceAddress[] = [];
  #activityOrder: ActivityOrderEntry[] = [];
  #reactivityLog: TransactionReactivityLog = {
    reads: [],
    shallowReads: [],
    writes: [],
  };
  #writeSpace?: MemorySpace;
  #lastDocument?: {
    branch: SpaceBranch;
    id: URI;
    type: MediaType;
    doc: DocumentEntry;
  };

  constructor(private readonly storage: IStorageManager) {}

  static create(manager: IStorageManager): IStorageTransaction {
    return new this(manager);
  }

  activity(): Iterable<Activity> {
    const reads = this.#readActivities;
    const writes = this.#writeActivities;
    const order = this.#activityOrder;
    return (function* (): Iterable<Activity> {
      for (const entry of order) {
        if (entry > 0) {
          yield { read: reads[entry - 1]! };
          continue;
        }
        yield { write: writes[-entry - 1]! };
      }
    })();
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
    return this.#reactivityLog;
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
      const patch = this.buildPatchOperation(id, type, doc);
      if (patch) {
        operations.push(patch);
        continue;
      }

      operations.push(
        doc.current.value === undefined
          ? { op: "delete", id, type }
          : { op: "set", id, type, value: doc.current.value },
      );
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
    const { doc } = this.document(branch, address);
    const readMeta = options?.meta ?? EMPTY_META;
    const { space: _, ...memoryAddress } = address;

    const readActivity = {
      space: address.space,
      id: address.id,
      type: address.type,
      path: address.path,
      meta: readMeta,
      ...(options?.nonRecursive === true ? { nonRecursive: true } : {}),
    };
    this.#readActivities.push(readActivity);
    this.#activityOrder.push(this.#readActivities.length);
    if (!isReadIgnoredForScheduling(readMeta)) {
      const logAddress = {
        space: address.space,
        id: address.id,
        type: address.type,
        path: address.path.slice(1),
      };
      if (options?.nonRecursive === true) {
        this.#reactivityLog.shallowReads.push(logAddress);
      } else {
        this.#reactivityLog.reads.push(logAddress);
      }
      if (isReadMarkedAsPotentialWrite(readMeta)) {
        this.#reactivityLog.potentialWrites ??= [];
        this.#reactivityLog.potentialWrites.push(logAddress);
      }
    }
    if (options?.trackReadWithoutLoad === true) {
      return { ok: { address, value: undefined } };
    }
    if (!getExperimentalStorableConfig().richStorableValues) {
      const inspected = inspectPath(doc.current.value, memoryAddress.path);
      if (
        !address.id.startsWith("data:") &&
        !doc.validated
      ) {
        doc.validated = true;
      }
      if (inspected.kind === "notFound") {
        return {
          error: NotFound(doc.current, memoryAddress, inspected.path).from(
            address.space,
          ),
        };
      }
      if (inspected.kind === "typeMismatch") {
        return {
          error: TypeMismatchError(
            { ...memoryAddress, path: inspected.path },
            inspected.actualType,
            "read",
          ).from(address.space),
        };
      }
      return {
        ok: {
          address: memoryAddress,
          value: inspected.value,
        },
      };
    }

    const cacheKey = encodePointer(memoryAddress.path);
    if (isMutableTransactionReadAllowed(readMeta)) {
      if (
        !address.id.startsWith("data:") &&
        !doc.validated
      ) {
        doc.validated = true;
      }
      return {
        ok: {
          address: memoryAddress,
          value: readPathValue(doc.current.value, memoryAddress.path),
        },
      };
    }
    if (doc.frozenReads.has(cacheKey)) {
      return {
        ok: {
          address: memoryAddress,
          value: doc.frozenReads.get(cacheKey),
        },
      };
    }

    const result = readAttestation(doc.current, memoryAddress);
    if (
      !address.id.startsWith("data:") &&
      !doc.validated
    ) {
      doc.validated = true;
    }
    if (result.error) {
      return { error: result.error.from(address.space) };
    }

    const frozenValue = freezeReadValue(result.ok.value);
    doc.frozenReads.set(cacheKey, frozenValue);
    return {
      ok: {
        ...result.ok,
        value: frozenValue,
      },
    };
  }

  write(
    address: IMemorySpaceAddress,
    value?: StorableDatum,
  ): Result<IAttestation, WriterError | WriteError> {
    const ready = this.prepareWriteSpace(address.space);
    if (ready.error) {
      return { error: ready.error };
    }
    return this.writeWithinBranch(ready.ok, address.space, address, value);
  }

  writeBatch(
    writes: Iterable<ITransactionWriteRequest>,
  ): Result<Unit, WriterError | WriteError> {
    let run: ITransactionWriteRequest[] = [];
    let runKey: string | undefined;

    const flushRun = (): Result<Unit, WriterError | WriteError> => {
      if (run.length === 0) {
        return { ok: {} };
      }
      const [{ address }] = run;
      const ready = this.prepareWriteSpace(address.space);
      if (ready.error) {
        return { error: ready.error };
      }
      const result = this.writeBatchRun(address.space, ready.ok, run);
      run = [];
      runKey = undefined;
      return result;
    };

    for (const write of writes) {
      const key =
        `${write.address.space}|${write.address.id}|${write.address.type}`;
      if (runKey === undefined || key === runKey) {
        run.push(write);
        runKey = key;
        continue;
      }
      const flushed = flushRun();
      if (flushed.error) {
        return flushed;
      }
      run.push(write);
      runKey = key;
    }

    return flushRun();
  }

  writeWithinSpace(
    space: MemorySpace,
    address: IMemoryAddress,
    value?: StorableDatum,
  ): Result<IAttestation, WriteError> {
    return this.writeWithinBranch(this.branch(space), space, address, value);
  }

  private writeWithinBranch(
    branch: SpaceBranch,
    space: MemorySpace,
    address: IMemoryAddress,
    value?: StorableDatum,
  ): Result<IAttestation, WriteError> {
    if (address.id.startsWith("data:")) {
      return { error: ReadOnlyAddressError(address).from(space) };
    }

    const { doc } = this.document(branch, address);
    const current = doc.current;
    const previous = inspectPath(doc.current.value, address.path);
    if (previous.kind === "ok" && deepEqual(previous.value, value)) {
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
    doc.frozenReads.clear();
    const writeActivity = {
      space,
      id: address.id,
      type: address.type,
      path: address.path,
    };
    this.#writeActivities.push(writeActivity);
    this.#activityOrder.push(-this.#writeActivities.length);
    this.#reactivityLog.writes.push({
      space,
      id: address.id,
      type: address.type,
      path: address.path.slice(1),
    });

    const key = encodePointer(address.path);
    const existingDetail = doc.writeDetails.get(key);
    if (existingDetail) {
      existingDetail.value = isolatedValue;
    } else {
      doc.writeDetails.set(key, {
        address: writeActivity,
        value: isolatedValue,
        previousValue: previous.kind === "ok" ? previous.value : undefined,
      });
    }

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
    doc.frozenReads.clear();
    const writeActivity = {
      space,
      id: address.id,
      type: address.type,
      path: address.path,
    };
    this.#writeActivities.push(writeActivity);
    this.#activityOrder.push(-this.#writeActivities.length);
    this.#reactivityLog.writes.push({
      space,
      id: address.id,
      type: address.type,
      path: address.path.slice(1),
    });

    const key = encodePointer(address.path);
    const existing = doc.writeDetails.get(key);
    if (existing) {
      existing.value = isolatedValue;
    } else {
      doc.writeDetails.set(key, {
        address: writeActivity,
        value: isolatedValue,
        previousValue: undefined,
      });
    }

    return { ok: next };
  }

  private writeBatchRun(
    space: MemorySpace,
    branch: SpaceBranch,
    writes: readonly ITransactionWriteRequest[],
  ): Result<Unit, WriteError> {
    if (
      writes.length <= 1 ||
      writes.some(({ address }) => address.id.startsWith("data:"))
    ) {
      for (const { address, value } of writes) {
        const result = this.writeWithinSpaceCreatingParents(
          space,
          address,
          value,
        );
        if (result.error) {
          return { error: result.error };
        }
      }
      return { ok: {} };
    }

    const { doc } = this.document(branch, writes[0]!.address);
    const originalRoot = doc.current.value;
    let nextRoot = originalRoot;
    let hasMutableRoot = false;
    let changed = false;

    for (const { address, value } of writes) {
      const isolatedValue = value === undefined
        ? undefined
        : isolateTransactionValue(value) as StorableDatum;
      const previousValue = readPathValue(nextRoot, address.path);
      if (deepEqual(previousValue, isolatedValue)) {
        continue;
      }
      if (
        !hasMutableRoot && address.path.length > 0 && nextRoot !== undefined
      ) {
        nextRoot = isolateTransactionValue(nextRoot) as StorableDatum;
        hasMutableRoot = true;
      }
      const result = applyMutablePathWrite(nextRoot, address, isolatedValue);
      if (result.error) {
        if (changed) {
          doc.current = {
            ...doc.current,
            value: nextRoot,
          };
          doc.frozenReads.clear();
        }
        return { error: result.error.from(space) };
      }
      nextRoot = result.ok.root;
      if (!result.ok.changed) {
        continue;
      }
      changed = true;
      this.recordWriteActivity(
        space,
        address,
        isolatedValue,
        result.ok.previousValue ?? previousValue,
        doc,
      );
      if (address.path.length === 0 || !hasMutableRoot) {
        hasMutableRoot = true;
      }
    }

    if (!changed) {
      return { ok: {} };
    }

    doc.current = {
      ...doc.current,
      value: nextRoot,
    };
    doc.frozenReads.clear();
    return { ok: {} };
  }

  private recordWriteActivity(
    space: MemorySpace,
    address: IMemoryAddress,
    value: StorableDatum | undefined,
    previousValue: StorableDatum | undefined,
    doc: DocumentEntry,
  ): void {
    const writeActivity = {
      space,
      id: address.id,
      type: address.type,
      path: address.path,
    };
    this.#writeActivities.push(writeActivity);
    this.#activityOrder.push(-this.#writeActivities.length);
    this.#reactivityLog.writes.push({
      space,
      id: address.id,
      type: address.type,
      path: address.path.slice(1),
    });

    const key = encodePointer(address.path);
    const existing = doc.writeDetails.get(key);
    if (existing) {
      existing.value = value;
      return;
    }

    doc.writeDetails.set(key, {
      address: writeActivity,
      value,
      previousValue,
    });
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

    const writeSpace = this.#writeSpace;
    if (!writeSpace) {
      const result = { ok: {} } satisfies Result<Unit, CommitError>;
      this.#state = { status: "done", result };
      return result;
    }

    const native = this.getNativeCommit(writeSpace);
    const operations = native?.operations ?? [];
    if (operations.length === 0) {
      const result = { ok: {} } satisfies Result<Unit, CommitError>;
      this.#state = { status: "done", result };
      return result;
    }

    const validation = this.validate();
    if (validation.error) {
      this.#state = {
        status: "done",
        result: { error: validation.error },
      };
      return { error: validation.error };
    }

    const replica = this.storage.open(writeSpace).replica;
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

  private prepareWriteSpace(
    space: MemorySpace,
  ): Result<SpaceBranch, InactiveTransactionError | WriterError> {
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
    return { ok: this.branch(space) };
  }

  private branch(space: MemorySpace): SpaceBranch {
    let branch = this.#branches.get(space);
    if (!branch) {
      branch = {
        replica: this.storage.open(space).replica,
        docs: new Map(),
      };
      this.#branches.set(space, branch);
    }
    return branch;
  }

  private document(
    branch: SpaceBranch,
    address: Pick<IMemoryAddress, "id" | "type">,
  ): { doc: DocumentEntry; meta: { seq?: number } } {
    if (
      this.#lastDocument?.branch === branch &&
      this.#lastDocument.id === address.id &&
      this.#lastDocument.type === address.type
    ) {
      return {
        doc: this.#lastDocument.doc,
        meta: {
          ...(typeof this.#lastDocument.doc.seq === "number"
            ? { seq: this.#lastDocument.doc.seq }
            : {}),
        },
      };
    }

    const key = this.docKey(address);
    let doc = branch.docs.get(key);
    if (!doc) {
      const loaded = this.loadRoot(branch, address);
      const seq = this.readSeq(branch, address);
      doc = {
        initial: loaded,
        current: loaded,
        seq,
        validated: false,
        frozenReads: new Map(),
        writeDetails: new Map(),
      };
      branch.docs.set(key, doc);
    }
    this.#lastDocument = {
      branch,
      id: address.id,
      type: address.type,
      doc,
    };
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
      for (const doc of branch.docs.values()) {
        if (!doc.validated) {
          continue;
        }
        const result = claim(doc.initial, branch.replica);
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

  private buildPatchOperation(
    id: URI,
    type: MediaType,
    doc: DocumentEntry,
  ): NativeStorageCommitOperation | null {
    if (doc.initial.value === undefined || doc.current.value === undefined) {
      return null;
    }

    const initialPayload = readPathValue(doc.initial.value, ["value"]);
    const currentPayload = readPathValue(doc.current.value, ["value"]);

    const details = [...doc.writeDetails.values()];
    const relativePaths = details.map((detail) => detail.address.path.slice(1));
    if (relativePaths.some((path) => path.length === 0)) {
      return null;
    }

    const patchDetails = new Map<string, {
      path: readonly string[];
      value: JSONValue | undefined;
      previousValue: JSONValue | undefined;
    }>();
    for (const detail of details) {
      const relativePath = detail.address.path.slice(1);
      const arrayPatchPath = resolveArrayPatchPath(
        initialPayload,
        currentPayload,
        relativePath,
      );
      const patchPath = arrayPatchPath ?? relativePath;
      const value = readPathValue(
        currentPayload,
        patchPath,
      ) as JSONValue | undefined;
      const previousValue = readPathValue(
        initialPayload,
        patchPath,
      ) as JSONValue | undefined;

      if (
        !isJSONPatchValue(value as StorableDatum | undefined) ||
        !isJSONPatchValue(previousValue as StorableDatum | undefined)
      ) {
        return null;
      }
      if (deepEqual(value, previousValue)) {
        continue;
      }

      patchDetails.set(patchPath.join("\0"), {
        path: patchPath,
        value,
        previousValue,
      });
    }
    if (patchDetails.size === 0) {
      return null;
    }

    const compactedPaths = [...patchDetails.values()].map((detail) =>
      detail.path
    );
    for (let index = 0; index < compactedPaths.length; index += 1) {
      for (let other = index + 1; other < compactedPaths.length; other += 1) {
        if (pathsOverlap(compactedPaths[index]!, compactedPaths[other]!)) {
          return null;
        }
      }
    }

    const patches: PatchOp[] = [...patchDetails.values()].map((detail) => {
      const path = encodePointer(detail.path);
      if (detail.value === undefined) {
        return { op: "remove", path };
      }
      if (detail.previousValue === undefined) {
        return { op: "add", path, value: detail.value };
      }
      return { op: "replace", path, value: detail.value };
    });

    return { op: "patch", id, type, patches, value: doc.current.value };
  }
}
