import { Selector, Space, Changes, Subscription as SubscriptionQuery } from "./interface.ts";
import * as Replica from "./router.ts";

export interface Subscriber {
  integrate(delta: { [space: Space]: Changes }): void;

  close(): void;
}

/**
 * Represents a subscription controller that can be used to add or remove
 * document addresses to the underlying subscription.
 */
export interface Subscription {
  stream: ReadableStream<{ [space: Space]: Changes }>;

  /**
   * Add a new address to be observed.
   */
  watch(address: SubscriptionQuery): void;

  /**
   * Removes an address from this subscription.
   */
  unwatch(address: SubscriptionQuery): void;

  /**
   * Close the underlying subscription.
   */
  close(): void;
}

export interface Session extends Subscriber {
  controller: ReadableStreamDefaultController<{ [space: Space]: Changes }> | undefined;
  channels: Map<string, SubscriptionQuery>;
  replica: Replica.Session;
}

export class TheSubscription implements Session, Subscription, Subscriber {
  controller: ReadableStreamDefaultController<{ [space: Space]: Changes }> | undefined;
  stream: ReadableStream<{ [space: Space]: Changes }>;
  channels: Map<string, SubscriptionQuery> = new Map();
  constructor(public replica: Replica.Session) {
    this.stream = new ReadableStream<{ [space: Space]: Changes }>({
      start: (source) => {
        this.controller = source;
      },
      cancel: () => {
        this.cancel();
      },
    });
  }

  watch(source: SubscriptionQuery) {
    watch(this, source);
    return this;
  }

  unwatch(source: SubscriptionQuery) {
    unwatch(this, source);
    return this;
  }

  integrate(changes: { [space: Space]: Changes }) {
    return integrate(this, changes);
  }

  cancel() {
    return cancel(this);
  }

  close() {
    return close(this);
  }
}

export const integrate = (session: Session, changes: { [space: Space]: Changes }) => {
  if (session.controller) {
    session.controller.enqueue(changes);
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

export const watch = (session: Session, source: SubscriptionQuery) => {
  const {
    sub: space,
    args: { selector },
  } = source;

  const channel = formatAddress(space, selector);
  if (!session.channels.has(channel)) {
    session.channels.set(channel, source);
    session.replica.watch(source, session);
  }
};

export const unwatch = (session: Session, source: SubscriptionQuery) => {
  const {
    sub: space,
    args: { selector },
  } = source;

  const channel = formatAddress(space, selector);
  if (session.channels.has(channel)) {
    session.replica.unwatch(source, session);
    session.channels.delete(channel);
  }
};

export const formatAddress = (space: Space, { of = "_", the = "_" }: Selector) =>
  `watch:///${space}/${of}/${the}`;
