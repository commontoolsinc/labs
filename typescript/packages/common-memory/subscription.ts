import {
  MemorySpace,
  Transaction,
  Brief,
  SubscriptionQuery,
  Query,
  QueryResult,
  SubscriberCommand,
  SubscriptionCommand,
  Selector,
  SubscriptionController,
} from "./interface.ts";

interface Memory {
  query(source: Query): QueryResult;
}

export interface Session extends SubscriptionController {
  controller: ReadableStreamDefaultController<SubscriptionCommand> | undefined;
  memory: Memory;
  watched: Set<string>;
}

class Subscription implements Session, SubscriptionController {
  controller: ReadableStreamDefaultController<SubscriptionCommand> | undefined;
  readable: ReadableStream<SubscriptionCommand>;
  writable: WritableStream<SubscriberCommand>;
  constructor(public memory: Memory, public watched: Set<string>) {
    this.readable = new ReadableStream<SubscriptionCommand>({
      start: (controller) => this.connect(controller),
      cancel: () => this.cancel(),
    });
    this.writable = new WritableStream<SubscriberCommand>({
      write: (command) => this.perform(command),
      close: () => this.close(),
      abort: () => this.close(),
    });
  }

  connect(controller: ReadableStreamDefaultController<SubscriptionCommand>) {
    this.controller = controller;
  }

  get open() {
    return !!this.controller;
  }

  async perform(command: SubscriberCommand) {
    if (command.watch) {
      await watch(this, command.watch);
    }
    if (command.unwatch) {
      await unwatch(this, command.unwatch);
    }
  }

  transact(transaction: Transaction) {
    return transact(this, transaction);
  }
  brief(source: Brief) {
    return brief(this, source);
  }

  async watch(source: SubscriptionQuery) {
    await watch(this, source);
    return this;
  }

  async unwatch(source: SubscriptionQuery) {
    await unwatch(this, source);
    return this;
  }

  cancel() {
    return cancel(this);
  }
  abort() {
    return cancel(this);
  }

  close() {
    return close(this);
  }
}

const transact = (session: Session, transaction: Transaction) => {
  if (match(transaction, session.watched)) {
    publish(session, { transact: transaction });
  }
};

export const match = (transaction: Transaction, watched: Set<string>) => {
  for (const [of, attributes] of Object.entries(transaction.args.changes)) {
    for (const [the, changes] of Object.entries(attributes)) {
      for (const change of Object.values(changes)) {
        // If `change == true` we simply confirm that state has not changed
        // so we don't need to notify those subscribers.
        if (change !== true) {
          const watches =
            watched.has(formatAddress(transaction.sub, { the, of })) ||
            watched.has(formatAddress(transaction.sub, { the })) ||
            watched.has(formatAddress(transaction.sub, { of })) ||
            watched.has(formatAddress(transaction.sub, {}));

          if (watches) {
            return true;
          }
        }
      }
    }
  }
  return false;
};

const brief = (session: Session, brief: Brief) => publish(session, { brief: brief });

const publish = (session: Session, command: SubscriptionCommand) => {
  if (session.controller) {
    session.controller.enqueue(command);
  } else {
    console.warn("Subscription is cancelled, not integrating change", change);
  }
};

export const open = (memory: Memory) => new Subscription(memory, new Set());

export const cancel = (session: Session) => {
  if (session.controller) {
    session.controller = undefined;
  }
};

export const close = (session: Session) => {
  if (session.controller) {
    session.controller.close();
    cancel(session);
  }
};

export const channels = function* (space: MemorySpace, selector: Selector) {
  const all = [["_", {}]] as const;
  const entities = Object.entries(selector);
  for (const [of, attributes] of entities.length > 0 ? entities : all) {
    const selector = Object.entries(attributes);
    for (const [the] of selector.length > 0 ? selector : all) {
      yield formatAddress(space, { the, of });
    }
  }
};

export const watch = async (session: Session, source: SubscriptionQuery) => {
  const {
    sub: space,
    args: { select },
  } = source;

  for (const channel of channels(space, select)) {
    if (!session.watched.has(channel)) {
      session.watched.add(channel);
      const result = await session.memory.query(source);
      if (result.error) {
        return result;
      } else {
        session.brief({
          sub: source.sub,
          args: {
            selector: select,
            selection: result.ok,
          },
        });
      }
    }
  }

  return { ok: {} };
};

export const unwatch = (session: Session, source: SubscriptionQuery) => {
  const {
    sub: space,
    args: { select },
  } = source;

  const all = [["_", {}]] as const;
  const selector = Object.entries(select);
  for (const [of, attributes] of selector.length > 0 ? selector : all) {
    const selector = Object.entries(attributes);
    for (const [the] of selector.length > 0 ? selector : all) {
      const channel = formatAddress(space, { the, of });

      session.watched.delete(channel);
    }
  }

  return { ok: {} };
};

export const formatAddress = (
  space: MemorySpace,
  { of = "_", the = "_" }: { the?: string; of?: string },
) => `watch:///${space}/${of}/${the}`;
