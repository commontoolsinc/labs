// Injected on-disk SQLite source registry (read-only v1).
//
// A `cf piece link <piece> <field> sqlite:<absPath>` operation registers a
// `{ disk: { path } }` source descriptor as SERVER-SIDE state keyed by the
// handle cell's entity id. The descriptor must NOT live in the cell's readable
// value (which stays the opaque `{ id, tables, rev, external }`) — the absolute
// file path is not pattern-visible state.
//
// When the server reads a database for a handle id (`Server.sqliteQuery`), it
// consults this registry first: a registered id is read from the descriptor's
// path, read-only and on a read worker, instead of the cell-derived
// per-(space,id) file. Writes to a registered (injected) source are rejected —
// on-disk write/atomicity is gated on Q13/Q14.
//
// The registry is kept in a file the toolshed owns, beside the per-space store
// files and never inside any space's store, so a registration survives a
// restart while a space copied to another host carries no host path with it
// (docs/specs/sqlite-builtin/03-database-sources.md §03.3).

import { isObjectNotArray } from "@commonfabric/utils/types";

/** A resolved on-disk source descriptor. */
export type DiskSourceDescriptor = {
  /** Absolute path to a plain on-disk SQLite file. */
  path: string;
};

/** One registration as the registry file holds it. */
type StoredDiskSource = {
  /** The space the source is registered in. */
  space: string;

  /** The handle id it is registered under. */
  id: string;

  /** The canonical path it was registered with. */
  path: string;
};

/**
 * Server-side registry of injected on-disk sources, keyed by `(space, id)`.
 * Keying by space (not id alone) stops a session on one space from governing —
 * or hijacking the reads of — a handle id resolved in another space.
 *
 * With a `file`, every registration is written to it and the registry reads it
 * back the first time it is consulted, so registrations survive a restart.
 * Without one, as for a server whose store is in memory, they last as long as
 * the registry does.
 */
export class DiskSourceRegistry {
  #byKey = new Map<string, DiskSourceDescriptor>();

  /**
   * Cap on total entries, so a client looping `sqlite.register-disk-source`
   * with distinct ids cannot grow server memory without bound. Re-registering
   * an existing `(space, id)` is always allowed (idempotent); only _new_ keys
   * past the cap are rejected — a clear error rather than silent eviction
   * (which would drop a legitimate source and silently fall back to the
   * cell-db).
   */
  readonly #maxEntries: number;

  readonly #file: string | undefined;
  #loaded = false;

  /**
   * Constructs an instance holding at most `maxEntries` registrations, kept in
   * `file` when one is given.
   */
  constructor(maxEntries = 4096, file?: string) {
    this.#maxEntries = maxEntries;
    this.#file = file;
  }

  /**
   * Register (or replace) the on-disk source for `(space, id)`, and write the
   * registry to its file. Idempotent for a stable `(space, absPath)`-derived
   * id + canonical path.
   */
  register(space: string, id: string, descriptor: DiskSourceDescriptor): void {
    this.#load();
    const key = this.#key(space, id);
    if (!this.#byKey.has(key) && this.#byKey.size >= this.#maxEntries) {
      throw new Error(
        `disk-source registry is full (max ${this.#maxEntries} sources)`,
      );
    }
    if (this.#byKey.get(key)?.path === descriptor.path) return;
    this.#byKey.set(key, { path: descriptor.path });
    this.#save();
  }

  /** Resolve the on-disk descriptor for `(space, id)`, or undefined if it is not
   *  an injected on-disk source (caller falls back to cell-derived). */
  get(space: string, id: string): DiskSourceDescriptor | undefined {
    this.#load();
    const d = this.#byKey.get(this.#key(space, id));
    return d ? { path: d.path } : undefined;
  }

  /** Whether `(space, id)` is a registered injected on-disk source. */
  has(space: string, id: string): boolean {
    this.#load();
    return this.#byKey.has(this.#key(space, id));
  }

  /**
   * Returns the NUL-separated composite key for `space` and `id` (`\0` cannot
   * appear in a DID or entity id).
   */
  #key(space: string, id: string): string {
    return `${space}\x00${id}`;
  }

  /**
   * Helper for every read and write, which reads the registry file the first
   * time the registry is consulted. A missing file holds no registrations; one
   * that cannot be read, or does not hold a list of registrations, throws:
   * reading it as empty would turn every registered source back into a
   * cell-derived database.
   */
  #load(): void {
    if (this.#loaded) return;
    if (this.#file !== undefined) {
      for (const { space, id, path } of readStored(this.#file)) {
        this.#byKey.set(this.#key(space, id), { path });
      }
    }
    this.#loaded = true;
  }

  /**
   * Helper for `register()`, which writes every registration to the registry
   * file, replacing it whole so a reader never sees half a write.
   */
  #save(): void {
    if (this.#file === undefined) return;
    const stored: StoredDiskSource[] = [...this.#byKey].map(([key, d]) => {
      const separator = key.indexOf("\x00");
      return {
        space: key.slice(0, separator),
        id: key.slice(separator + 1),
        path: d.path,
      };
    });
    const directory = this.#file.slice(0, this.#file.lastIndexOf("/"));
    if (directory !== "") Deno.mkdirSync(directory, { recursive: true });
    const partial = `${this.#file}.partial`;
    Deno.writeTextFileSync(partial, JSON.stringify(stored));
    Deno.renameSync(partial, this.#file);
  }
}

/**
 * Helper for `DiskSourceRegistry`'s first read, which returns the
 * registrations in `file`: none when it does not exist, and a throw when it
 * holds anything but a list of them.
 */
function readStored(file: string): StoredDiskSource[] {
  let text: string;
  try {
    text = Deno.readTextFileSync(file);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  const stored: unknown = JSON.parse(text);
  const registrations: StoredDiskSource[] = [];
  if (Array.isArray(stored)) {
    for (const entry of stored) {
      if (
        !isObjectNotArray(entry) || typeof entry.space !== "string" ||
        typeof entry.id !== "string" || typeof entry.path !== "string"
      ) {
        break;
      }
      registrations.push({
        space: entry.space,
        id: entry.id,
        path: entry.path,
      });
    }
    if (registrations.length === stored.length) return registrations;
  }
  throw new Error(
    "sqlite: the disk-source registry file does not hold a list of " +
      "registrations",
  );
}
