import * as Space from "./space.ts";
import * as Subscription from "./subscription.ts";
import * as Error from "./error.ts";
import * as FS from "jsr:@std/fs";
import {
  Transaction,
  Result,
  AsyncResult,
  Query,
  ConnectionError,
  SystemError,
  MemorySpace as Subject,
  MemorySession,
  SpaceSession,
  Subscriber,
  SubscriptionController,
  SubscribeResult,
  TransactionResult,
  QueryResult,
} from "./interface.ts";
export * from "./interface.ts";

interface Session {
  store: URL;
  subscriptions: Set<SubscriptionController>;
  spaces: Map<string, SpaceSession>;

  memory: MemorySession;
}

export class Memory implements Session, MemorySession {
  store: URL;
  ready: Promise<unknown>;
  constructor(
    options: Options,
    public subscriptions: Set<SubscriptionController> = new Set(),
    public spaces: Map<Subject, SpaceSession> = new Map(),
  ) {
    this.store = options.store;
    this.ready = Promise.resolve();
  }

  get memory() {
    return this;
  }

  /**
   * Runs task one at a time, this works around some bug in deno sqlite bindings
   * which seems to cause problems if query and transaction happen concurrently.
   */
  async perform<Out>(task: () => Promise<Out>): Promise<Out> {
    const result = this.ready.finally().then(task);
    this.ready = result.finally();
    await this.ready;
    return await result;
  }

  subscribe(subscriber: Subscriber): SubscribeResult {
    return this.perform(() => subscribe(this, subscriber));
  }

  transact(transaction: Transaction): TransactionResult {
    return this.perform(() => transact(this, transaction));
  }

  query(source: Query): QueryResult {
    return this.perform(() => query(this, source));
  }

  close() {
    return this.perform(() => close(this));
  }
}

export const subscribe = async (session: Session, subscriber: Subscriber) => {
  try {
    const subscription = await Subscription.open(session.memory);
    session.subscriptions.add(subscription);
    subscriber.readable.pipeThrough(subscription).pipeTo(subscriber.writable);

    return { ok: {} };
  } catch (cause) {
    return { error: cause as SystemError };
  }
};

export const query = async (session: Session, query: Query) => {
  const { ok: space, error } = await mount(session, query.sub);
  if (error) {
    return { error };
  }

  return space.query(query);
};

export const transact = async (session: Session, transaction: Transaction) => {
  const { ok: space, error } = await mount(session, transaction.sub);
  if (error) {
    return { error };
  }

  const result = space.transact(transaction);

  if (result.error) {
    return result;
  } else {
    // Notify all the relevant subscribers.
    const promises = [];
    for (const subscription of session.subscriptions) {
      if (subscription.open) {
        promises.push(subscription.transact(transaction));
      } else {
        session.subscriptions.delete(subscription);
      }
    }
    await Promise.all(promises);
  }

  return result;
};

const mount = async (
  session: Session,
  subject: Subject,
): Promise<Result<SpaceSession, ConnectionError>> => {
  const space = session.spaces.get(subject);
  if (space) {
    return { ok: space };
  } else {
    const result = await Space.open({
      url: new URL(`./${subject}.sqlite`, session.store),
    });

    if (result.error) {
      return result;
    }
    const replica = result.ok as SpaceSession;
    session.spaces.set(subject, replica);
    return { ok: replica };
  }
};

export interface Options {
  store: URL;
}

export const open = async (options: Options): AsyncResult<MemorySession, ConnectionError> => {
  try {
    if (options.store.protocol === "file:") {
      await FS.ensureDir(options.store);
    }
    return { ok: await new Memory(options) };
  } catch (cause) {
    return { error: Error.connection(options.store, cause as SystemError) };
  }
};

export const close = async (session: Session) => {
  const promises = [];
  for (const replica of session.spaces.values()) {
    promises.push(replica.close());
  }

  for (const subscription of session.subscriptions) {
    promises.push(subscription.close());
  }

  const results = await Promise.all(promises);
  const result = results.find((result) => result?.error);
  return result ?? { ok: {} };
};
