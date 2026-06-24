import {
  cloneIfNecessary,
  valueEqual,
} from "@commonfabric/data-model/fabric-value";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { unclaimed } from "@commonfabric/memory/fact";
import type {
  CommitPrecondition,
  PatchOp,
  SqliteOperation,
} from "@commonfabric/memory/v2";
import {
  encodePointer,
  parsePointer,
  pathsOverlap,
} from "../../../memory/v2/path.ts";
import { PathKeyMap } from "@commonfabric/utils/path-key-map";
import type { FabricValue } from "@commonfabric/api";
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
  IWriteOptions,
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
  TransactionReadDetail,
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
  read as readAttestation,
} from "./transaction/attestation.ts";
import {
  applyMutablePathWrite,
  getValueTypeName,
  isContainerValue,
} from "./transaction/mutable-path-write.ts";
import { ReadOnlyAddressError } from "./transaction/chronicle.ts";
import {
  TransactionAborted,
  TransactionCompleteError,
  WriteIsolationError,
} from "./transaction.ts";
import {
  isMutableTransactionReadAllowed,
  isReadIgnoredForScheduling,
  isReadMarkedAsAttemptedWrite,
} from "./reactivity-log.ts";
import { hasValueAtPath, readValueAtPath } from "./v2-path.ts";
import { recordWriteStackTrace } from "./write-stack-trace.ts";
import { normalizeCellScope } from "../scope.ts";
import type { CellScope } from "../builder/types.ts";

type RootAttestation = IAttestation;

const DOCUMENT_MIME = "application/json" as const;

type ReadDocumentEntry = {
  initial: RootAttestation;
  seq?: number;
  validated: boolean;
  current?: RootAttestation;
  frozenReads?: PathKeyMap<FabricValue | undefined>;
  writeDetails?: Map<string, TransactionWriteDetail>;
  patchDetails?: Map<string, TransactionWriteDetail>;
};

type WritableDocumentEntry = {
  initial: RootAttestation;
  current: RootAttestation;
  seq?: number;
  validated: boolean;
  frozenReads: PathKeyMap<FabricValue | undefined>;
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

const createOnlyMarkKey = (
  id: string,
  scope?: unknown,
): string => `${normalizeCellScope(scope as CellScope | undefined)}\0${id}`;

// Enabled so cross-space partial-commit failures (no rollback) are visible.
const multiSpaceCommitLogger = getLogger("storage.v2.multi-space-commit", {
  enabled: true,
  level: "error",
});

const toStoreError = (error: unknown): StorageTransactionRejected => {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: "StoreError" as const,
    message,
    cause: { name: "StoreError", message },
  };
};

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
  doc.frozenReads = new PathKeyMap();
  doc.writeDetails = new Map();
  doc.patchDetails = new Map();
  return doc as WritableDocumentEntry;
};

/**
 * Drops `doc.frozenReads` entries on the chain of `writtenPath` -- both
 * ancestors (whose containers were rebuilt by `applyMutablePathWrite()`)
 * and descendants (the subtree at the write target is gone). Sibling
 * subtrees off divergent ancestors are preserved: structural sharing
 * leaves their values reference-identical to the consumer's cached
 * snapshot.
 *
 * Additionally drops the synthetic `<parent>/length` sibling: writing to
 * `array[N]` can change `array.length`, and that pointer is a true sibling
 * of `array[N]` in the trie (not on its chain), so it needs its own
 * targeted invalidation.
 *
 * Both operations are O(D) in `writtenPath.length` thanks to the
 * `PathKeyMap` tree-walk -- no per-cache-entry sweep.
 */
const invalidateFrozenReadsOnChain = (
  doc: WritableDocumentEntry,
  writtenPath: readonly string[],
): void => {
  const map = doc.frozenReads;
  map.invalidateChain(writtenPath);
  // The chain walk already cleared every ancestor's value AND dropped the
  // subtree at `writtenPath`. Now also drop the parent's `length` child for
  // the JS-array-index case. For a root write this is a no-op; the chain
  // walk already cleared everything.
  if (writtenPath.length > 0) {
    const parent = writtenPath.slice(0, -1);
    map.invalidateChain([...parent, "length"]);
  }
};

const freezeReadValue = <T extends FabricValue | undefined>(value: T): T => {
  if (
    value === undefined || value === null ||
    typeof value !== "object"
  ) {
    return value;
  }
  // `cloneIfNecessary()` (frozen by default) returns an already-deep-frozen
  // value by identity (O(1) via the deep-frozen cache) and otherwise
  // deep-clones-and-freezes -- isolating the result from later source
  // mutation. On the hot read path, repeated reads of the same stored
  // (deep-frozen) value collapse to a single cache lookup.
  return cloneIfNecessary(value as FabricValue) as T;
};

const collapseEmptyJsonDocumentEnvelope = (
  value: FabricValue | undefined,
): FabricValue | undefined => {
  if (
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
const SCHEDULER_OBSERVATION_ADDRESS_LISTS = [
  "actualChangedWrites",
  "currentKnownWrites",
  "declaredWrites",
  "materializerWriteEnvelopes",
  "reads",
  "shallowReads",
] as const;

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

const schedulerObservationCommitSpace = (
  observation: unknown,
): MemorySpace | undefined => {
  if (!isRecord(observation)) {
    return undefined;
  }
  if (typeof observation.ownerSpace === "string") {
    return observation.ownerSpace as MemorySpace;
  }

  for (const key of SCHEDULER_OBSERVATION_ADDRESS_LISTS) {
    const addresses = observation[key];
    if (!Array.isArray(addresses)) {
      continue;
    }
    for (const address of addresses) {
      if (!isRecord(address) || typeof address.space !== "string") {
        continue;
      }
      return address.space as MemorySpace;
    }
  }
};
const findMaterializedParentPath = (
  currentRoot: FabricValue | undefined,
  path: readonly string[],
  isDelete: boolean,
): readonly string[] | undefined => {
  // Deletes never materialize intermediates; value writes (including
  // explicit `undefined`) do.
  if (isDelete) {
    return undefined;
  }

  // A write into a not-yet-initialized doc value materializes the entire
  // value at the root: that's the observable change, regardless of how
  // deep the leaf write is. (`path.length === 0` is the "we ARE the
  // root" case — there's no distinct materialization point, fall back
  // to the leaf via the caller.)
  if (currentRoot === undefined) {
    return path.length === 0 ? undefined : [];
  }

  if (path.length <= 1) {
    return undefined;
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

/**
 * Builds a patch op from before/after state at `path`. Presence (slot
 * exists) is distinct from value: a slot holding `undefined` is present,
 * so add/remove are chosen from presence transitions, and a stored
 * `undefined` travels as a `replace`/`add` whose value is `undefined`.
 * When presence flags are omitted they are inferred from value
 * definedness (legacy callers in the array fast-path, where presence
 * parity was already established via `in` checks).
 */
const buildValuePatchCandidate = (
  path: readonly string[],
  value: FabricValue | undefined,
  previousValue: FabricValue | undefined,
  valuePresent: boolean = value !== undefined,
  previousPresent: boolean = previousValue !== undefined,
): PatchDraftCandidate | null => {
  if (valuePresent === previousPresent && valueEqual(value, previousValue)) {
    return null;
  }

  const pointer = encodePointer(path);
  if (!valuePresent) {
    if (!previousPresent) {
      return null;
    }
    return {
      patch: { op: "remove", path: pointer },
      path,
      coversDescendants: true,
    };
  }
  if (!previousPresent) {
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
  beforePresent: boolean = before !== undefined,
  afterPresent: boolean = after !== undefined,
): PatchDraftCandidate[] => {
  if (beforePresent === afterPresent && valueEqual(before, after)) {
    return [];
  }

  if (!Array.isArray(before) || !Array.isArray(after)) {
    const candidate = buildValuePatchCandidate(
      path,
      after,
      before,
      afterPresent,
      beforePresent,
    );
    return candidate ? [candidate] : [];
  }

  // Both sides are arrays from here on, so the array slot itself is present
  // in both states; fallbacks below replace the whole array.
  const overlappingLength = Math.min(before.length, after.length);
  for (let index = 0; index < overlappingLength; index += 1) {
    if ((index in before) !== (index in after)) {
      const fallback = buildValuePatchCandidate(
        path,
        after,
        before,
        true,
        true,
      );
      return fallback ? [fallback] : [];
    }
  }

  if (after.length > before.length && !arrayTailIsDense(after, before.length)) {
    const fallback = buildValuePatchCandidate(path, after, before, true, true);
    return fallback ? [fallback] : [];
  }

  const candidates: PatchDraftCandidate[] = [];
  for (let index = 0; index < overlappingLength; index += 1) {
    if (!(index in before)) {
      continue;
    }

    const nextValue = after[index] as FabricValue | undefined;
    const previousValue = before[index] as FabricValue | undefined;
    if (valueEqual(nextValue, previousValue)) {
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
    const fallback = buildValuePatchCandidate(path, after, before, true, true);
    return fallback ? [fallback] : [];
  }

  return candidates;
};

// A concrete RFC 6901 array-index segment: a non-negative integer with no
// leading zeros. Mirrors `isArraySegment` in memory/v2/patch.ts. The `-` append
// marker is intentionally NOT an index — appending never shifts existing
// elements, so a leaf-only matcher handles it conservatively via the array path.
const ARRAY_INDEX_SEGMENT = /^(0|[1-9]\d*)$/;

const terminalSegmentIsArrayIndex = (pointer: string): boolean => {
  const segments = parsePointer(pointer);
  const last = segments[segments.length - 1];
  return last !== undefined && ARRAY_INDEX_SEGMENT.test(last);
};

// Generator invariant guard (see docs/specs/memory-v2/08-conflict-granularity.md
// §"Array writes and the leaf-only matcher"). The commit-conflict matcher and
// the scheduler reader-dirty index are both LEAF-ONLY, which is sound only if
// array element insert/remove/reorder reaches the engine as a `splice` on the
// array path or a whole-array `replace` — never as an `add`/`remove`/`move` at an
// array INDEX. Such an op SHIFTS sibling elements, but its leaf path captures
// only the touched index, so a leaf-only matcher would neither conflict (commit)
// nor re-trigger (reader-dirty) a reader of a shifted sibling — a silent stale
// read. `buildArrayPatchCandidates` only ever emits per-index `replace`,
// array-path `splice`, or whole-array `replace`, so this assertion can never fire
// for real input; it converts a future regression in the array diff path into a
// loud failure instead of silent data loss. (A numeric *object* key is flagged
// too — the generator never emits a structural op on one either.)
//
// Exported for direct unit testing: the throw and `move` paths are unreachable
// through the generator (which is the invariant), so they can only be exercised
// by calling this with hand-built patches.
export const assertNoIndexedArrayStructuralOps = (
  patches: readonly PatchOp[],
): void => {
  for (const patch of patches) {
    let offending: string | null = null;
    if (patch.op === "add" || patch.op === "remove") {
      if (terminalSegmentIsArrayIndex(patch.path)) offending = patch.path;
    } else if (patch.op === "move") {
      if (
        terminalSegmentIsArrayIndex(patch.path) ||
        terminalSegmentIsArrayIndex(patch.from)
      ) {
        offending = `${patch.from} -> ${patch.path}`;
      }
    }
    if (offending !== null) {
      throw new Error(
        `v2 patch generator invariant violation: emitted an indexed-array ` +
          `${patch.op} (${offending}). Array element insert/remove/reorder must ` +
          `be a splice on the array path or a whole-array replace; an indexed ` +
          `add/remove/move shifts siblings that the leaf-only conflict and ` +
          `reader-dirty matchers cannot track (see ` +
          `docs/specs/memory-v2/08-conflict-granularity.md).`,
      );
    }
  }
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

  return !valueEqual(before, after);
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
  if (valueEqual(beforeValue, afterValue)) {
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
    options?: IWriteOptions,
  ): Result<IAttestation, WriteError> {
    return this.tx.writeWithinSpace(this.did(), address, value, options);
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
  #schedulerObservation?: unknown;
  #commitPreconditions = new Map<MemorySpace, CommitPrecondition[]>();
  #createOnlyMarks = new Map<
    MemorySpace,
    Map<string, { id: string; scope: CellScope }>
  >();
  // Folded SQLite write ops per space, applied in the same commit as cell ops.
  #sqliteOps = new Map<MemorySpace, SqliteOperation[]>();
  #writeSpace?: MemorySpace;
  // Multi-space write opt-in (see enableMultiSpaceWrites). When disabled the
  // transaction rejects writes to a second space; when enabled commit() splits
  // into one per-space commit.
  #multiSpaceWrites = false;
  #commitOrder?: readonly MemorySpace[];
  // Spaces written to, in first-write order. Used as the default commit order.
  #writtenSpaces: MemorySpace[] = [];
  #readOnlySource?: string;
  #lastDocument?: {
    branch: SpaceBranch;
    id: URI;
    type: MediaType;
    scope: CellScope;
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

  enableMultiSpaceWrites(order?: readonly MemorySpace[]): void {
    this.assertWritable("enableMultiSpaceWrites()");
    this.#multiSpaceWrites = true;
    if (order !== undefined) {
      this.#commitOrder = order;
    }
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

  setSchedulerObservation(observation: unknown): void {
    this.assertWritable("setSchedulerObservation()");
    const ready = this.editable();
    if (ready.error) {
      throw ready.error;
    }
    this.#schedulerObservation = observation;
  }

  getSchedulerObservation(): unknown {
    return this.#schedulerObservation;
  }

  addCommitPrecondition(
    space: MemorySpace,
    precondition: CommitPrecondition,
  ): void {
    this.assertWritable("addCommitPrecondition()");
    const ready = this.editable();
    if (ready.error) {
      throw ready.error;
    }
    // Claim `space` as a write target (sets #writeSpace, enforces single-space
    // write isolation) so a precondition-only commit is still sent and
    // validated instead of resolving ok without a write space.
    const claimed = this.claimWriteSpace(space);
    if (claimed.error) {
      throw claimed.error;
    }
    const preconditions = this.#commitPreconditions.get(space);
    if (preconditions) {
      preconditions.push(precondition);
    } else {
      this.#commitPreconditions.set(space, [precondition]);
    }
  }

  getCommitPreconditions(
    space: MemorySpace,
  ): readonly CommitPrecondition[] | undefined {
    return this.#commitPreconditions.get(space);
  }

  markCreateOnly(
    link: { space: MemorySpace; id: string; scope?: unknown },
  ): void {
    this.assertWritable("markCreateOnly()");
    const ready = this.editable();
    if (ready.error) {
      throw ready.error;
    }
    const claim = this.claimWriteSpace(link.space);
    if (claim.error) {
      throw claim.error;
    }
    let marks = this.#createOnlyMarks.get(link.space);
    if (!marks) {
      marks = new Map();
      this.#createOnlyMarks.set(link.space, marks);
    }
    const scope = normalizeCellScope(link.scope as CellScope | undefined);
    marks.set(createOnlyMarkKey(link.id, scope), {
      id: link.id,
      scope,
    });
  }

  recordSqliteWrite(space: MemorySpace, op: SqliteOperation): void {
    this.assertWritable("recordSqliteWrite()");
    const ready = this.editable();
    if (ready.error) {
      throw ready.error;
    }
    // Claim `space` as a write target (sets #writeSpace, enforces single-space
    // write isolation) so a sqlite-only commit still resolves a write space.
    const claimed = this.claimWriteSpace(space);
    if (claimed.error) {
      throw claimed.error;
    }
    const existing = this.#sqliteOps.get(space);
    if (existing) {
      existing.push(op);
    } else {
      this.#sqliteOps.set(space, [op]);
    }
  }

  getNativeCommit(space: MemorySpace): NativeStorageCommit | undefined {
    const branch = this.#branches.get(space);
    const schedulerObservation = this.schedulerObservationForNativeCommit(
      space,
    );
    const preconditions = this.#commitPreconditions.get(space);
    const createOnlyMarks = this.#createOnlyMarks.get(space);
    const createOnlyPreconditions = [...(createOnlyMarks?.values() ?? [])].map(
      ({ id, scope }) => ({
        kind: "entity-absent" as const,
        id,
        scope,
      }),
    );
    const nativePreconditions = [
      ...(preconditions ?? []),
      ...createOnlyPreconditions,
    ];
    const sqliteOps = this.#sqliteOps.get(space);
    if (
      !branch && schedulerObservation === undefined &&
      nativePreconditions.length === 0 && !sqliteOps?.length
    ) {
      return undefined;
    }

    const operations: NativeStorageCommitOperation[] = [];
    for (const [key, doc] of branch?.docs.entries() ?? []) {
      if (!isWritableDocument(doc)) {
        continue;
      }
      if (doc.writeDetails.size === 0) {
        continue;
      }
      if (valueEqual(doc.current.value, doc.initial.value)) {
        continue;
      }

      const { id, type, scope } = this.parseDocKey(key);
      const patch = this.buildPatchOperation(id, type, scope, doc);
      if (patch) {
        operations.push(patch);
        continue;
      }

      operations.push(
        doc.current.value === undefined ? { op: "delete", id, type, scope } : {
          op: "set",
          id,
          type,
          scope,
          value: doc.current.value,
        },
      );
    }

    return {
      operations,
      ...(schedulerObservation !== undefined ? { schedulerObservation } : {}),
      ...(nativePreconditions.length
        ? { preconditions: nativePreconditions }
        : {}),
      ...(sqliteOps?.length ? { sqliteOps: [...sqliteOps] } : {}),
    };
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

  *getReadDetails(space: MemorySpace): Iterable<TransactionReadDetail> {
    const branch = this.#branches.get(space);
    if (!branch) {
      return;
    }
    for (const [key, entry] of branch.docs) {
      const frozenReads = entry.frozenReads;
      if (!frozenReads) {
        continue;
      }
      const { id, scope } = this.parseDocKey(key);
      for (const [path, value] of frozenReads.entries()) {
        yield {
          address: { space, scope, id, path: [...path] },
          value: value as TransactionReadDetail["value"],
        };
      }
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
    const claim = this.claimWriteSpace(space);
    if (claim.error) {
      return { error: claim.error };
    }
    const branch = this.branch(space);
    branch.writer ??= new V2Writer(this, space);
    return { ok: branch.writer };
  }

  /**
   * Records `space` as a write target. Without the multi-space opt-in, rejects a
   * second space with a write-isolation error (preserving the default
   * single-space guarantee). With it enabled, tracks the space in first-write
   * order for commit() to split on.
   */
  private claimWriteSpace(space: MemorySpace): Result<Unit, WriterError> {
    if (
      !this.#multiSpaceWrites &&
      this.#writeSpace !== undefined &&
      this.#writeSpace !== space
    ) {
      return {
        error: WriteIsolationError({
          open: this.#writeSpace,
          requested: space,
        }),
      };
    }
    if (this.#writeSpace === undefined) {
      this.#writeSpace = space;
    }
    if (!this.#writtenSpaces.includes(space)) {
      this.#writtenSpaces.push(space);
    }
    return { ok: {} };
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
        scope: normalizeCellScope(address.scope),
        id: address.id,
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
    if (frozenReads?.has(memoryAddress.path)) {
      return {
        ok: {
          address: memoryAddress,
          value: frozenReads.get(memoryAddress.path),
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
    (doc.frozenReads ??= new PathKeyMap()).set(memoryAddress.path, frozenValue);
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
    options?: IWriteOptions,
  ): Result<IAttestation, WriterError | WriteError> {
    const ready = this.prepareWriteSpace(address.space);
    if (ready.error) {
      return { error: ready.error };
    }
    return this.writeWithinBranch(
      ready.ok,
      address.space,
      address,
      value,
      options,
    );
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
      // The run is flushed against a single document, fetched from the first
      // write's address (see `writeBatchRun`). Documents are keyed by scope as
      // well as id (`makeDocKey`), so the run key must include scope: otherwise
      // writes to different scoped instances of the same id would be merged into
      // one run and applied to whichever instance came first, corrupting both.
      const key = `${write.address.space}|${
        normalizeCellScope(write.address.scope)
      }|${write.address.id}`;
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
    options?: IWriteOptions,
  ): Result<IAttestation, WriteError> {
    this.assertWritable("write()");
    return this.writeWithinBranch(
      this.branch(space),
      space,
      address,
      value,
      options,
    );
  }

  /**
   * Unified write entry. Handles simple writes, root writes, type-mismatch
   * errors, and create-missing-intermediates in one path, all via
   * `applyMutablePathWrite()`. `cloneForMutation()` inside that helper
   * shallow-thaws only the containers on the write spine; off-spine
   * subtrees stay deep-frozen and structurally shared with the prior
   * `doc.current.value`.
   *
   * No-op short-circuits (presence-aware: a stored `undefined` is a real
   * state, distinct from an absent slot):
   *   - For a value write, if the leaf exists and is already deep-equal to
   *     `value`, return the unchanged attestation. A write of `undefined`
   *     to an absent leaf is NOT a no-op — it stores `undefined`,
   *     materializing intermediates if needed.
   *   - For a delete (`options.delete`), if the leaf doesn't exist —
   *     whether the leaf slot is absent or an intermediate is missing —
   *     return the unchanged attestation; don't allocate intermediate
   *     containers just to delete a slot that wasn't there.
   */
  private writeWithinBranch(
    branch: SpaceBranch,
    space: MemorySpace,
    address: IMemoryAddress,
    value?: FabricValue,
    options?: IWriteOptions,
  ): Result<IAttestation, WriteError> {
    if (address.id.startsWith("data:")) {
      return { error: ReadOnlyAddressError(address).from(space) };
    }
    const isDelete = options?.delete === true;

    const { doc: readDoc } = this.document(branch, address);
    const doc = ensureWritableDocument(readDoc);
    const current = doc.current;
    const previous = inspectPath(current.value, address.path);
    if (previous.kind === "ok") {
      const present = hasValueAtPath(current.value, address.path, {
        allowArrayLength: true,
      });
      if (
        isDelete ? !present : (present && valueEqual(previous.value, value))
      ) {
        return { ok: current };
      }
    }
    if (previous.kind === "notFound" && isDelete) {
      return { ok: current };
    }

    const isolatedValue = value === undefined
      ? undefined
      : cloneIfNecessary(value) as FabricValue;

    // Compute the activity path and previous-value snapshots BEFORE the
    // write -- `applyMutablePathWrite()` mutates `current.value` in place
    // on the second-and-later write to this doc within a transaction
    // (`cloneForMutation({ force: false })` short-circuits to identity on
    // an already-mutable root). Reading `current.value` AFTER the mutation
    // would observe the post-write state and silently mis-report the
    // `previousActivityValue` to the reactivity log.
    //
    // For create-parents writes, the materialization point (deepest
    // pre-existing parent on the write path) is where the observable
    // change happens for subscribers watching a parent. For simple writes
    // it falls back to `address.path`.
    const activityPath = findMaterializedParentPath(
      current.value,
      address.path,
      isDelete,
    ) ?? address.path;
    const previousActivityValue = cloneIfNecessary(
      readValueAtPath(current.value, activityPath, {
        allowArrayLength: true,
      }) as FabricValue,
    ) as FabricValue | undefined;

    const result = applyMutablePathWrite(
      current.value,
      address,
      isolatedValue,
      isDelete ? { delete: true } : undefined,
    );
    if (result.error) {
      return { error: result.error.from(space) };
    }
    if (!result.ok.changed) {
      return { ok: current };
    }

    const collapsedNext: RootAttestation = {
      ...current,
      value: collapseEmptyJsonDocumentEnvelope(result.ok.root),
    };

    doc.current = collapsedNext;
    invalidateFrozenReadsOnChain(doc, address.path);
    this.recordPatchIntent(
      space,
      address,
      readValueAtPath(collapsedNext.value, address.path, {
        allowArrayLength: true,
      }),
      cloneIfNecessary(result.ok.previousValue) as FabricValue | undefined,
      doc,
    );
    this.recordWriteActivity(
      space,
      { ...address, path: activityPath },
      readValueAtPath(collapsedNext.value, activityPath, {
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
      // Singleton-batch / data:URI fallback: route each write through the
      // unified single-write entry, which itself handles
      // create-missing-intermediates.
      for (const { address, value, delete: isDelete } of writes) {
        const result = this.writeWithinSpace(
          space,
          address,
          value,
          isDelete ? { delete: true } : undefined,
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
    let changed = false;
    const writtenPaths: (readonly string[])[] = [];

    // No explicit mutable-root prelude here: `applyMutablePathWrite()` calls
    // `cloneForMutation()` with `force: false`, which shallow-thaws the
    // root container on the first write (if it was frozen) and is an
    // identity short-circuit on subsequent writes (since the root is
    // mutable from then on). That gives us "mutate in place on the same
    // freshly-thawed spine across the whole batch" without ever needing a
    // deep clone of off-spine subtrees.
    //
    // Read-before-mutate ordering is load-bearing: `previousValue`,
    // `activityPath`, and `previousActivityValue` are all computed from
    // `nextRoot` BEFORE `applyMutablePathWrite()` is called. The helper
    // mutates `nextRoot` in place from the second iteration onward, so
    // reading it AFTER the call would observe the post-write state.
    // (See `writeWithinBranch` for the same invariant and a regression
    // test.)
    for (const { address, value, delete: isDelete } of writes) {
      const isolatedValue = value === undefined
        ? undefined
        : cloneIfNecessary(value) as FabricValue;
      const previousValue = readValueAtPath(nextRoot, address.path, {
        allowArrayLength: true,
      });
      // Presence-aware no-op detection (also keeps no-op deletes from
      // reaching `applyMutablePathWrite`, which would materialize
      // intermediates into `nextRoot` before the changed check).
      const present = hasValueAtPath(nextRoot, address.path, {
        allowArrayLength: true,
      });
      if (
        isDelete
          ? !present
          : (present && valueEqual(previousValue, isolatedValue))
      ) {
        continue;
      }
      const activityPath = findMaterializedParentPath(
        nextRoot,
        address.path,
        isDelete === true,
      ) ?? address.path;
      const previousActivityValue = cloneIfNecessary(
        readValueAtPath(nextRoot, activityPath, {
          allowArrayLength: true,
        }) as FabricValue,
      ) as FabricValue | undefined;
      const result = applyMutablePathWrite(
        nextRoot,
        address,
        isolatedValue,
        isDelete ? { delete: true } : undefined,
      );
      if (result.error) {
        if (changed) {
          doc.current = {
            ...doc.current,
            value: collapseEmptyJsonDocumentEnvelope(
              nextRoot,
            ),
          };
          for (const written of writtenPaths) {
            invalidateFrozenReadsOnChain(doc, written);
          }
        }
        return { error: result.error.from(space) };
      }
      nextRoot = result.ok.root;
      if (!result.ok.changed) {
        continue;
      }
      changed = true;
      writtenPaths.push(address.path);
      this.recordPatchIntent(
        space,
        address,
        readValueAtPath(result.ok.root, address.path, {
          allowArrayLength: true,
        }),
        cloneIfNecessary(previousValue) as FabricValue | undefined,
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
    }

    if (!changed) {
      return { ok: {} };
    }

    doc.current = {
      ...doc.current,
      value: collapseEmptyJsonDocumentEnvelope(
        nextRoot,
      ),
    };
    for (const written of writtenPaths) {
      invalidateFrozenReadsOnChain(doc, written);
    }
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
      scope: normalizeCellScope(address.scope),
      id: address.id,
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

    // Genuine cross-space commits split into one per-space commit. A
    // single-space transaction (the common case, even with the opt-in set) stays
    // on the proven path below.
    if (this.#multiSpaceWrites && this.#writtenSpaces.length > 1) {
      return this.commitMultiSpace();
    }

    const writeSpace = this.#writeSpace ??
      schedulerObservationCommitSpace(this.#schedulerObservation);
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
    const hasSchedulerObservation = native?.schedulerObservation !== undefined;
    const hasCommitPreconditions = (native?.preconditions?.length ?? 0) > 0;
    const hasSqliteOps = (native?.sqliteOps?.length ?? 0) > 0;
    if (
      operations.length === 0 && !hasSchedulerObservation &&
      !hasCommitPreconditions && !hasSqliteOps
    ) {
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
      const result: Result<Unit, StorageTransactionRejected> = {
        error: toStoreError(error),
      };
      this.#state = { status: "done", result };
      return result;
    }
  }

  /**
   * Commits a multi-space transaction as one per-space commit each, in commit
   * order (explicit or first-write). Commits run sequentially with no
   * cross-space atomicity: a later failure does not roll back earlier spaces; it
   * is logged and surfaced as the overall result.
   */
  private async commitMultiSpace(): Promise<Result<Unit, CommitError>> {
    const commits: { space: MemorySpace; native: NativeStorageCommit }[] = [];
    for (const space of this.orderedCommitSpaces()) {
      const native = this.getNativeCommit(space);
      const operations = native?.operations ?? [];
      const hasSchedulerObservation =
        native?.schedulerObservation !== undefined;
      const hasCommitPreconditions = (native?.preconditions?.length ?? 0) > 0;
      const hasSqliteOps = (native?.sqliteOps?.length ?? 0) > 0;
      if (
        !native ||
        (operations.length === 0 && !hasSchedulerObservation &&
          !hasCommitPreconditions && !hasSqliteOps)
      ) {
        continue;
      }
      commits.push({ space, native });
    }

    if (commits.length === 0) {
      const result = { ok: {} } satisfies Result<Unit, CommitError>;
      this.#state = { status: "done", result };
      return result;
    }

    const validation = this.validate();
    if (validation.error) {
      this.#state = { status: "done", result: { error: validation.error } };
      return { error: validation.error };
    }

    const promise = this.runSplitCommits(commits);
    this.#state = { status: "pending", promise };
    try {
      const result = await promise;
      this.#state = { status: "done", result };
      return result;
    } catch (error) {
      // Mirror the single-space path: a rejected commit must still transition
      // the transaction to "done" with an error rather than leaving it stuck
      // at "pending" (e.g. if a replica lacks commitNative()).
      const result: Result<Unit, StorageTransactionRejected> = {
        error: toStoreError(error),
      };
      this.#state = { status: "done", result };
      return result;
    }
  }

  /**
   * The written spaces in commit order: the explicit order first (restricted to
   * spaces actually written), then any remaining spaces in first-write order.
   */
  private orderedCommitSpaces(): MemorySpace[] {
    if (this.#commitOrder === undefined) {
      return [...this.#writtenSpaces];
    }
    const ordered: MemorySpace[] = [];
    const seen = new Set<MemorySpace>();
    for (const space of this.#commitOrder) {
      if (!seen.has(space) && this.#writtenSpaces.includes(space)) {
        ordered.push(space);
        seen.add(space);
      }
    }
    for (const space of this.#writtenSpaces) {
      if (!seen.has(space)) {
        ordered.push(space);
        seen.add(space);
      }
    }
    return ordered;
  }

  private async runSplitCommits(
    commits: { space: MemorySpace; native: NativeStorageCommit }[],
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    for (let i = 0; i < commits.length; i++) {
      const { space, native } = commits[i];
      const replica = this.storage.open(space).replica;
      if (!replica.commitNative) {
        throw new Error("memory v2 replica does not support commitNative()");
      }
      const commitNative = replica.commitNative.bind(replica);
      // Stop at the first per-space failure rather than committing the
      // remaining spaces. The commit order is meaningful (e.g. a child space
      // before the parent that links to it), so once an earlier space fails we
      // must not durably apply later ones: doing so would violate the order and
      // double-apply those writes if the transaction is retried. Spaces already
      // committed before the failure are not rolled back (logged); the failing
      // space and everything after it are left uncommitted.
      try {
        const result = await commitNative(native, this);
        if (result.error) {
          multiSpaceCommitLogger.error(
            "multi-space-commit-failed",
            `Cross-space commit to ${space} failed after ${i} space(s); ` +
              `earlier spaces are not rolled back and later spaces are skipped`,
            result.error,
          );
          return { error: result.error };
        }
      } catch (error) {
        multiSpaceCommitLogger.error(
          "multi-space-commit-rejected",
          `Cross-space commit to ${space} rejected after ${i} space(s); ` +
            `earlier spaces are not rolled back and later spaces are skipped`,
          error,
        );
        return { error: toStoreError(error) };
      }
    }
    return { ok: {} };
  }

  private schedulerObservationForNativeCommit(
    space: MemorySpace,
  ): unknown | undefined {
    if (this.#schedulerObservation === undefined) {
      return undefined;
    }
    if (this.#writeSpace === space) {
      return this.#schedulerObservation;
    }
    if (
      this.#writeSpace === undefined &&
      schedulerObservationCommitSpace(this.#schedulerObservation) === space
    ) {
      return this.#schedulerObservation;
    }
    return undefined;
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
    let attemptedWrites: IMemorySpaceAddress[] | undefined;

    for (const read of this.#readActivities) {
      const meta = read.meta ?? EMPTY_META;
      if (isReadIgnoredForScheduling(meta)) {
        continue;
      }

      const address = {
        space: read.space,
        scope: read.scope,
        id: read.id,
        path: read.path,
      };

      if (read.nonRecursive === true) {
        shallowReads.push(address);
      } else {
        reads.push(address);
      }

      if (isReadMarkedAsAttemptedWrite(meta)) {
        attemptedWrites ??= [];
        attemptedWrites.push(address);
      }
    }

    const writes: IMemorySpaceAddress[] = [];
    for (const [space, branch] of this.#branches.entries()) {
      for (const [key, doc] of branch.docs.entries()) {
        if (!isWritableDocument(doc)) {
          continue;
        }

        const { id, scope } = this.parseDocKey(key);
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
            scope,
            id,
            path,
          });
        }
      }
    }

    return {
      reads,
      shallowReads,
      writes,
      ...(attemptedWrites && attemptedWrites.length > 0
        ? { attemptedWrites }
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
    const claim = this.claimWriteSpace(space);
    if (claim.error) {
      return { error: claim.error };
    }
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
    address: Pick<IMemoryAddress, "id" | "type" | "scope">,
  ): { doc: DocumentEntry; meta: { seq?: number } } {
    const scope = normalizeCellScope(address.scope);
    if (
      this.#lastDocument?.branch === branch &&
      this.#lastDocument.id === address.id &&
      this.#lastDocument.type === (address.type ?? DOCUMENT_MIME) &&
      this.#lastDocument.scope === scope
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
      type: address.type ?? DOCUMENT_MIME,
      scope,
      doc,
    };
    return {
      doc,
      meta: { ...(typeof doc.seq === "number" ? { seq: doc.seq } : {}) },
    };
  }

  private loadRoot(
    branch: SpaceBranch,
    address: Pick<IMemoryAddress, "id" | "type" | "scope">,
  ): RootAttestation {
    const type = address.type ?? DOCUMENT_MIME;
    if (address.id.startsWith("data:")) {
      const loaded = loadInline({ id: address.id, type });
      if (loaded.error) {
        throw loaded.error;
      }
      return loaded.ok as RootAttestation;
    }

    const state = branch.replica.get({
      id: address.id,
      type,
      scope: address.scope,
    }) ?? unclaimed({
      of: address.id,
      the: type,
    });

    return {
      address: {
        id: address.id,
        type,
        path: [],
        scope: normalizeCellScope(address.scope),
      },
      value: state.is,
    };
  }

  private readSeq(
    branch: SpaceBranch,
    address: Pick<IMemoryAddress, "id" | "type" | "scope">,
  ): number | undefined {
    if (address.id.startsWith("data:")) {
      return undefined;
    }
    const state = branch.replica.get({
      id: address.id,
      type: address.type ?? DOCUMENT_MIME,
      scope: address.scope,
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

  private docKey(
    address: Pick<IMemoryAddress, "id" | "type" | "scope">,
  ): string {
    return `${normalizeCellScope(address.scope)}\0${address.id}`;
  }

  private parseDocKey(
    key: string,
  ): { id: URI; type: MediaType; scope: CellScope } {
    const separator = key.indexOf("\0");
    if (separator === -1) {
      return { id: key as URI, type: DOCUMENT_MIME, scope: "space" };
    }
    return {
      scope: normalizeCellScope(key.slice(0, separator) as CellScope),
      id: key.slice(separator + 1) as URI,
      type: DOCUMENT_MIME,
    };
  }

  private buildPatchOperation(
    id: URI,
    type: MediaType,
    scope: CellScope,
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
      valuePresent: boolean;
      previousPresent: boolean;
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
      // Presence-aware change detection: present-but-undefined and absent
      // both read as `undefined`, but transitions between them are real
      // changes (add/remove of an `undefined`-valued slot).
      const valuePresent = hasValueAtPath(
        doc.current.value,
        detail.address.path,
        { allowArrayLength: true },
      );
      const previousPresent = hasValueAtPath(
        doc.initial.value,
        detail.address.path,
        { allowArrayLength: true },
      );
      if (
        valuePresent === previousPresent && valueEqual(value, previousValue)
      ) {
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
        valuePresent,
        previousPresent,
      });
    }

    const fullCoverCandidates: PatchDraftCandidate[] = [];
    for (const detail of patchDetails.values()) {
      const candidate = buildValuePatchCandidate(
        detail.path,
        detail.value,
        detail.previousValue,
        detail.valuePresent,
        detail.previousPresent,
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
          hasValueAtPath(doc.initial.value, arrayPath, {
            allowArrayLength: true,
          }),
          hasValueAtPath(doc.current.value, arrayPath, {
            allowArrayLength: true,
          }),
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

    assertNoIndexedArrayStructuralOps(patches);

    return { op: "patch", id, type, scope, patches, value: doc.current.value };
  }
}
