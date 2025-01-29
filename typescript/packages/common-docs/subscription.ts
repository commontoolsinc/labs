import { Selector, In, Fact, Unclaimed } from "./interface.ts";
import * as Replica from "./router.ts";

export type State = Fact | Unclaimed;

export interface Subscriber {
  integrate(state: State): void;

  close(): void;
}

/**
 * Represents a subscription controller that can be used to add or remove
 * document addresses to the underlying subscription.
 */
export interface SubscriptionSession extends Subscriber {
  stream: ReadableStream<State>;
  /**
   * Add a new address to be observed.
   */
  watch(address: In<Selector>): void;

  /**
   * Removes an address from this subscription.
   */
  unwatch(address: In<Selector>): void;

  /**
   * Close the underlying subscription.
   */
  close(): void;
}

export class Subscription implements SubscriptionSession {
  controller: ReadableStreamDefaultController<State> | undefined;
  stream: ReadableStream<State>;
  channels: Map<string, In<Selector>> = new Map();
  constructor(public replica: Replica.Session) {
    this.stream = new ReadableStream<State>({
      start: source => {
        this.controller = source;
      },
      cancel: () => {
        this.cancel();
      },
    });
  }

  watch(address: In<Selector>) {
    return watch(this, address);
  }

  unwatch(address: In<Selector>) {
    return unwatch(this, address);
  }

  integrate(state: State) {
    return integrate(this, state);
  }

  cancel() {
    return cancel(this);
  }

  close() {
    return close(this);
  }
}

export const integrate = (subscription: Subscription, state: State) => {
  if (subscription.controller) {
    subscription.controller.enqueue(state);
  } else {
    throw new Error("Subscription is cancelled");
  }
};

export const open = (replica: Replica.Session) => new Subscription(replica);

export const cancel = (subscription: Subscription) => {
  if (subscription.controller) {
    subscription.controller = undefined;
    for (const [, address] of subscription.channels) {
      subscription.replica.unwatch(address, subscription);
    }
    subscription.channels.clear();
  }
};

export const close = (subscription: Subscription) => {
  if (subscription.controller) {
    subscription.controller.close();
    cancel(subscription);
  }
};

export const watch = (subscription: Subscription, address: In<Selector>) => {
  const channel = formatAddress(address);
  if (!subscription.channels.has(channel)) {
    subscription.channels.set(channel, address);
    subscription.replica.watch(address, subscription);
  }

  return subscription;
};

export const unwatch = (subscription: Subscription, selector: In<Selector>) => {
  const channel = formatAddress(selector);
  if (subscription.channels.has(channel)) {
    subscription.replica.unwatch(selector, subscription);
    subscription.channels.delete(channel);
  }

  return subscription;
};

export const formatAddress = (address: In<Selector>) =>
  `watch://${address.in}/${address.of}/${address.the}`;
