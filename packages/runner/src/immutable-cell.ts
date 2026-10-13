/**
 * Runtime-local immutable documents. A compact URI addresses a frozen value
 * and the origin against which its relative links resolve. Values stay native
 * until an outbound write expands the snapshot; no payload lives in the URI.
 */

import {
  assertAcyclicFabricValue,
  cloneIfNecessary,
  type FabricValue,
  hashStringOf,
} from "@commonfabric/data-model";
import {
  hasDataUriScheme,
  isFabricDataUri,
  valueFromDataUri,
} from "@commonfabric/data-model/codec-data-uri";
import type { NormalizedLink } from "./link-types.ts";
import type { URI } from "./sigil-types.ts";

/** The addressing context needed to interpret a relative primitive link. */
type SnapshotOrigin = Pick<NormalizedLink, "id" | "space" | "scope">;

/** A frozen snapshot and its optional relative-link origin. */
export interface ImmutableSnapshot {
  readonly id: URI;
  readonly value: FabricValue;
  readonly origin: SnapshotOrigin | undefined;
}

/** Weak lookup shared by live runtimes; values are retained by their owners. */
const snapshots = new Map<
  URI,
  { value: WeakRef<ImmutableSnapshot>; owners: number }
>();

/** Owners and their transactions share one store without extending its life. */
const owners = new WeakMap<object, ImmutableCellStore>();

/** Releases one owner's identifiers without invalidating another owner's values. */
function releaseSnapshots(ids: Set<URI>): void {
  for (const id of ids) {
    const entry = snapshots.get(id);
    if (entry !== undefined && --entry.owners === 0) snapshots.delete(id);
  }
  ids.clear();
}

/** Releases identifiers when a runtime is reclaimed without disposal. */
const finalizedStores = new FinalizationRegistry<Set<URI>>(releaseSnapshots);

/**
 * Holds snapshots for one runtime. Entries are not evicted: a live URI must
 * continue to resolve even after its source document changes. Disposal releases
 * all snapshots, including those owned by a runtime that keeps its storage open.
 */
export class ImmutableCellStore {
  readonly #ids = new Set<URI>();
  readonly #snapshots = new Map<URI, ImmutableSnapshot>();
  #origins = new Map<string, { value: SnapshotOrigin; hash: string }>();
  #disposed = false;

  /** Registers cleanup without retaining the store or its values. */
  constructor() {
    finalizedStores.register(this, this.#ids, this);
  }

  /**
   * Returns a snapshot, copying only mutable input. The content hash is the
   * shared Fabric hash, memoized by frozen-value identity. Origins omit paths
   * and schemas: relative link paths start at their document's value root.
   */
  create(value: FabricValue, base?: NormalizedLink): ImmutableSnapshot {
    if (this.#disposed) throw new Error("Immutable cell store is disposed");
    assertAcyclicFabricValue(value);
    const frozen = cloneIfNecessary(value);
    const resolved = base === undefined ? undefined : immutableOrigin(base);
    // This key contains only address strings, never cell data or a schema.
    const originKey = resolved === undefined ? undefined : JSON.stringify([
      resolved.id,
      resolved.space,
      resolved.scope,
    ]);
    let cachedOrigin = originKey === undefined
      ? undefined
      : this.#origins.get(originKey);
    if (
      resolved !== undefined && originKey !== undefined &&
      cachedOrigin === undefined
    ) {
      const value = Object.freeze({
        ...(resolved.id === undefined ? {} : { id: resolved.id }),
        ...(resolved.space === undefined ? {} : { space: resolved.space }),
        ...(resolved.scope === undefined ? {} : { scope: resolved.scope }),
      });
      cachedOrigin = { value, hash: hashStringOf(value) };
      this.#origins.set(originKey, cachedOrigin);
    }
    const origin = cachedOrigin?.value;
    const key = hashStringOf(frozen) +
      (cachedOrigin === undefined ? "" : `:${cachedOrigin.hash}`);
    const id: URI = `snapshot:${key}`;
    let snapshot = this.#snapshots.get(id);
    if (snapshot === undefined) {
      const shared = snapshots.get(id);
      snapshot = shared?.value.deref() ??
        Object.freeze({ id, value: frozen, origin });
      snapshots.set(id, {
        value: new WeakRef(snapshot),
        owners: (shared?.owners ?? 0) + 1,
      });
      this.#snapshots.set(id, snapshot);
      this.#ids.add(id);
    }
    return snapshot;
  }

  /** Returns a live snapshot, or throws for an absent or expired identifier. */
  get(id: URI): ImmutableSnapshot {
    const snapshot = this.#snapshots.get(id);
    if (snapshot === undefined) throw new Error("Unknown immutable cell");
    return snapshot;
  }

  /** Releases this runtime's snapshots and invalidates their identifiers. */
  dispose(): void {
    this.#disposed = true;
    this.#snapshots.clear();
    this.#origins.clear();
    releaseSnapshots(this.#ids);
    finalizedStores.unregister(this);
  }
}

/** Returns the store owned by a runtime or bound to one of its transactions. */
export function immutableCellsFor(owner: object): ImmutableCellStore {
  let store = owners.get(owner);
  if (store === undefined) {
    store = new ImmutableCellStore();
    owners.set(owner, store);
  }
  return store;
}

/** Binds a transaction to the immutable documents of its owning runtime. */
export function bindImmutableCells(
  owner: object,
  store: ImmutableCellStore,
): void {
  owners.set(owner, store);
}

/** Whether an identifier names a runtime-local snapshot. */
export function isImmutableCellId(id: string): id is `snapshot:${string}` {
  return id.startsWith("snapshot:");
}

/** Whether an identifier names an inline, read-only document of any format. */
export function hasInlineCellScheme(id: string): boolean {
  return isImmutableCellId(id) || hasDataUriScheme(id);
}

/** Whether an inline identifier is one the runtime can expand to a value. */
export function isInlineCellId(id: string): boolean {
  return isImmutableCellId(id) || isFabricDataUri(id);
}

/** Looks up a runtime-local snapshot without retaining its runtime. */
export function immutableSnapshot(id: URI): ImmutableSnapshot {
  const snapshot = snapshots.get(id)?.value.deref();
  if (snapshot === undefined) {
    throw new Error("Unknown or expired immutable cell");
  }
  return snapshot;
}

/** Returns an inline cell's native value, decoding legacy identifiers as needed. */
export function inlineCellValue(id: URI): FabricValue {
  return isImmutableCellId(id)
    ? immutableSnapshot(id).value
    : valueFromDataUri(id);
}

/** Returns the origin a link inside `base` resolves against. */
export function immutableOrigin<T extends SnapshotOrigin>(base: T): T {
  if (base.id === undefined || !isImmutableCellId(base.id)) return base;
  const origin = immutableSnapshot(base.id).origin;
  return origin === undefined ? base : { ...base, ...origin };
}
