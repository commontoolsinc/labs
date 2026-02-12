import * as FS from "@std/fs";
import * as Path from "@std/path";

import * as Error from "./error.ts";
import * as Space from "./space.ts";
import {
  addChangesAttributes,
  addMemoryAttributes,
  traceAsync,
  traceSync,
} from "./telemetry.ts";
import {
  AsyncResult,
  ConnectionError,
  MemorySession,
  MemorySpace as Subject,
  Query,
  QueryResult,
  Result,
  SchemaQuery,
  Subscriber,
  SubscribeResult,
  SystemError,
  Transaction,
  TransactionResult,
} from "./interface.ts";
export * from "./interface.ts";
import { type DID } from "@commontools/identity";

/** A mounted space instance with both low-level and high-level access. */
type MountedSpace = Space.SpaceInstance<Subject>;

interface Session {
  store: URL;
  subscribers: Set<Subscriber>;
  spaces: Map<string, MountedSpace>;
}

export class Memory implements Session, MemorySession {
  store: URL;
  ready: Promise<unknown>;
  #serviceDid: DID;

  constructor(
    options: Options,
    public subscribers: Set<Subscriber> = new Set(),
    public spaces: Map<Subject, MountedSpace> = new Map(),
  ) {
    this.store = options.store;
    this.ready = Promise.resolve();
    this.#serviceDid = options.serviceDid;
  }
  clone() {
    return new Memory(
      { store: this.store, serviceDid: this.serviceDid() },
      new Set(this.subscribers),
      new Map(this.spaces),
    );
  }

  serviceDid(): DID {
    return this.#serviceDid;
  }

  get memory() {
    return this;
  }

  // [INSTRUMENTATION] Perform counter for queue timing analysis
  private static _performSeq = 0;

  /**
   * Runs task one at a time, this works around some bug in deno sqlite bindings
   * which seems to cause problems if query and transaction happen concurrently.
   */
  async perform<Out>(task: () => Promise<Out>): Promise<Out> {
    return await traceAsync("memory.perform", async (_span) => {
      const _pId = ++Memory._performSeq;
      const _tEnqueue = performance.now();
      const result = this.ready.finally().then(() => {
        const _tStart = performance.now();
        const _queueWait = _tStart - _tEnqueue;
        if (_queueWait > 1) {
          console.warn(
            `[MEMORY-PERFORM] #${_pId} queueWait=${_queueWait.toFixed(1)}ms`,
          );
        }
        return task();
      });
      this.ready = result.finally();
      await this.ready;
      return await result;
    });
  }

  subscribe(subscriber: Subscriber): SubscribeResult {
    return subscribe(this, subscriber);
  }

  unsubscribe(subscriber: Subscriber): SubscribeResult {
    return unsubscribe(this, subscriber);
  }

  transact(transaction: Transaction): TransactionResult {
    return this.perform(() => transact(this, transaction));
  }

  query(source: Query): QueryResult {
    return this.perform(() => query(this, source));
  }

  querySchema(source: SchemaQuery): QueryResult {
    return this.perform(() => querySchema(this, source));
  }

  close() {
    return this.perform(() => close(this));
  }
}

/**
 * Subscribes a subscriber to memory changes.
 * @param session - The memory session
 * @param subscriber - The subscriber to add
 * @returns Success result
 */
export const subscribe = (session: Session, subscriber: Subscriber) => {
  return traceSync("memory.subscribe", (span) => {
    addMemoryAttributes(span, { operation: "subscribe" });
    session.subscribers.add(subscriber);
    span.setAttribute("memory.subscriber_count", session.subscribers.size);
    return { ok: {} };
  });
};

/**
 * Unsubscribes a subscriber from memory changes.
 * @param session - The memory session
 * @param subscriber - The subscriber to remove
 * @returns Success result
 */
export const unsubscribe = (session: Session, subscriber: Subscriber) => {
  return traceSync("memory.unsubscribe", (span) => {
    addMemoryAttributes(span, { operation: "unsubscribe" });
    session.subscribers.delete(subscriber);
    span.setAttribute("memory.subscriber_count", session.subscribers.size);
    return { ok: {} };
  });
};

export const query = async (session: Session, query: Query) => {
  return await traceAsync("memory.query", async (span) => {
    addMemoryAttributes(span, {
      operation: "query",
      space: query.sub,
    });

    const { ok: space, error } = await mount(session, query.sub);
    if (error) {
      span.setAttribute("mount.status", "error");
      return { error };
    }

    span.setAttribute("mount.status", "success");
    return space.query(query);
  });
};

export const querySchema = async (session: Session, query: SchemaQuery) => {
  return await traceAsync("memory.querySchema", async (span) => {
    addMemoryAttributes(span, {
      operation: "querySchema",
      space: query.sub,
    });

    const { ok: space, error } = await mount(session, query.sub);
    if (error) {
      span.setAttribute("mount.status", "error");
      return { error };
    }

    span.setAttribute("mount.status", "success");
    return space.querySchema(query);
  });
};

/**
 * Internal variant of querySchema that also returns the schemaTracker.
 * Used by provider.ts for incremental subscription updates.
 *
 * @param existingSchemaTracker - Optional existing tracker to reuse. When provided,
 * the query will skip traversing docs that are already tracked with the same schema,
 * providing early termination for overlapping subscriptions.
 */
export const querySchemaWithTracker = async (
  session: Session,
  query: SchemaQuery,
  existingSchemaTracker?: Space.SelectSchemaResult["schemaTracker"],
) => {
  return await traceAsync("memory.querySchemaWithTracker", async (span) => {
    addMemoryAttributes(span, {
      operation: "querySchemaWithTracker",
      space: query.sub,
    });

    const { ok: space, error } = await mount(session, query.sub);
    if (error) {
      span.setAttribute("mount.status", "error");
      return { error };
    }

    span.setAttribute("mount.status", "success");
    // Cast needed to align generic type parameter with query.sub
    return Space.querySchemaWithTracker(
      space as unknown as Space.Session<typeof query.sub>,
      query,
      existingSchemaTracker,
    );
  });
};

// [INSTRUMENTATION] Transaction counter for timing analysis
let _txSeq = 0;

export const transact = async (session: Session, transaction: Transaction) => {
  return await traceAsync("memory.transact", async (span) => {
    const _t0 = performance.now();
    const _txId = ++_txSeq;
    addMemoryAttributes(span, {
      operation: "transact",
      space: transaction.sub,
    });

    if (transaction.args?.changes) {
      addChangesAttributes(span, transaction.args.changes);
    }

    const { ok: space, error } = await mount(session, transaction.sub);
    const _tMount = performance.now();
    if (error) {
      span.setAttribute("mount.status", "error");
      return { error };
    }

    span.setAttribute("mount.status", "success");
    const result = space.transact(transaction);
    const _tSpaceTx = performance.now();

    if (result.error) {
      return result;
    }

    // Get labels for classified content redaction
    const labels = Space.getLabelsForCommit(space, result.ok);

    return await traceAsync(
      "memory.notify_subscribers",
      async (notifySpan) => {
        notifySpan.setAttribute(
          "memory.subscriber_count",
          session.subscribers.size,
        );

        const _tNotifyStart = performance.now();
        const promises = [];
        // Copy here, in case a subscriber modifies the set of subscribers
        for (const subscriber of [...session.subscribers]) {
          promises.push(subscriber.commit(result.ok, labels));
        }
        await Promise.all(promises);
        const _tNotifyDone = performance.now();

        console.warn(
          `[MEMORY-TX] #${_txId} subs=${session.subscribers.size} | mount=${
            (_tMount - _t0).toFixed(1)
          }ms spaceTx=${(_tSpaceTx - _tMount).toFixed(1)}ms notify=${
            (_tNotifyDone - _tNotifyStart).toFixed(1)
          }ms | total=${(_tNotifyDone - _t0).toFixed(1)}ms`,
        );

        return result;
      },
    );
  });
};

export const mount = async (
  session: Session,
  subject: Subject,
): Promise<Result<MountedSpace, ConnectionError>> => {
  return await traceAsync("memory.mount", async (span) => {
    addMemoryAttributes(span, {
      operation: "mount",
      space: subject,
    });

    const space = session.spaces.get(subject);
    if (space) {
      span.setAttribute("memory.mount.cache", "hit");
      return { ok: space };
    } else {
      span.setAttribute("memory.mount.cache", "miss");

      // Detect if store path is a file (has extension) or directory
      const isFile = Path.extname(session.store.pathname) !== "";

      // If store is a file: use it directly (e.g., /data/spaces/xyz/5/space.db)
      // If store is a directory: create per-space files (e.g., /cache/memory/did:key:z6Mkr4....sqlite)
      const spaceUrl = isFile
        ? session.store
        : new URL(`./${subject}.sqlite`, session.store);

      const result = await Space.open({
        url: spaceUrl,
      });

      if (result.error) {
        return result;
      }

      const replica = result.ok as MountedSpace;
      session.spaces.set(subject, replica);
      span.setAttribute("memory.spaces_count", session.spaces.size);
      return { ok: replica };
    }
  });
};

export interface ServiceOptions {
  serviceDid: DID;
}

export interface Options extends ServiceOptions {
  store: URL;
}

export const open = async (
  options: Options,
): AsyncResult<Memory, ConnectionError> => {
  return await traceAsync("memory.open", async (span) => {
    addMemoryAttributes(span, { operation: "open" });
    span.setAttribute("memory.store_url", options.store.toString());

    try {
      if (options.store.protocol === "file:") {
        // Check if path has a file extension (single-file mode) or is a directory
        const isFile = Path.extname(options.store.pathname) !== "";

        if (isFile) {
          // Ensure parent directory exists for single-file mode
          const parentDir = Path.dirname(options.store.pathname);
          await FS.ensureDir(Path.toFileUrl(parentDir));
        } else {
          // Ensure directory exists for directory mode
          await FS.ensureDir(options.store);
        }
      }
      return { ok: await new Memory(options) };
    } catch (cause) {
      return { error: Error.connection(options.store, cause as SystemError) };
    }
  });
};

/**
 * Creates an ephemeral memory session. It will not persist
 * anything and it's primary use is in testing.
 */
export const emulate = (options: ServiceOptions) =>
  new Memory({
    ...options,
    store: new URL("memory://"),
  });

export const close = async (session: Session) => {
  return await traceAsync("memory.close", async (span) => {
    addMemoryAttributes(span, { operation: "close" });
    span.setAttribute("memory.spaces_count", session.spaces.size);
    span.setAttribute("memory.subscriber_count", session.subscribers.size);

    const promises = [];
    for (const replica of session.spaces.values()) {
      promises.push(replica.close());
    }

    for (const subscriber of session.subscribers) {
      promises.push(subscriber.close());
    }

    const results = await Promise.all(promises);
    const result = results.find((result) => result?.error);
    return result ?? { ok: {} };
  });
};
