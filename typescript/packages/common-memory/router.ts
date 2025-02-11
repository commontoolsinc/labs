import * as Space from "./space.ts";
import * as Subscription from "./subscription.ts";
import * as Error from "./error.ts";
import * as FS from "jsr:@std/fs";
import {
  In,
  Fact,
  Selector,
  Transaction,
  Commit,
  Result,
  AsyncResult,
  QueryError,
  Query,
  List,
  Unclaimed,
  ConflictError,
  TransactionError,
  ConnectionError,
  SystemError,
  Space as Subject,
  Subscribe,
  ListError,
  Unsubscribe,
} from "./interface.ts";
import { ListResult } from "./space.ts";
export * from "./interface.ts";

export interface Session {
  transact(
    transaction: Transaction,
  ): AsyncResult<Commit, ConflictError | TransactionError | ConnectionError>;

  query(
    query: Query,
  ): AsyncResult<Fact | Unclaimed | Unclaimed[], QueryError | ListError | ConnectionError>;

  subscribe(): Subscription.Subscription;

  watch(command: Subscribe, subscriber: Subscription.Subscriber): void;
  unwatch(command: Unsubscribe, subscriber: Subscription.Subscriber): void;

  close(): AsyncResult<{}, SystemError>;
}

export interface Model {
  store: URL;
  subscribers: Map<string, Set<Subscription.Subscriber>>;
  repositories: Map<string, Space.Session>;
}

export class Router implements Session {
  store: URL;
  constructor(
    options: Options,
    public subscribers: Map<string, Set<Subscription.Subscriber>> = new Map(),
    public repositories: Map<Subject, Space.Session> = new Map(),
  ) {
    this.store = options.store;
  }
  subscribe(): Subscription.Subscription {
    return subscribe(this);
  }

  transact(transaction: Transaction) {
    return transact(this, transaction);
  }

  query(command: Query) {
    return query(this, command);
  }

  watch(command: Subscribe, subscriber: Subscription.Subscriber) {
    return watch(this, command, subscriber);
  }
  unwatch(command: Unsubscribe, subscriber: Subscription.Subscriber) {
    return unwatch(this, command, subscriber);
  }

  close() {
    return close(this);
  }
}

export const subscribe = (session: Session) => Subscription.open(session);

export const query = async (
  session: Model,
  query: Query,
): AsyncResult<Fact | Unclaimed | Unclaimed[], ListError | QueryError | ConnectionError> => {
  const { ok: space, error } = await resolve(session, query.sub);
  if (error) {
    return { error };
  }

  const { selector } = query.args;
  return space.query({ the: selector.the, of: selector.of });
};

export const list = async (
  session: Model,
  command: List,
): AsyncResult<ListResult[], ListError | ConnectionError> => {
  const { ok: space, error } = await resolve(session, command.sub);
  if (error) {
    return { error };
  }

  return space.list(command);
};

export const watch = async (
  session: Model,
  command: Subscribe,
  subscriber: Subscription.Subscriber,
) => {
  const { selector } = command.args;
  const channel = Subscription.formatAddress(command.sub, selector);
  const subscribers = session.subscribers.get(channel);
  if (subscribers) {
    subscribers.add(subscriber);
  } else {
    session.subscribers.set(channel, new Set([subscriber]));
  }

  const { ok: space, error } = await resolve(session, command.sub);
  if (error) {
    return { error };
  }

  const result = await space.query(selector);
  if (result.error) {
    return result;
  } else {
    // TODO: Implement this
    // subscriber.integrate({ [space]: result.ok });
  }
};

export const unwatch = (
  session: Model,
  command: Unsubscribe,
  subscriber: Subscription.Subscriber,
) => {
  const channel = Subscription.formatAddress(command.sub, command.args.selector);
  const subscribers = session.subscribers.get(channel);
  if (subscribers) {
    subscribers.delete(subscriber);
  }
};

export const transact = async (
  session: Model,
  transaction: Transaction,
): Promise<Result<Commit, ConflictError | TransactionError | ConnectionError>> => {
  const { ok: space, error } = await resolve(session, transaction.sub);
  if (error) {
    return { error };
  }

  const result = await space.transact(transaction);
  if (result.error) {
    return result;
  } else {
    // Now go ahead and notify subscribers.
    const promises = [];
    for (const subscriber of subscribers(session, transaction)) {
      promises.push(subscriber.integrate(result.ok));
    }

    await Promise.all(promises);
  }

  return result;
};

/**
 * Returns iterator of subscribers that are affected by the given transaction.
 */
const subscribers = function* (
  session: Model,
  transaction: Transaction,
): Iterable<Subscription.Subscriber> {
  const seen = new Set();
  for (const [the, entities] of Object.entries(transaction.args.changes)) {
    for (const [of, changes] of Object.entries(entities)) {
      for (const change of Object.values(changes)) {
        // If `change.is === {}` we simply confirm that state has not changed
        // so we don't need to notify those subscribers.
        if (change == null || change.is != undefined) {
          const channel = Subscription.formatAddress(transaction.sub, { the, of });
          for (const subscriber of session.subscribers.get(channel) ?? []) {
            if (!seen.has(subscriber)) {
              seen.add(subscriber);
              yield subscriber;
            }
          }
        }
      }
    }
  }
};

const resolve = async (
  session: Model,
  route: Subject,
): Promise<Result<Space.Session, ConnectionError>> => {
  const replica = session.repositories.get(route);
  if (replica) {
    return { ok: replica };
  } else {
    const result = await Space.open({
      url: new URL(`./${route}.sqlite`, session.store),
    });

    if (result.error) {
      return result;
    }
    const replica = result.ok as Space.Session;
    session.repositories.set(route, replica);
    return { ok: replica };
  }
};

export interface Options {
  store: URL;
}

export const open = async (options: Options): AsyncResult<Router, ConnectionError> => {
  try {
    if (options.store.protocol === "file:") {
      await FS.ensureDir(options.store);
    }
    return { ok: await new Router(options) };
  } catch (cause) {
    return { error: Error.connection(options.store, cause as SystemError) };
  }
};

export const close = async (router: Router) => {
  const promises = [];
  for (const replica of router.repositories.values()) {
    promises.push(replica.close());
  }

  for (const subscribers of router.subscribers.values()) {
    for (const subscriber of subscribers) {
      promises.push(subscriber.close());
    }
  }

  const results = await Promise.all(promises);
  const result = results.find((result) => result?.error);
  return result ?? { ok: {} };
};
