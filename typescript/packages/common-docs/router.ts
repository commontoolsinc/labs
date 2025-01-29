import * as Replica from "./store.ts";
import * as Subscription from "./subscription.ts";
import {
  In,
  Fact,
  Selector,
  Transaction,
  Result,
  AsyncResult,
  QueryError,
  Unclaimed,
  ReplicaID,
  ConflictError,
  TransactionError,
  ConnectionError,
  SystemError,
} from "./interface.ts";

export interface Session {
  transact(
    transaction: In<Transaction>,
  ): AsyncResult<Fact, ConflictError | TransactionError | ConnectionError>;

  query(
    selector: In<Selector>,
  ): AsyncResult<Fact | Unclaimed, QueryError | ConnectionError>;

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
  subscribe(selector: In<Selector>) {
    return subscribe(this, selector);
  }

  transact(transaction: In<Transaction>) {
    return transact(this, transaction);
  }

  query(selector: In<Selector>) {
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
  selector: In<Selector>,
): AsyncResult<Fact | Unclaimed, QueryError | ConnectionError> => {
  const { ok: replica, error } = await resolve(session, selector);
  if (error) {
    return { error };
  }
  return replica.query(selector);
};

export const watch = async (
  session: Model,
  selector: In<Selector>,
  subscriber: Subscription.Subscriber,
) => {
  const channel = Subscription.formatAddress(selector);
  const subscribers = session.subscribers.get(channel);
  if (subscribers) {
    subscribers.add(subscriber);
  } else {
    session.subscribers.set(channel, new Set([subscriber]));
  }

  const result = await query(session, selector);
  if (result.error) {
    return result;
  } else {
    subscriber.integrate(result.ok);
  }
};

export const unwatch = (
  session: Model,
  selector: In<Selector>,
  subscriber: Subscription.Subscriber,
) => {
  const channel = Subscription.formatAddress(selector);
  const subscribers = session.subscribers.get(channel);
  if (subscribers) {
    subscribers.delete(subscriber);
  }
};

export const transact = async (
  session: Model,
  transaction: In<Transaction>,
): Promise<
  Result<Fact, ConflictError | TransactionError | ConnectionError>
> => {
  const fact = transaction.assert ?? transaction.retract;
  const { ok: replica, error } = await resolve(session, transaction);
  if (error) {
    return { error };
  }

  const result = await replica.transact(transaction);
  if (result.error) {
    return result;
  } else {
    const channel = Subscription.formatAddress({
      in: transaction.in,
      of: fact.of,
      the: fact.the,
    });

    const subscribers = session.subscribers.get(channel);
    if (subscribers) {
      const promises = [];
      for (const subscriber of subscribers) {
        promises.push(subscriber.integrate(result.ok));
      }
      await Promise.all(promises);
    }
  }

  return result;
};

const resolve = async (
  session: Model,
  route: { in: ReplicaID },
): Promise<Result<Replica.Session, ConnectionError>> => {
  const replica = session.repositories.get(route.in);
  if (replica) {
    return { ok: replica };
  } else {
    const result = await Replica.open({
      url: new URL(`./${route.in}.sqlite`, session.store),
    });

    if (result.error) {
      return result;
    }
    const replica = result.ok as Replica.Session;
    session.repositories.set(route.in, replica);
    return { ok: replica };
  }
};

export interface Options {
  store: URL;
}

export const open = async (options: Options): AsyncResult<Router, never> => {
  return { ok: await new Router(options) };
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
  const result = results.find(result => result?.error);
  return result ?? { ok: {} };
};
