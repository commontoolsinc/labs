/**
 * Runtime-local immutable documents. A compact URI addresses a frozen value
 * and the origin against which its relative links resolve. Values stay native
 * until an outbound write expands the snapshot; no payload lives in the URI.
 */

import {
  assertAcyclicFabricValue,
  cloneIfNecessary,
  type FabricValue,
  forEachFabricContainerValue,
  hashStringOf,
} from "@commonfabric/data-model";
import {
  hasDataUriScheme,
  isFabricDataUri,
  valueFromDataUri,
} from "@commonfabric/data-model/codec-data-uri";
import { isLinkRef, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { collectExternalSchemaRefHashes } from "@commonfabric/data-model-schema/schema-refs";
import { walkSchemaDocumentClosure } from "@commonfabric/data-model-schema/schema-closure";

import {
  lookupSchemaDocument,
  onSchemaDocumentRegistered,
} from "./schema-registry.ts";
import type { NormalizedLink } from "./link-types.ts";
import type { CellLinkRefPayload, URI } from "./sigil-types.ts";

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
  #dependencies = new WeakMap<object, readonly ImmutableSnapshot[]>();
  readonly #settled = new Set<URI>();
  readonly #pending = new Set<ImmutableSnapshot>();
  readonly #retaining = new Set<URI>();
  #unsubscribeSchemas: (() => void) | undefined;
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
      snapshot = snapshots.get(id)?.value.deref();
      if (snapshot === undefined) {
        snapshot = Object.freeze({ id, value: frozen, origin });
      }
      this.#retain(snapshot);
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
    this.#settled.clear();
    this.#pending.clear();
    this.#unsubscribeSchemas?.();
    this.#unsubscribeSchemas = undefined;
    this.#dependencies = new WeakMap();
    this.#origins.clear();
    releaseSnapshots(this.#ids);
    finalizedStores.unregister(this);
  }

  /** Finds dependencies in codec state, inline schemas, and available closures. */
  #collectDependencies(value: FabricValue, deferExpired: boolean): {
    dependencies: readonly ImmutableSnapshot[];
    complete: boolean;
  } {
    const object = typeof value === "object" && value !== null
      ? value
      : undefined;
    const cached = object === undefined
      ? undefined
      : this.#dependencies.get(object);
    if (cached !== undefined) return { dependencies: cached, complete: true };
    const nested = new Set<ImmutableSnapshot>();
    let hasExpired = false;
    const schemaRoots = new Set<string>();
    const collect = (value: FabricValue, follow?: (hash: string) => void) => {
      forEachFabricContainerValue(value, (container) => {
        if (!isLinkRef(container)) return;
        const payload = linkRefPayload(container) as CellLinkRefPayload;
        if (payload.id !== undefined && isImmutableCellId(payload.id)) {
          const target = snapshots.get(payload.id)?.value.deref();
          if (target !== undefined) nested.add(target);
          else if (deferExpired) hasExpired = true;
          else immutableSnapshot(payload.id);
        }
        for (const hash of collectExternalSchemaRefHashes(payload.schema)) {
          if (!schemaRoots.has(hash)) {
            schemaRoots.add(hash);
            follow?.(hash);
          }
        }
      });
    };
    collect(value);
    const closure = walkSchemaDocumentClosure({
      roots: schemaRoots,
      load: (hash) => {
        const schema = lookupSchemaDocument(hash);
        return schema === undefined ? undefined : { kind: "verified", schema };
      },
      onVerified: (_hash, schema, walk) => {
        collect(schema, (hash) => walk.follow(hash));
      },
    });
    const dependencies = Object.freeze([...nested]);
    const complete = closure.missing.size === 0 && !hasExpired;
    if (object !== undefined && complete) {
      this.#dependencies.set(object, dependencies);
    }
    return { dependencies, complete };
  }

  /** Acquires dependencies, revisiting incomplete closures when documents arrive. */
  #retain(snapshot: ImmutableSnapshot, deferExpired = false): void {
    if (this.#settled.has(snapshot.id) || this.#retaining.has(snapshot.id)) {
      return;
    }
    this.#retaining.add(snapshot.id);
    try {
      const { dependencies, complete } = this.#collectDependencies(
        snapshot.value,
        deferExpired,
      );
      for (const dependency of dependencies) {
        this.#retain(dependency, deferExpired);
      }
      if (
        snapshot.origin?.id !== undefined &&
        isImmutableCellId(snapshot.origin.id)
      ) {
        this.#retain(immutableSnapshot(snapshot.origin.id));
      }
      if (!this.#snapshots.has(snapshot.id)) {
        const shared = snapshots.get(snapshot.id);
        snapshots.set(snapshot.id, {
          value: new WeakRef(snapshot),
          owners: (shared?.owners ?? 0) + 1,
        });
        this.#snapshots.set(snapshot.id, snapshot);
        this.#ids.add(snapshot.id);
      }
      if (complete) {
        this.#settled.add(snapshot.id);
        this.#pending.delete(snapshot);
      } else {
        this.#pending.add(snapshot);
        if (this.#unsubscribeSchemas === undefined) {
          const owner = new WeakRef(this);
          const unsubscribe = onSchemaDocumentRegistered(() => {
            const store = owner.deref();
            if (store === undefined) unsubscribe();
            else store.#refreshPending();
          });
          this.#unsubscribeSchemas = unsubscribe;
        }
      }
    } finally {
      this.#retaining.delete(snapshot.id);
    }
  }

  /** Acquires newly visible dependencies before schema registration returns. */
  #refreshPending(): void {
    for (const snapshot of this.#pending) this.#retain(snapshot, true);
    if (this.#pending.size === 0) {
      this.#unsubscribeSchemas?.();
      this.#unsubscribeSchemas = undefined;
    }
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
