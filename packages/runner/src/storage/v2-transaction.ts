import { deepFreeze } from "@commonfabric/data-model/deep-freeze";
import {
  getDataModelConfig,
  isArrayIndexPropertyName,
} from "@commonfabric/data-model/fabric-value";
import { unclaimed } from "@commonfabric/memory/fact";
import type { PatchOp } from "@commonfabric/memory/v2";
import { encodePointer, pathsOverlap } from "../../../memory/v2/path.ts";
import type { FabricValue } from "@commonfabric/memory/interface";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { getLogger } from "@commonfabric/utils/logger";
import { isRecord } from "@commonfabric/utils/types";
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
import { createReadOnlyTransactionError } from "./interface.ts";
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
import {
  createPathContainer,
  ensureParentContainers,
  readValueAtPath,
} from "./v2-path.ts";
import { recordWriteStackTrace } from "./write-stack-trace.ts";

type RootAttestation = IAttestation;

type ReadDocumentEntry = {
  initial: RootAttestation;
  seq?: number;
  validated: boolean;
  current?: RootAttestation;
  frozenReads?: Map<string, FabricValue | undefined>;
  writeDetails?: Map<string, TransactionWriteDetail>;
  patchDetails?: Map<string, TransactionWriteDetail>;
};

type WritableDocumentEntry = {
  initial: RootAttestation;
  current: RootAttestation;
  seq?: number;
  validated: boolean;
  frozenReads: Map<string, FabricValue | undefined>;
  writeDetails: Map<string, TransactionWriteDetail>;
  patchDetails: Map<string, TransactionWriteDetail>;
};

type DocumentEntry = ReadDocumentEntry | WritableDocumentEntry;

type SpaceBranch = {
  replica: ReturnType<IStorageManager["open"]>["replica"];
  docs: Map<string, DocumentEntry>;
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

const logger = getLogger("storage.v2.transaction", {
  enabled: false,
  level: "error",
});

function withCommitTiming<T>(
  keys: string[],
  fn: () => T,
): T {
  logger.timeStart(...keys);
  try {
    return fn();
  } finally {
    logger.timeEnd(...keys);
  }
}

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

const currentDocument = (doc: DocumentEntry): RootAttestation =>
  doc.current ?? doc.initial;

const isWritableDocument = (
  doc: DocumentEntry,
): doc is WritableDocumentEntry =>
  doc.current !== undefined &&
  doc.frozenReads !== undefined &&
  doc.writeDetails !== undefined &&
  doc.patchDetails !== undefined;

const ensureWritableDocument = (
  doc: DocumentEntry,
): WritableDocumentEntry => {
  if (isWritableDocument(doc)) {
    return doc;
  }
  doc.current = doc.initial;
  doc.frozenReads = new Map();
  doc.writeDetails = new Map();
  doc.patchDetails = new Map();
  return doc as WritableDocumentEntry;
};

const freezeReadValue = <T extends FabricValue | undefined>(value: T): T => {
  if (
    value === undefined || value === null ||
    typeof value !== "object"
  ) {
    return value;
  }
  return deepFreeze(isolateTransactionValue(value)) as T;
};

const collapseEmptyJsonDocumentEnvelope = (
  type: MediaType,
  value: FabricValue | undefined,
): FabricValue | undefined => {
  if (
    type !== "application/json" ||
    value === undefined ||
    !isRecord(value) ||
    Array.isArray(value) ||
    Object.keys(value).length > 0
  ) {
    return value;
  }
  return undefined;
};

const EMPTY_META = Object.freeze({});

const normalizeReactivityPath = (path: readonly string[]): string[] =>
  path[0] === "value" ? [...path.slice(1)] : [...path];

type PathInspection =
  | {
    kind: "ok";
    value: FabricValue | undefined;
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
  value: FabricValue | undefined,
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
      actualType: getValueTypeName(current as FabricValue | undefined),
    };
  }

  return {
    kind: "ok",
    value: current as FabricValue | undefined,
  };
};

const isContainerValue = (
  value: FabricValue | undefined,
): value is Record<string, FabricValue> | FabricValue[] =>
  Array.isArray(value) || isRecord(value);

const getValueTypeName = (value: FabricValue | undefined): string => {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
};

type MutableWriteResult = {
  root: FabricValue | undefined;
  previousValue: FabricValue | undefined;
  changed: boolean;
};

const applyMutablePathWrite = (
  currentRoot: FabricValue | undefined,
  address: IMemoryAddress,
  value: FabricValue | undefined,
): Result<MutableWriteResult, ITypeMismatchError> => {
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
    currentRoot = createPathContainer(address.path[0]!);
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
  let current = root as Record<string, FabricValue> | FabricValue[];
  let parent: Record<string, FabricValue> | FabricValue[] | undefined;
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
                root: replacement,
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
            root,
            previousValue,
            changed: true,
          },
        };
      }

      parent = current;
      parentKey = slot;
      let next = current[slot];
      if (next === undefined) {
        next = createPathContainer(address.path[index + 1]!);
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
      current = next as Record<string, FabricValue> | FabricValue[];
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
          root,
          previousValue,
          changed: true,
        },
      };
    }

    parent = current;
    parentKey = key;
    let next = current[key];
    if (next === undefined) {
      next = createPathContainer(address.path[index + 1]!);
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
    current = next as Record<string, FabricValue> | FabricValue[];
  }

  return { ok: { root, previousValue: undefined, changed: false } };
};

const findMaterializedParentPath = (
  currentRoot: FabricValue | undefined,
  path: readonly string[],
  value: FabricValue | undefined,
): readonly string[] | undefined => {
  if (value === undefined || path.length <= 1) {
    return undefined;
  }

  if (currentRoot === undefined) {
    return [];
  }

  if (!isContainerValue(currentRoot)) {
    return undefined;
  }

  let current = currentRoot as Record<string, FabricValue> | FabricValue[];
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]!;

    if (Array.isArray(current)) {
      if (key === "length" || !isArrayIndexPropertyName(key)) {
        return undefined;
      }
      const next = current[Number(key)];
      if (next === undefined) {
        return path.slice(0, index);
      }
      if (!isContainerValue(next)) {
        return undefined;
      }
      current = next;
      continue;
    }

    const next = current[key];
    if (next === undefined) {
      return path.slice(0, index);
    }
    if (!isContainerValue(next)) {
      return undefined;
    }
    current = next;
  }

  return undefined;
};

type PatchDraftCandidate = {
  patch: PatchOp;
  path: readonly string[];
  coversDescendants: boolean;
  tailSpliceStartIndex?: number;
};

const findDeepestArrayPath = (
  before: FabricValue | undefined,
  after: FabricValue | undefined,
  path: readonly string[],
): readonly string[] | null => {
  let deepestArrayPath: readonly string[] | null = null;

  for (let index = 0; index < path.length; index += 1) {
    const prefix = path.slice(0, index);
    const beforeValue = readValueAtPath(before, prefix, {
      allowArrayLength: true,
    });
    const afterValue = readValueAtPath(after, prefix, {
      allowArrayLength: true,
    });
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

const buildValuePatchCandidate = (
  path: readonly string[],
  value: FabricValue | undefined,
  previousValue: FabricValue | undefined,
): PatchDraftCandidate | null => {
  if (deepEqual(value, previousValue)) {
    return null;
  }

  const pointer = encodePointer(path);
  if (value === undefined) {
    return {
      patch: { op: "remove", path: pointer },
      path,
      coversDescendants: true,
    };
  }
  if (previousValue === undefined) {
    return {
      patch: { op: "add", path: pointer, value },
      path,
      coversDescendants: true,
    };
  }
  return {
    patch: { op: "replace", path: pointer, value },
    path,
    coversDescendants: true,
  };
};

const arrayTailIsDense = (
  value: readonly FabricValue[],
  start: number,
): boolean => {
  for (let index = start; index < value.length; index += 1) {
    if (!(index in value)) {
      return false;
    }
  }
  return true;
};

const buildArrayPatchCandidates = (
  path: readonly string[],
  before: FabricValue | undefined,
  after: FabricValue | undefined,
): PatchDraftCandidate[] => {
  if (deepEqual(before, after)) {
    return [];
  }

  if (!Array.isArray(before) || !Array.isArray(after)) {
    const candidate = buildValuePatchCandidate(path, after, before);
    return candidate ? [candidate] : [];
  }

  const overlappingLength = Math.min(before.length, after.length);
  for (let index = 0; index < overlappingLength; index += 1) {
    if ((index in before) !== (index in after)) {
      const fallback = buildValuePatchCandidate(path, after, before);
      return fallback ? [fallback] : [];
    }
  }

  if (after.length > before.length && !arrayTailIsDense(after, before.length)) {
    const fallback = buildValuePatchCandidate(path, after, before);
    return fallback ? [fallback] : [];
  }

  const candidates: PatchDraftCandidate[] = [];
  for (let index = 0; index < overlappingLength; index += 1) {
    if (!(index in before)) {
      continue;
    }

    const nextValue = after[index] as FabricValue | undefined;
    const previousValue = before[index] as FabricValue | undefined;
    if (deepEqual(nextValue, previousValue)) {
      continue;
    }

    candidates.push({
      patch: {
        op: "replace",
        path: encodePointer([...path, index.toString()]),
        value: nextValue,
      },
      path: [...path, index.toString()],
      coversDescendants: true,
    });
  }

  if (after.length > before.length) {
    candidates.push({
      patch: {
        op: "splice",
        path: encodePointer(path),
        index: before.length,
        remove: 0,
        add: after.slice(before.length) as FabricValue[],
      },
      path,
      coversDescendants: false,
      tailSpliceStartIndex: before.length,
    });
  } else if (after.length < before.length) {
    candidates.push({
      patch: {
        op: "splice",
        path: encodePointer(path),
        index: after.length,
        remove: before.length - after.length,
        add: [],
      },
      path,
      coversDescendants: false,
      tailSpliceStartIndex: after.length,
    });
  }

  if (candidates.length === 0) {
    const fallback = buildValuePatchCandidate(path, after, before);
    return fallback ? [fallback] : [];
  }

  return candidates;
};

const isPrefixPath = (
  prefix: readonly string[],
  path: readonly string[],
): boolean => prefix.length <= path.length && pathsOverlap(prefix, path);

const isSubsumedByTailSplice = (
  spliceCandidate: PatchDraftCandidate,
  candidatePath: readonly string[],
): boolean => {
  if (spliceCandidate.tailSpliceStartIndex === undefined) {
    return false;
  }
  if (
    !isPrefixPath(spliceCandidate.path, candidatePath) ||
    candidatePath.length <= spliceCandidate.path.length
  ) {
    return false;
  }
  const childSegment = candidatePath[spliceCandidate.path.length];
  return childSegment !== undefined &&
    isArrayIndexPropertyName(childSegment) &&
    Number(childSegment) >= spliceCandidate.tailSpliceStartIndex;
};

const shallowStructureChanged = (
  before: FabricValue | undefined,
  after: FabricValue | undefined,
): boolean => {
  if (isRecord(before) && isRecord(after)) {
    const beforeKeys = Object.keys(before);
    const afterKeys = Object.keys(after);
    if (beforeKeys.length !== afterKeys.length) {
      return true;
    }
    if (Array.isArray(before) !== Array.isArray(after)) {
      return true;
    }
    if (Array.isArray(before) && before.length !== after.length) {
      return true;
    }
    return !beforeKeys.every((key) => Object.hasOwn(after, key));
  }

  return !deepEqual(before, after);
};

const compareDocPaths = (
  left: readonly string[],
  right: readonly string[],
): number => {
  if (left.length !== right.length) {
    return left.length - right.length;
  }

  const leftPointer = encodePointer(left);
  const rightPointer = encodePointer(right);
  return leftPointer < rightPointer ? -1 : leftPointer > rightPointer ? 1 : 0;
};

const buildReactivityPathsForChange = (
  beforeRoot: FabricValue | undefined,
  afterRoot: FabricValue | undefined,
  path: readonly string[],
): readonly (readonly string[])[] => {
  const beforeValue = readValueAtPath(beforeRoot, path, {
    allowArrayLength: true,
  });
  const afterValue = readValueAtPath(afterRoot, path, {
    allowArrayLength: true,
  });
  if (deepEqual(beforeValue, afterValue)) {
    return [];
  }

  const paths = new Map<string, readonly string[]>();
  if (path.length === 0) {
    paths.set("", []);
    return [...paths.values()];
  }

  for (let prefixLength = 1; prefixLength < path.length; prefixLength += 1) {
    const prefix = path.slice(0, prefixLength);
    if (
      !shallowStructureChanged(
        readValueAtPath(beforeRoot, prefix, {
          allowArrayLength: true,
        }),
        readValueAtPath(afterRoot, prefix, {
          allowArrayLength: true,
        }),
      )
    ) {
      continue;
    }
    paths.set(encodePointer(prefix), prefix);
  }

  paths.set(encodePointer(path), path);
  return [...paths.values()].sort(compareDocPaths);
};

class V2TransactionJournal implements ITransactionJournal {
  constructor(private readonly tx: V2StorageTransaction) {}

  activity(): Iterable<Activity> {
    throw new Error(
      "V2 transactions do not support journal.activity(); " +
        "use getReadActivities(), getReactivityLog(), or getWriteDetails().",
    );
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
    value?: FabricValue,
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
  #reactivityLogCache?: TransactionReactivityLog;
  #writeSpace?: MemorySpace;
  #readOnlySource?: string;
  #lastDocument?: {
    branch: SpaceBranch;
    id: URI;
    type: MediaType;
    doc: DocumentEntry;
  };

  constructor(private readonly storage: IStorageManager) {}

  setReadOnly(reason = "runtime.readTx()"): void {
    this.#readOnlySource = reason;
  }

  clearReadOnly(): void {
    this.#readOnlySource = undefined;
  }

  isReadOnly(): boolean {
    return this.#readOnlySource !== undefined;
  }

  static create(manager: IStorageManager): IStorageTransaction {
    return new this(manager);
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
    this.#reactivityLogCache ??= this.buildReactivityLog();
    return this.#reactivityLogCache;
  }

  getNativeCommit(space: MemorySpace): NativeStorageCommit | undefined {
    const branch = this.#branches.get(space);
    if (!branch) {
      return undefined;
    }

    const operations: NativeStorageCommitOperation[] = [];
    for (const [key, doc] of branch.docs.entries()) {
      if (!isWritableDocument(doc)) {
        continue;
      }
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
      if (!isWritableDocument(entry)) {
        continue;
      }
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
    this.assertWritable("writer()");
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
    const current = currentDocument(doc);
    const readMeta = options?.meta ?? EMPTY_META;
    const { space: _, ...memoryAddress } = address;

    if (!address.id.startsWith("data:")) {
      const readActivity = {
        space: address.space,
        id: address.id,
        type: address.type,
        path: address.path,
        meta: readMeta,
        ...(options?.nonRecursive === true ? { nonRecursive: true } : {}),
      };
      this.#readActivities.push(readActivity);
      this.invalidateReactivityLog();
    }
    if (options?.trackReadWithoutLoad === true) {
      if (!address.id.startsWith("data:")) {
        doc.validated = true;
      }
      return { ok: { address, value: undefined } };
    }
    if (!getDataModelConfig()) {
      const inspected = inspectPath(current.value, memoryAddress.path);
      if (
        !address.id.startsWith("data:") &&
        !doc.validated
      ) {
        doc.validated = true;
      }
      if (inspected.kind === "notFound") {
        return {
          error: NotFound(current, memoryAddress, inspected.path).from(
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
          value: readValueAtPath(current.value, memoryAddress.path, {
            allowArrayLength: true,
          }),
        },
      };
    }
    const frozenReads = doc.frozenReads;
    if (frozenReads?.has(cacheKey)) {
      return {
        ok: {
          address: memoryAddress,
          value: frozenReads.get(cacheKey),
        },
      };
    }

    const result = readAttestation(current, memoryAddress);
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
    (doc.frozenReads ??= new Map()).set(cacheKey, frozenValue);
    return {
      ok: {
        ...result.ok,
        value: frozenValue,
      },
    };
  }

  write(
    address: IMemorySpaceAddress,
    value?: FabricValue,
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
    value?: FabricValue,
  ): Result<IAttestation, WriteError> {
    this.assertWritable("write()");
    return this.writeWithinBranch(this.branch(space), space, address, value);
  }

  private writeWithinBranch(
    branch: SpaceBranch,
    space: MemorySpace,
    address: IMemoryAddress,
    value?: FabricValue,
  ): Result<IAttestation, WriteError> {
    if (address.id.startsWith("data:")) {
      return { error: ReadOnlyAddressError(address).from(space) };
    }

    const { doc: readDoc } = this.document(branch, address);
    const doc = ensureWritableDocument(readDoc);
    const current = doc.current;
    const previous = inspectPath(current.value, address.path);
    if (previous.kind === "ok" && deepEqual(previous.value, value)) {
      return { ok: current };
    }
    const isolatedValue = value === undefined
      ? undefined
      : isolateTransactionValue(value) as FabricValue;
    const result = writeAttestation(current, address, isolatedValue);
    if (result.error) {
      return { error: result.error.from(space) };
    }

    const next = result.ok as RootAttestation;
    const collapsedNext = {
      ...next,
      value: collapseEmptyJsonDocumentEnvelope(address.type, next.value),
    } as RootAttestation;
    if (
      collapsedNext.value === current.value &&
      collapsedNext.address === current.address
    ) {
      return { ok: collapsedNext };
    }

    doc.current = collapsedNext;
    doc.frozenReads.clear();
    this.recordPatchIntent(
      space,
      address,
      readValueAtPath(collapsedNext.value, address.path, {
        allowArrayLength: true,
      }),
      previous.kind === "ok"
        ? isolateTransactionValue(previous.value) as FabricValue | undefined
        : undefined,
      doc,
    );
    this.recordWriteActivity(
      space,
      address,
      isolatedValue,
      previous.kind === "ok" ? previous.value : undefined,
      doc,
    );

    return { ok: collapsedNext };
  }

  private writeWithinSpaceCreatingParents(
    space: MemorySpace,
    address: IMemoryAddress,
    value?: FabricValue,
  ): Result<IAttestation, WriteError> {
    const direct = this.writeWithinSpace(space, address, value);
    if (direct.ok || direct.error?.name !== "NotFoundError") {
      return direct;
    }

    if (value === undefined) {
      return {
        ok: currentDocument(this.document(this.branch(space), address).doc),
      };
    }

    const branch = this.branch(space);
    const { doc: readDoc } = this.document(branch, address);
    const doc = ensureWritableDocument(readDoc);
    const errorPath = direct.error.path;
    const lastExistingPath = errorPath.slice(0, -1);
    const remainingPath = address.path.slice(lastExistingPath.length);
    if (remainingPath.length === 0) {
      return direct;
    }

    let parentValue: FabricValue;
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
      parentValue = isolateTransactionValue(existingParent) as FabricValue;
    }

    const seededParent = ensureParentContainers(
      parentValue,
      remainingPath.slice(0, -1),
      remainingPath[remainingPath.length - 1]!,
    );
    const isolatedValue = isolateTransactionValue(value) as FabricValue;
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
    const collapsedNext = {
      ...next,
      value: collapseEmptyJsonDocumentEnvelope(address.type, next.value),
    } as RootAttestation;
    if (collapsedNext === doc.current) {
      return { ok: collapsedNext };
    }

    const previousActivityValue = isolateTransactionValue(
      readValueAtPath(doc.current.value, lastExistingPath, {
        allowArrayLength: true,
      }),
    ) as FabricValue | undefined;

    doc.current = collapsedNext;
    doc.frozenReads.clear();
    this.recordPatchIntent(
      space,
      address,
      readValueAtPath(collapsedNext.value, address.path, {
        allowArrayLength: true,
      }),
      undefined,
      doc,
    );
    this.recordWriteActivity(
      space,
      { ...address, path: lastExistingPath },
      readValueAtPath(collapsedNext.value, lastExistingPath, {
        allowArrayLength: true,
      }),
      previousActivityValue,
      doc,
    );

    return { ok: collapsedNext };
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

    const { doc: readDoc } = this.document(branch, writes[0]!.address);
    const doc = ensureWritableDocument(readDoc);
    const originalRoot = doc.current.value;
    let nextRoot = originalRoot;
    let hasMutableRoot = false;
    let changed = false;

    for (const { address, value } of writes) {
      const isolatedValue = value === undefined
        ? undefined
        : isolateTransactionValue(value) as FabricValue;
      const previousValue = readValueAtPath(nextRoot, address.path, {
        allowArrayLength: true,
      });
      if (deepEqual(previousValue, isolatedValue)) {
        continue;
      }
      const activityPath = findMaterializedParentPath(
        nextRoot,
        address.path,
        isolatedValue,
      ) ?? address.path;
      const previousActivityValue = isolateTransactionValue(
        readValueAtPath(nextRoot, activityPath, {
          allowArrayLength: true,
        }),
      ) as FabricValue | undefined;
      if (
        !hasMutableRoot && address.path.length > 0 && nextRoot !== undefined
      ) {
        nextRoot = isolateTransactionValue(nextRoot) as FabricValue;
        hasMutableRoot = true;
      }
      const result = applyMutablePathWrite(nextRoot, address, isolatedValue);
      if (result.error) {
        if (changed) {
          doc.current = {
            ...doc.current,
            value: collapseEmptyJsonDocumentEnvelope(
              writes[0]!.address.type,
              nextRoot,
            ),
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
      this.recordPatchIntent(
        space,
        address,
        readValueAtPath(result.ok.root, address.path, {
          allowArrayLength: true,
        }),
        isolateTransactionValue(previousValue) as FabricValue | undefined,
        doc,
      );
      this.recordWriteActivity(
        space,
        { ...address, path: activityPath },
        readValueAtPath(result.ok.root, activityPath, {
          allowArrayLength: true,
        }),
        previousActivityValue,
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
      value: collapseEmptyJsonDocumentEnvelope(
        writes[0]!.address.type,
        nextRoot,
      ),
    };
    doc.frozenReads.clear();
    return { ok: {} };
  }

  private recordWriteActivity(
    space: MemorySpace,
    address: IMemoryAddress,
    value: FabricValue | undefined,
    previousValue: FabricValue | undefined,
    doc: WritableDocumentEntry,
  ): void {
    recordWriteStackTrace(
      {
        space,
        id: address.id,
        type: address.type,
        path: address.path,
      },
      value,
      {
        scopeId: (this as { writeTraceScopeId?: string }).writeTraceScopeId,
        writerActionId: (this as { debugActionId?: string }).debugActionId,
      },
    );

    this.upsertWriteDetail(
      doc.writeDetails,
      space,
      address,
      value,
      previousValue,
    );
    this.invalidateReactivityLog();
  }

  private recordPatchIntent(
    space: MemorySpace,
    address: IMemoryAddress,
    value: FabricValue | undefined,
    previousValue: FabricValue | undefined,
    doc: WritableDocumentEntry,
  ): void {
    this.upsertWriteDetail(
      doc.patchDetails,
      space,
      address,
      value,
      previousValue,
    );
  }

  private upsertWriteDetail(
    details: Map<string, TransactionWriteDetail>,
    space: MemorySpace,
    address: IMemoryAddress,
    value: FabricValue | undefined,
    previousValue: FabricValue | undefined,
  ): void {
    const writeActivity = {
      space,
      id: address.id,
      type: address.type,
      path: address.path,
    };
    const key = encodePointer(address.path);
    const existing = details.get(key);
    if (existing) {
      // Only update the latest value — previousValue intentionally stays as the
      // pre-transaction state so that journal.history() reports the correct
      // before-snapshot for reverts and conflict detection.
      existing.value = value;
      return;
    }

    details.set(key, {
      address: writeActivity,
      value,
      previousValue,
    });
  }

  abort(reason?: unknown): Result<Unit, InactiveTransactionError> {
    this.assertWritable("abort()");
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
    this.assertWritable("commit()");
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

    const native = withCommitTiming(
      ["commit", "getNativeCommit"],
      () => this.getNativeCommit(writeSpace),
    );
    const operations = native?.operations ?? [];
    if (operations.length === 0) {
      const result = { ok: {} } satisfies Result<Unit, CommitError>;
      this.#state = { status: "done", result };
      return result;
    }

    const validation = withCommitTiming(
      ["commit", "validate"],
      () => this.validate(),
    );
    if (validation.error) {
      this.#state = {
        status: "done",
        result: { error: validation.error },
      };
      return { error: validation.error };
    }

    const replica = this.storage.open(writeSpace).replica;
    if (!replica.commitNative) {
      throw new Error("memory v2 replica does not support commitNative()");
    }
    const commitNative = replica.commitNative.bind(replica);
    const promise = withCommitTiming(
      ["commit", "commitNative"],
      () => commitNative(native!, this),
    );
    this.#state = { status: "pending", promise };
    try {
      const result = await promise;
      this.#state = { status: "done", result };
      return result;
    } catch (error) {
      const storeError: StorageTransactionRejected = {
        name: "StoreError" as const,
        message: error instanceof Error ? error.message : String(error),
        cause: {
          name: "StoreError",
          message: error instanceof Error ? error.message : String(error),
        },
      };
      const result: Result<Unit, StorageTransactionRejected> = {
        error: storeError,
      };
      this.#state = { status: "done", result };
      return result;
    }
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

  private invalidateReactivityLog(): void {
    this.#reactivityLogCache = undefined;
  }

  private buildReactivityLog(): TransactionReactivityLog {
    const reads: IMemorySpaceAddress[] = [];
    const shallowReads: IMemorySpaceAddress[] = [];
    let potentialWrites: IMemorySpaceAddress[] | undefined;

    for (const read of this.#readActivities) {
      const meta = read.meta ?? EMPTY_META;
      if (isReadIgnoredForScheduling(meta)) {
        continue;
      }

      const address = {
        space: read.space,
        id: read.id,
        type: read.type,
        path: normalizeReactivityPath(read.path),
      };

      if (read.nonRecursive === true) {
        shallowReads.push(address);
      } else {
        reads.push(address);
      }

      if (isReadMarkedAsPotentialWrite(meta)) {
        potentialWrites ??= [];
        potentialWrites.push(address);
      }
    }

    const writes: IMemorySpaceAddress[] = [];
    for (const [space, branch] of this.#branches.entries()) {
      for (const [key, doc] of branch.docs.entries()) {
        if (!isWritableDocument(doc)) {
          continue;
        }

        const { id, type } = this.parseDocKey(key);
        const reactivityPaths = new Map<string, readonly string[]>();
        for (const detail of doc.patchDetails.values()) {
          for (
            const path of buildReactivityPathsForChange(
              doc.initial.value,
              doc.current.value,
              detail.address.path,
            )
          ) {
            reactivityPaths.set(encodePointer(path), path);
          }
        }

        for (
          const path of [...reactivityPaths.values()].sort(compareDocPaths)
        ) {
          writes.push({
            space,
            id,
            type,
            path: normalizeReactivityPath(path),
          });
        }
      }
    }

    return {
      reads,
      shallowReads,
      writes,
      ...(potentialWrites && potentialWrites.length > 0
        ? { potentialWrites }
        : {}),
    };
  }

  private prepareWriteSpace(
    space: MemorySpace,
  ): Result<SpaceBranch, InactiveTransactionError | WriterError> {
    this.assertWritable("write()");
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

  private assertWritable(method: string): void {
    if (this.#readOnlySource === undefined) {
      return;
    }
    throw createReadOnlyTransactionError(method, this.#readOnlySource);
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
        seq,
        validated: false,
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
    doc: WritableDocumentEntry,
  ): NativeStorageCommitOperation | null {
    if (doc.initial.value === undefined || doc.current.value === undefined) {
      return null;
    }

    const details = [...doc.patchDetails.values()];
    if (details.some((detail) => detail.address.path.length === 0)) {
      return null;
    }

    const patchDetails = new Map<string, {
      path: readonly string[];
      value: FabricValue | undefined;
      previousValue: FabricValue | undefined;
    }>();
    const arrayGroups = new Map<string, readonly string[]>();
    for (const detail of details) {
      const value = readValueAtPath(
        doc.current.value,
        detail.address.path,
        { allowArrayLength: true },
      );
      const previousValue = readValueAtPath(
        doc.initial.value,
        detail.address.path,
        { allowArrayLength: true },
      );
      if (deepEqual(value, previousValue)) {
        continue;
      }

      const arrayPatchPath = findDeepestArrayPath(
        doc.initial.value,
        doc.current.value,
        detail.address.path,
      );
      if (arrayPatchPath) {
        arrayGroups.set(arrayPatchPath.join("\0"), arrayPatchPath);
        continue;
      }

      patchDetails.set(detail.address.path.join("\0"), {
        path: detail.address.path,
        value,
        previousValue,
      });
    }

    const fullCoverCandidates: PatchDraftCandidate[] = [];
    for (const detail of patchDetails.values()) {
      const candidate = buildValuePatchCandidate(
        detail.path,
        detail.value,
        detail.previousValue,
      );
      if (candidate) {
        fullCoverCandidates.push(candidate);
      }
    }

    const nonCoverCandidates: PatchDraftCandidate[] = [];
    for (const arrayPath of arrayGroups.values()) {
      const beforeValue = readValueAtPath(doc.initial.value, arrayPath, {
        allowArrayLength: true,
      });
      const afterValue = readValueAtPath(doc.current.value, arrayPath, {
        allowArrayLength: true,
      });
      for (
        const candidate of buildArrayPatchCandidates(
          arrayPath,
          beforeValue,
          afterValue,
        )
      ) {
        if (candidate.coversDescendants) {
          fullCoverCandidates.push(candidate);
        } else {
          nonCoverCandidates.push(candidate);
        }
      }
    }

    if (fullCoverCandidates.length === 0 && nonCoverCandidates.length === 0) {
      return null;
    }

    const tailSpliceCandidates = nonCoverCandidates.filter((candidate) =>
      candidate.tailSpliceStartIndex !== undefined
    );

    const retainedCoverCandidates = fullCoverCandidates
      .filter((candidate) =>
        !tailSpliceCandidates.some((spliceCandidate) =>
          isSubsumedByTailSplice(spliceCandidate, candidate.path)
        )
      )
      .sort((left, right) => left.path.length - right.path.length);
    const nonOverlappingCoverCandidates: typeof retainedCoverCandidates = [];
    for (const detail of retainedCoverCandidates) {
      if (
        nonOverlappingCoverCandidates.some((existing) =>
          pathsOverlap(existing.path, detail.path)
        )
      ) {
        continue;
      }
      nonOverlappingCoverCandidates.push(detail);
    }

    const retainedNonCoverCandidates = nonCoverCandidates.filter((detail) =>
      !nonOverlappingCoverCandidates.some((existing) =>
        isPrefixPath(existing.path, detail.path)
      ) &&
      !tailSpliceCandidates.some((spliceCandidate) =>
        spliceCandidate !== detail &&
        isSubsumedByTailSplice(spliceCandidate, detail.path)
      )
    );

    const patches: PatchOp[] = [
      ...nonOverlappingCoverCandidates.map((candidate) => candidate.patch),
      ...retainedNonCoverCandidates.map((candidate) => candidate.patch),
    ];

    return { op: "patch", id, type, patches, value: doc.current.value };
  }
}
