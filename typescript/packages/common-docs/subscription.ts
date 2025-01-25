import { Address, Transaction } from "./lib.ts";
import * as Replica from "./replica.ts";

export interface Subscriber {
  transact(transaction: Transaction): void;
}

/**
 * Represents a subscription controller that can be used to add or remove
 * document addresses to the underlying subscription.
 */
export interface SubscriptionSession extends Subscriber {
  /**
   * Add a new address to be observed.
   */
  watch(address: Address): void;

  /**
   * Removes an address from this subscription.
   */
  unwatch(address: Address): void;

  /**
   * Close the underlying subscription.
   */
  close(): void;
}

export class Subscription implements SubscriptionSession {
  controller: ReadableStreamDefaultController<Transaction> | undefined;
  stream: ReadableStream<Transaction>;
  channels: Map<string, Address> = new Map();
  constructor(public replica: Replica.Session) {
    this.stream = new ReadableStream<Transaction>({
      start: source => {
        this.controller = source;
      },
      cancel: () => {
        this.close();
      },
    });
  }

  watch(address: Address) {
    return watch(this, address);
  }

  unwatch(address: Address) {
    return unwatch(this, address);
  }

  transact(transaction: Transaction) {
    return transact(this, transaction);
  }

  close() {
    return close(this);
  }
}

export const transact = (
  subscription: Subscription,
  transaction: Transaction,
) => {
  if (subscription.controller) {
    subscription.controller.enqueue(transaction);
  } else {
    throw new Error("Subscription is cancelled");
  }
};

export const open = (replica: Replica.Session) => new Subscription(replica);

export const close = (subscription: Subscription) => {
  if (subscription.controller) {
    subscription.controller = undefined;
    for (const [, address] of subscription.channels) {
      subscription.replica.unwatch(address, subscription);
    }
    subscription.channels.clear();
  }
};

export const watch = (subscription: Subscription, address: Address) => {
  const channel = formatAddress(address);
  if (!subscription.channels.has(channel)) {
    subscription.channels.set(channel, address);
    subscription.replica.watch(address, subscription);
  }

  return subscription;
};

export const unwatch = (subscription: Subscription, address: Address) => {
  const channel = formatAddress(address);
  if (subscription.channels.has(channel)) {
    subscription.replica.unwatch(address, subscription);
    subscription.channels.delete(channel);
  }

  return subscription;
};

export const formatAddress = (address: Address) =>
  `${address.from}/${address.of}`;
