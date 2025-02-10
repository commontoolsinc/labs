import * as Replica from "./store.ts";
import * as Subscription from "./subscription.ts";
import * as Error from "./error.ts";
import * as FS from "jsr:@std/fs";
import {
  In,
  Fact,
  Selector,
  Instruction,
  Result,
  AsyncResult,
  QueryError,
  Unclaimed,
  ReplicaID,
  ConflictError,
  TransactionError,
  ConnectionError,
  SystemError,
  ListError,
} from "./interface.ts";
import { ListResult } from "./store.ts";
export * from "./interface.ts";

export interface Session {
  transact(
    transaction: In<Instruction>,
  ): AsyncResult<Fact, ConflictError | TransactionError | ConnectionError>;

  query(
    selector: In<Partial<Selector>>,
  ): AsyncResult<Fact | Unclaimed | Unclaimed[], QueryError | ListError | ConnectionError>;

  subscribe(address: In<Selector>): Subscription.Subscription;

  watch(address: In<Selector>, subscriber: Subscription.Subscriber): void;
  unwatch(address: In<Selector>, subscriber: Subscription.Subscriber): void;

  close(): AsyncResult<{}, SystemError>;
}

export interface Model {
  store: URL;
  subscribers: Map<string, Set<Subscription.Subscriber>>;
  repositories: Map<string, Replica.Session>;
}

export class Router implements Session {
  store: URL;
  constructor(
    options: Options,
    public subscribers: Map<string, Set<Subscription.Subscriber>> = new Map(),
    public repositories: Map<ReplicaID, Replica.Session> = new Map(),
  ) {
    this.store = options.store;
  }
  subscribe(selector: In<Selector>): Subscription.Subscription {
    return subscribe(this, selector);
  }

  transact(transaction: In<Instruction>) {
    return transact(this, transaction);
  }

  query(selector: In<Partial<Selector>>) {
    return query(this, selector);
  }

  watch(selector: In<Selector>, subscriber: Subscription.Subscriber) {
    return watch(this, selector, subscriber);
  }
  unwatch(selector: In<Selector>, subscriber: Subscription.Subscriber) {
    return unwatch(this, selector, subscriber);
  }

  close() {
    return close(this);
  }
}

export const subscribe = (session: Session, selector: In<Selector>) =>
  Subscription.open(session).watch(selector);

export const query = async (
  session: Model,
  selectors: In<Partial<Selector>>,
): AsyncResult<Fact | Unclaimed | Unclaimed[], ListError | QueryError | ConnectionError> => {
  const [[route, selector]] = Object.entries(selectors);
  const { ok: replica, error } = await resolve(session, route);
  if (error) {
    return { error };
  }

  if (selector?.the && selector?.of) {
    return replica.query({ the: selector.the, of: selector.of });
  } else {
    return replica.list(selector);
  }
};

export const list = async (
  session: Model,
  queries: In<Partial<Selector>>,
): AsyncResult<ListResult[], ListError | ConnectionError> => {
  const [[route, query]] = Object.entries(queries);
  const { ok: replica, error } = await resolve(session, route);
  if (error) {
    return { error };
  }

  return replica.list(query);
};

export const watch = async (
  session: Model,
  selectors: In<Selector>,
  subscriber: Subscription.Subscriber,
) => {
  for (const [space, selector] of Object.entries(selectors)) {
    const channel = Subscription.formatAddress(space, selector);
    const subscribers = session.subscribers.get(channel);
    if (subscribers) {
      subscribers.add(subscriber);
    } else {
      session.subscribers.set(channel, new Set([subscriber]));
    }

    const { ok: replica, error } = await resolve(session, space);
    if (error) {
      return { error };
    }

    const result = await replica.query(selector);
    if (result.error) {
      return result;
    } else {
      subscriber.integrate({ [space]: result.ok });
    }
  }
};

export const unwatch = (
  session: Model,
  selectors: In<Selector>,
  subscriber: Subscription.Subscriber,
) => {
  for (const [route, selector] of Object.entries(selectors)) {
    const channel = Subscription.formatAddress(route, selector);
    const subscribers = session.subscribers.get(channel);
    if (subscribers) {
      subscribers.delete(subscriber);
    }
  }
};

export const transact = async (
  session: Model,
  transactions: In<Instruction>,
): Promise<Result<Fact, ConflictError | TransactionError | ConnectionError>> => {
  const [[route, transaction]] = Object.entries(transactions);
  const fact = transaction.assert ?? transaction.retract;
  const { ok: replica, error } = await resolve(session, route);
  if (error) {
    return { error };
  }

  const result = await replica.transact(transaction);
  if (result.error) {
    return result;
  } else {
    const change = { [route]: result.ok };
    const channel = Subscription.formatAddress(route, fact);

    const subscribers = session.subscribers.get(channel);
    if (subscribers) {
      const promises = [];
      for (const subscriber of subscribers) {
        promises.push(subscriber.integrate(change));
      }
      await Promise.all(promises);
    }
  }

  return result;
};

const resolve = async (
  session: Model,
  route: ReplicaID,
): Promise<Result<Replica.Session, ConnectionError>> => {
  const replica = session.repositories.get(route);
  if (replica) {
    return { ok: replica };
  } else {
    const result = await Replica.open({
      url: new URL(`./${route}.sqlite`, session.store),
    });

    if (result.error) {
      return result;
    }
    const replica = result.ok as Replica.Session;
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
