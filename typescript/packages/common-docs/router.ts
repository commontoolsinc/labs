import {
  PushError,
  Result,
  Address,
  Transaction,
  RepositoryID,
} from "./lib.ts";
import { refer } from "merkle-reference";
import * as Replica from "./store.ts";
import * as Subscription from "./subscription.ts";

export type TransactionError = PushError;

export type TransactionResult = Result<Commit, TransactionError>;

export type RoutedTransaction = {
  [route: string]: Replica.Transaction;
};
export interface Session {
  transact();
}

export interface Transactor {
  transact(transaction: Transaction): Promise<TransactionResult>;
}

export interface Model {
  store: URL;
  subscribers: Map<string, Set<Subscription.Subscriber>>;
  repositories: Map<string, Replica.Session>;
}

export interface Session {
  watch(address: Address, subscriber: Subscription.Subscriber): void;
  unwatch(address: Address, subscriber: Subscription.Subscriber): void;
}

export class Replica {
  store: URL;
  constructor(
    options: Options,
    public subscribers: Map<string, Set<Subscription.Subscriber>> = new Map(),
    public repositories: Map<RepositoryID, Replica.Session> = new Map(),
  ) {
    this.store = options.store;
  }
  subscribe(address: Address) {
    return subscribe(this, address);
  }

  transact(transaction: Transaction) {
    return transact(this, transaction);
  }

  query(selector: Address) {
    return query(this, selector);
  }

  watch(address: Address, subscriber: Subscription.Subscriber) {
    return watch(this, address, subscriber);
  }
  unwatch(address: Address, subscriber: Subscription.Subscriber) {
    return unwatch(this, address, subscriber);
  }
}

export const subscribe = (session: Session, address: Address) =>
  Subscription.open(session).watch(address);

export const query = (session: Model, selector: Address) => {
  const repository = session.repositories.get(selector.from);
  if (repository) {
    return repository.query(selector);
  } else {
    return {
      ok: {
        ...Replica.IMPLICIT,
        this: selector.this,
      },
    };
  }
};

export const watch = (
  session: Model,
  address: Address,
  subscriber: Subscription.Subscriber,
) => {
  const channel = Subscription.formatAddress(address);
  const subscribers = session.subscribers.get(channel);
  if (subscribers) {
    subscribers.add(subscriber);
  } else {
    session.subscribers.set(channel, new Set([subscriber]));
  }

  const result = query(session, address);
  subscriber.transact({
    assert: result.ok
      ? { of: address.this, is: result.ok, was: { "#": result.ok["#"] } }
      : { of: address.this, is: Replica.IMPLICIT, was: Replica.IMPLICIT },
  });
};

export const unwatch = (
  session: Model,
  address: Address,
  subscriber: Subscription.Subscriber,
) => {
  const channel = Subscription.formatAddress(address);
  const subscribers = session.subscribers.get(channel);
  if (subscribers) {
    subscribers.delete(subscriber);
  }
};

export const transact = async (session: Model, transaction: Transaction) => {
  const address = transaction.assert ?? transaction.retract;
  let repository = session.repositories.get(address.replica);
  if (!repository) {
    const result = await Replica.open({
      url: new URL(`./address.replica.sqlite`, session.store),
    });
    repository = result.ok as Replica.Session;
    session.repositories.set(address.replica, repository);
  }

  const result = await repository.transact(transaction);
  if (result.error) {
    return result;
  } else if (result.ok.before.version !== result.ok.after.version) {
    const channel = Subscription.formatAddress(address);
    const subscribers = session.subscribers.get(channel);
    if (subscribers) {
      const promises = [];
      for (const subscriber of subscribers) {
        promises.push(subscriber.transact(transaction));
      }
      await Promise.all(promises);
    }
  }

  return result;
};

export interface Options {
  store: URL;
}

export const open = async (options: Options) => {
  return await new Replica(options);
};
