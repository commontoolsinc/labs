/**
 * Injected on-disk SQLite source registry (read-only v1).
 *
 * A `cf piece link <piece> <field> sqlite:<absPath>` operation registers a
 * `{ disk: { path } }` source descriptor as SERVER-SIDE state keyed by the
 * handle cell's entity id. The descriptor must NOT live in the cell's readable
 * value (which stays the opaque `{ id, tables, rev, external }`) — the absolute
 * file path is not pattern-visible state.
 *
 * When the server reads a database for a handle id (`Server.sqliteQuery`), it
 * consults this registry first: a registered id is read from the descriptor's
 * path, read-only and on a read worker, instead of the cell-derived
 * per-(space,id) file. Writes to a registered (injected) source are rejected —
 * on-disk write/atomicity is gated on Q13/Q14.
 *
 * The server keeps the registry in a file beside the per-space store files and
 * never inside any space's store, so a registration survives a restart while a
 * space copied to another host carries no host path with it
 * (docs/specs/sqlite-builtin/03-database-sources.md §03.3). One server owns a
 * store, and so its registry file.
 */

import * as Path from "@std/path";
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
 * With a `file`, every registration is written to it before it takes effect,
 * and the registry reads the file back the first time it is consulted, so
 * registrations survive a restart. Without one, as for a server whose store is
 * in memory, they last as long as the registry does.
 *
 * A file that cannot be read, or does not hold a list of registrations, is
 * reported once on the console. The registry then holds no registrations:
 * `get()` and `register()` throw, so a read of an injected source fails and
 * a registration does not overwrite what the file held, while `has()` returns
 * false, so cell-derived databases are unaffected.
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

  /** The file the registrations are kept in, when they are kept. */
  readonly #file: string | undefined;

  /** Whether the file has been read, and whether reading it failed. */
  #state: "unread" | "read" | "unreadable" = "unread";

  /**
   * Constructs an instance holding at most `maxEntries` registrations, kept in
   * `file` when one is given.
   */
  constructor(maxEntries = 4096, file?: string) {
    this.#maxEntries = maxEntries;
    this.#file = file;
  }

  /**
   * Register (or replace) the on-disk source for `(space, id)`. With a file,
   * the registration takes effect only once the file holding it is written.
   * Idempotent for a stable `(space, absPath)`-derived id + canonical path.
   */
  register(space: string, id: string, descriptor: DiskSourceDescriptor): void {
    this.#readable();
    const key = this.#key(space, id);
    if (!this.#byKey.has(key) && this.#byKey.size >= this.#maxEntries) {
      throw new Error(
        `disk-source registry is full (max ${this.#maxEntries} sources)`,
      );
    }
    if (this.#byKey.get(key)?.path === descriptor.path) return;
    const next = new Map(this.#byKey);
    next.set(key, { path: descriptor.path });
    this.#save(next);
    this.#byKey = next;
  }

  /** Resolve the on-disk descriptor for `(space, id)`, or undefined if it is not
   *  an injected on-disk source (caller falls back to cell-derived). Throws
   *  when the registry file cannot be read. */
  get(space: string, id: string): DiskSourceDescriptor | undefined {
    this.#readable();
    const d = this.#byKey.get(this.#key(space, id));
    return d ? { path: d.path } : undefined;
  }

  /** Whether `(space, id)` is a registered injected on-disk source; false for
   *  every key while the registry file cannot be read. */
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
   * Helper for `get()` and `register()`, which reads the registry file if it
   * has not been read, and throws when it cannot be.
   */
  #readable(): void {
    this.#load();
    if (this.#state === "unreadable") {
      throw new Error("sqlite: the disk-source registry cannot be read");
    }
  }

  /**
   * Helper for every read and write, which reads the registry file the first
   * time the registry is consulted. A missing file holds no registrations.
   */
  #load(): void {
    if (this.#state !== "unread") return;
    if (this.#file === undefined) {
      this.#state = "read";
      return;
    }
    try {
      for (const { space, id, path } of readStored(this.#file)) {
        this.#byKey.set(this.#key(space, id), { path });
      }
      this.#state = "read";
    } catch (error) {
      // The reason names a path on the server, so it goes to the log, and a
      // caller is told only that the registry cannot be read.
      console.error(
        "[memory-sqlite] the disk-source registry cannot be read: " +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      this.#byKey.clear();
      this.#state = "unreadable";
    }
  }

  /**
   * Helper for `register()`, which writes `registrations` to the registry
   * file, flushed to disk before it replaces the file whole, so a reader never
   * sees half a write.
   */
  #save(registrations: Map<string, DiskSourceDescriptor>): void {
    if (this.#file === undefined) return;
    const stored: StoredDiskSource[] = [...registrations].map(([key, d]) => {
      const separator = key.indexOf("\x00");
      return {
        space: key.slice(0, separator),
        id: key.slice(separator + 1),
        path: d.path,
      };
    });
    Deno.mkdirSync(Path.dirname(this.#file), { recursive: true });
    const partial = `${this.#file}.partial`;
    const bytes = new TextEncoder().encode(JSON.stringify(stored));
    const file = Deno.openSync(partial, {
      write: true,
      create: true,
      truncate: true,
    });
    try {
      let written = 0;
      while (written < bytes.length) {
        written += file.writeSync(bytes.subarray(written));
      }
      file.syncSync();
    } finally {
      file.close();
    }
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
  throw new Error("the file does not hold a list of registrations");
}
