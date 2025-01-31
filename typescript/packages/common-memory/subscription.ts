import { Selector, In, ReplicaID, State } from "./interface.ts";
import * as Replica from "./router.ts";

export interface Subscriber {
  integrate(state: In<State>): void;

  close(): void;
}

/**
 * Represents a subscription controller that can be used to add or remove
 * document addresses to the underlying subscription.
 */
export interface Subscription {
  stream: ReadableStream<In<State>>;

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

export interface Session extends Subscriber {
  controller: ReadableStreamDefaultController<In<State>> | undefined;
  channels: Map<string, In<Selector>>;
  replica: Replica.Session;
}

export class TheSubscription implements Session, Subscription, Subscriber {
  controller: ReadableStreamDefaultController<In<State>> | undefined;
  stream: ReadableStream<In<State>>;
  channels: Map<string, In<Selector>> = new Map();
  constructor(public replica: Replica.Session) {
    this.stream = new ReadableStream<In<State>>({
      start: source => {
        this.controller = source;
      },
      cancel: () => {
        this.cancel();
      },
    });
  }

  watch(selectors: In<Selector>) {
    watch(this, selectors);
    return this;
  }

  unwatch(selectors: In<Selector>) {
    unwatch(this, selectors);
    return this;
  }

  integrate(change: In<State>) {
    return integrate(this, change);
  }

  cancel() {
    return cancel(this);
  }

  close() {
    return close(this);
  }
}

export const integrate = (session: Session, change: In<State>) => {
  if (session.controller) {
    session.controller.enqueue(change);
  } else {
    throw new Error("Subscription is cancelled");
  }
};

export const open = (replica: Replica.Session) => new TheSubscription(replica);

export const cancel = (session: Session) => {
  if (session.controller) {
    session.controller = undefined;
    for (const [, address] of session.channels) {
      session.replica.unwatch(address, session);
    }
    session.channels.clear();
  }
};

export const close = (session: Session) => {
  if (session.controller) {
    session.controller.close();
    cancel(session);
  }
};

export const watch = (session: Session, selectors: In<Selector>) => {
  for (const [space, selector] of Object.entries(selectors)) {
    const channel = formatAddress(space, selector);
    if (!session.channels.has(channel)) {
      const address = { [space]: selector };
      session.channels.set(channel, address);
      session.replica.watch(address, session);
    }
  }
};

export const unwatch = (session: Session, selectors: In<Selector>) => {
  for (const [space, selector] of Object.entries(selectors)) {
    const channel = formatAddress(space, selector);
    if (session.channels.has(channel)) {
      session.replica.unwatch({ [space]: selector }, session);
      session.channels.delete(channel);
    }
  }
};

export const formatAddress = (space: ReplicaID, { of, the }: Selector) =>
  `watch://${space}/${of}/${the}`;
