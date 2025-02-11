import * as Space from "./space.ts";
import * as Subscription from "./subscription.ts";
import * as Error from "./error.ts";
import * as FS from "jsr:@std/fs";
import {
  Unit,
  Transaction,
  Commit,
  Result,
  AsyncResult,
  QueryError,
  Query,
  Changes,
  State,
  ConflictError,
  TransactionError,
  ConnectionError,
  SystemError,
  Space as Subject,
  Subscription as SubscriptionQuery,
  ListError,
} from "./interface.ts";
import { refer } from "merkle-reference";
export * from "./interface.ts";

export interface Session {
  transact(
    transaction: Transaction,
  ): AsyncResult<Commit, ConflictError | TransactionError | ConnectionError>;

  query(source: Query): AsyncResult<State[], QueryError | ListError | ConnectionError>;

  subscribe(): Subscription.Subscription;

  watch(source: SubscriptionQuery, subscriber: Subscription.Subscriber): void;
  unwatch(source: SubscriptionQuery, subscriber: Subscription.Subscriber): void;

  close(): AsyncResult<Unit, SystemError>;
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

  query(source: Query) {
    return query(this, source);
  }

  watch(source: SubscriptionQuery, subscriber: Subscription.Subscriber) {
    return watch(this, source, subscriber);
  }
  unwatch(source: SubscriptionQuery, subscriber: Subscription.Subscriber) {
    return unwatch(this, source, subscriber);
  }

  close() {
    return close(this);
  }
}

export const subscribe = (session: Session) => Subscription.open(session);

export const query = async (
  session: Model,
  query: Query,
): AsyncResult<State[], ListError | QueryError | ConnectionError> => {
  const { ok: space, error } = await resolve(session, query.sub);
  if (error) {
    return { error };
  }

  return space.query(query);
};

export const watch = async (
  session: Model,
  source: SubscriptionQuery,
  subscriber: Subscription.Subscriber,
) => {
  const { selector } = source.args;
  const channel = Subscription.formatAddress(source.sub, selector);
  const subscribers = session.subscribers.get(channel);
  if (subscribers) {
    subscribers.add(subscriber);
  } else {
    session.subscribers.set(channel, new Set([subscriber]));
  }

  const { ok: space, error } = await resolve(session, source.sub);
  if (error) {
    return { error };
  }

  const result = await space.query(source);
  if (result.error) {
    return result;
  } else {
    const results = result.ok;
    const { the, of } = selector;
    if (results.length === 0) {
      if (the != null && of != null) {
        subscriber.integrate({
          [source.sub]: {
            [the]: {
              [of]: {},
            },
          },
        });
      }
    } else {
      for (const state of results) {
        subscriber.integrate({
          [source.sub]: {
            [state.the]: {
              [state.of]:
                // If `state.is` is undefined it is retraction otherwise it is
                // assertion.
                state.is === undefined
                  ? { [refer({ cause: state.cause }).toString()]: null }
                  : { [state.cause.toString()]: { is: state.is } },
            },
          },
        });
      }
    }
  }
};

export const unwatch = (session: Model, source: Query, subscriber: Subscription.Subscriber) => {
  const channel = Subscription.formatAddress(source.sub, source.args.selector);
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
    const changes: Changes = {};
    for (const [the, entities] of Object.entries(transaction.args.changes)) {
      changes[the] = changes[the] ?? {};
      for (const [of, change] of Object.entries(entities)) {
        changes[the][of] = changes[the][of] ?? {};
        for (const [cause, state] of Object.entries(change)) {
          if (state == null) {
            changes[the][of][cause] = null;
          } else if (changes.is != undefined) {
            changes[the][of][cause] = { is: changes.is };
          }
        }
      }
    }

    for (const subscriber of subscribers(session, transaction)) {
      promises.push(subscriber.integrate({ [transaction.sub]: changes }));
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
