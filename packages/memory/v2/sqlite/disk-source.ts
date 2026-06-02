// Phase 7 — injected on-disk SQLite source registry (read-only v1).
//
// A `cf piece link <piece> <field> sqlite:<absPath>` operation registers a
// `{ disk: { path } }` source descriptor as SERVER-SIDE state keyed by the
// handle cell's entity id. The descriptor must NOT live in the cell's readable
// value (which stays the opaque `{ id, tables, rev }`) — the absolute file path
// is not pattern-visible state.
//
// When the server attaches a database for a handle id (Server.#onCellDb), it
// consults this registry first: a registered id is attached read-only from the
// descriptor's path instead of the cell-derived per-(space,id) file. Writes to a
// registered (injected) source are rejected — on-disk write/atomicity is gated
// on Q13/Q14 and reactivity on Q12 (see plans/on-disk-source.md).
//
// v1 scope: in-memory map on the Server instance. Persisting the registration
// across restarts (and the operator/service-space ownership of the handle cell)
// is a deferred product decision documented in plans/on-disk-source.md.

/** A resolved on-disk source descriptor. */
export interface DiskSourceDescriptor {
  /** Absolute path to a plain on-disk SQLite file. */
  path: string;
}

/** Server-side registry of injected on-disk sources, keyed by handle cell id. */
export class DiskSourceRegistry {
  #byId = new Map<string, DiskSourceDescriptor>();

  /** Register (or replace) the on-disk source for a handle id. Idempotent for a
   *  stable `(serviceSpace, absPath)`-derived id + path. */
  register(id: string, descriptor: DiskSourceDescriptor): void {
    this.#byId.set(id, { path: descriptor.path });
  }

  /** Resolve the on-disk descriptor for a handle id, or undefined if the id is
   *  not an injected on-disk source (caller falls back to cell-derived). */
  get(id: string): DiskSourceDescriptor | undefined {
    const d = this.#byId.get(id);
    return d ? { path: d.path } : undefined;
  }

  /** Whether a handle id is a registered injected on-disk source. */
  has(id: string): boolean {
    return this.#byId.has(id);
  }
}
