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
  DEFAULT_MEMORY_VERSION,
  MemorySession,
  MemorySpace as Subject,
  type MemoryVersion,
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
const V1_MEMORY_VERSION: MemoryVersion = "v1";

const v1OnlyEntryPointMessage = (
  entryPoint: string,
  memoryVersion: MemoryVersion,
) =>
  `${entryPoint} is a legacy memory/v1 entry point and does not support memoryVersion=${memoryVersion}. Use the memory/v2 engine instead.`;

const toSystemError = (message: string): SystemError => ({
  name: "SystemError",
  code: 500,
  message,
});

interface Session {
  store: URL;
  memoryVersion: MemoryVersion;
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
    if (options.memoryVersion === "v2") {
      throw new globalThis.Error(
        v1OnlyEntryPointMessage("memory.Memory", "v2"),
      );
    }
    this.store = options.store;
    this.memoryVersion = options.memoryVersion ?? V1_MEMORY_VERSION;
    this.ready = Promise.resolve();
    this.#serviceDid = options.serviceDid;
  }
  memoryVersion: MemoryVersion;
  clone() {
    return new Memory(
      {
        store: this.store,
        serviceDid: this.serviceDid(),
        memoryVersion: this.memoryVersion,
      },
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

  /**
   * Runs task one at a time, this works around some bug in deno sqlite bindings
   * which seems to cause problems if query and transaction happen concurrently.
   */
  async perform<Out>(task: () => Promise<Out>): Promise<Out> {
    return await traceAsync("memory.perform", async (_span) => {
      const result = this.ready.finally().then(task);
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
  options?: Space.SelectSchemaOptions,
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
      options,
    );
  });
};

export const transact = async (session: Session, transaction: Transaction) => {
  return await traceAsync("memory.transact", async (span) => {
    addMemoryAttributes(span, {
      operation: "transact",
      space: transaction.sub,
    });

    if (transaction.args?.changes) {
      addChangesAttributes(span, transaction.args.changes);
    }

    const { ok: space, error } = await mount(session, transaction.sub);
    if (error) {
      span.setAttribute("mount.status", "error");
      return { error };
    }

    span.setAttribute("mount.status", "success");
    const result = space.transact(transaction);

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

        const promises = [];
        // Copy here, in case a subscriber modifies the set of subscribers
        for (const subscriber of [...session.subscribers]) {
          promises.push(subscriber.commit(result.ok, labels));
        }
        await Promise.all(promises);

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
      const spaceUrl = resolveSpaceStoreUrl(
        session.store,
        subject,
        session.memoryVersion,
      );

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
  memoryVersion?: MemoryVersion;
}

export interface Options extends ServiceOptions {
  store: URL;
}

export const resolveSpaceStoreUrl = (
  store: URL,
  subject: Subject,
  memoryVersion: MemoryVersion = DEFAULT_MEMORY_VERSION,
): URL => {
  const isFile = Path.extname(store.pathname) !== "";

  if (!isFile) {
    if (memoryVersion === "v2") {
      return new URL(`./v2/${subject}.sqlite`, store);
    }

    return new URL(`./${subject}.sqlite`, store);
  }

  if (memoryVersion === "v2") {
    const ext = Path.extname(store.pathname);
    const stem = ext === ""
      ? store.pathname
      : store.pathname.slice(0, -ext.length);
    return new URL(`${stem}.v2${ext}`, store);
  }

  return store;
};

export const open = async (
  options: Options,
): AsyncResult<Memory, ConnectionError> => {
  return await traceAsync("memory.open", async (span) => {
    addMemoryAttributes(span, { operation: "open" });
    span.setAttribute("memory.store_url", options.store.toString());

    if (options.memoryVersion === "v2") {
      return {
        error: Error.connection(
          options.store,
          toSystemError(v1OnlyEntryPointMessage("memory.open", "v2")),
        ),
      };
    }

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
    memoryVersion: options.memoryVersion ?? V1_MEMORY_VERSION,
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
