import * as Space from "./space.ts";
import * as Error from "./error.ts";
import * as FS from "https://deno.land/std/fs/mod.ts";
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
  SpaceSession,
  Subscriber,
  SubscribeResult,
  SystemError,
  Transaction,
  TransactionResult,
} from "./interface.ts";
export * from "./interface.ts";
import { type DID } from "../identity/src/index.ts";

interface Session {
  store: URL;
  subscribers: Set<Subscriber>;
  spaces: Map<string, SpaceSession>;
}

export class Memory implements Session, MemorySession {
  store: URL;
  ready: Promise<unknown>;
  #serviceDid: DID;

  constructor(
    options: Options,
    public subscribers: Set<Subscriber> = new Set(),
    public spaces: Map<Subject, SpaceSession> = new Map(),
  ) {
    this.store = options.store;
    this.ready = Promise.resolve();
    this.#serviceDid = options.serviceDid;
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
    return await traceAsync("memory.perform", async (span) => {
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

export const subscribe = (session: Session, subscriber: Subscriber) => {
  return traceSync("memory.subscribe", (span) => {
    addMemoryAttributes(span, { operation: "subscribe" });
    session.subscribers.add(subscriber);
    span.setAttribute("memory.subscriber_count", session.subscribers.size);
    return { ok: {} };
  });
};

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
    } else {
      return await traceAsync(
        "memory.notify_subscribers",
        async (notifySpan) => {
          notifySpan.setAttribute(
            "memory.subscriber_count",
            session.subscribers.size,
          );

          const promises = [];
          for (const subscriber of session.subscribers) {
            promises.push(subscriber.commit(result.ok));
          }
          await Promise.all(promises);

          return result;
        },
      );
    }
  });
};

export const mount = async (
  session: Session,
  subject: Subject,
): Promise<Result<SpaceSession, ConnectionError>> => {
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

      const result = await Space.open({
        url: new URL(`./${subject}.sqlite`, session.store),
      });

      if (result.error) {
        return result;
      }

      const replica = result.ok as SpaceSession;
      session.spaces.set(subject, replica);
      span.setAttribute("memory.spaces_count", session.spaces.size);
      return { ok: replica };
    }
  });
};

export interface Options {
  store: URL;
  serviceDid: DID;
}

export const open = async (
  options: Options,
): AsyncResult<Memory, ConnectionError> => {
  return await traceAsync("memory.open", async (span) => {
    addMemoryAttributes(span, { operation: "open" });
    span.setAttribute("memory.store_url", options.store.toString());

    try {
      if (options.store.protocol === "file:") {
        await FS.ensureDir(options.store);
      }
      return { ok: await new Memory(options) };
    } catch (cause) {
      return { error: Error.connection(options.store, cause as SystemError) };
    }
  });
};

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
