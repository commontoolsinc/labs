import {
  Selector,
  SubjectSpace,
  Transaction,
  Brief,
  SubscriptionQuery,
  Query,
  QueryResult,
  SubscriberCommand,
  SubscriptionCommand,
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

interface SubscriptionSession {
  memory: Memory;

  queries: Set<string>;
}

const transact = (session: Session, transaction: Transaction) => {
  if (match(session, transaction)) {
    publish(session, { transact: transaction });
  }
};

const match = (session: Session, source: Transaction) => {
  for (const [the, entities] of Object.entries(source.args.changes)) {
    for (const [of, changes] of Object.entries(entities)) {
      for (const change of Object.values(changes)) {
        // If `change.is === {}` we simply confirm that state has not changed
        // so we don't need to notify those subscribers.
        if (change == null || change.is != undefined) {
          const watches =
            session.watched.has(formatAddress(source.sub, { the, of })) ||
            session.watched.has(formatAddress(source.sub, { the })) ||
            session.watched.has(formatAddress(source.sub, { of })) ||
            session.watched.has(formatAddress(source.sub, {}));

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
    throw new Error("Subscription is cancelled");
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

export const watch = async (session: Session, source: SubscriptionQuery) => {
  const {
    sub: space,
    args: { selector },
  } = source;

  const channel = formatAddress(space, selector);

  if (!session.watched.has(channel)) {
    session.watched.add(channel);
    const result = await session.memory.query(source);
    if (result.error) {
      return result;
    } else {
      session.brief({
        sub: source.sub,
        args: {
          selector: source.args.selector,
          selection: result.ok,
        },
      });
    }
  }

  return { ok: {} };
};

export const unwatch = (session: Session, source: SubscriptionQuery) => {
  const {
    sub: space,
    args: { selector },
  } = source;

  const channel = formatAddress(space, selector);

  session.watched.delete(channel);
};

export const formatAddress = (space: SubjectSpace, { of = "_", the = "_" }: Selector) =>
  `watch:///${space}/${of}/${the}`;
