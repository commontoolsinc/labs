import {
  MemorySpace,
  Query,
  Transaction,
  Entity,
  Principal,
  Protocol,
  Selection,
  ProviderCommand,
  ConsumerCommand,
  FactSelection,
  QueryError,
  InferConsumerReturn,
  AsyncResult,
  ConsumerSession,
  ProviderReturn,
  ProviderSession,
  Watch,
} from "./interface.ts";
import { refer } from "./reference.ts";
import * as Socket from "./socket.ts";
import * as Changes from "./changes.ts";
import * as Fact from "./fact.ts";
export const connect = ({ address, as }: { address: URL; as: Principal }) =>
  open({
    as,
    session: Socket.from(new WebSocket(address)) as ProviderSession<Protocol>,
  });

export const open = ({ as, session }: { as: Principal; session: ProviderSession<Protocol> }) => {
  const consumer = new MemoryConsumerSession(as);
  session.readable.pipeThrough(consumer).pipeTo(session.writable);
  return consumer;
};

interface PendingInvocation<T> {
  promise: Promise<T>;
  return: (result: T) => void;
}

class MemoryConsumerSession<Space extends MemorySpace>
  extends TransformStream<ProviderCommand<Protocol<Space>>, ConsumerCommand<Protocol<Space>>>
  implements ConsumerSession<Protocol<Space>>
{
  controller: TransformStreamDefaultController<ConsumerCommand<Protocol<Space>>> | undefined;
  invocations: Map<string, PendingInvocation<ProviderReturn<Protocol<Space>>>> = new Map();
  subscriptions: Map<string, QuerySubscription<Space>> = new Map();
  constructor(public as: Principal) {
    let controller: undefined | TransformStreamDefaultController<ConsumerCommand<Protocol<Space>>>;
    super({
      start: (control) => {
        controller = control;
      },
      transform: (command) => this.receive(command),
      cancel: () => this.cancel(),
      flush: () => this.close(),
    });

    this.controller = controller;
  }
  send(command: ConsumerCommand<Protocol<Space>>) {
    this.controller?.enqueue(command);
  }
  receive(command: ProviderCommand<Protocol<Space>>) {
    const id = command.of.toString();
    if (command.the === "task/return") {
      const invocation = this.invocations.get(id);
      invocation?.return(command.is);
      this.invocations.delete(id);
    } else if (command.the === "task/effect") {
      const subscription = this.subscriptions.get(id);
      subscription?.transact(command.is);
    }
  }

  async subscribe(invocation: Watch): AsyncResult<QuerySubscription<Space>, QueryError> {
    const id = refer(invocation).toString();
    let subscription = this.subscriptions.get(id);
    if (!subscription) {
      const result = await this.perform({
        cmd: "/memory/query",
        iss: this.as,
        sub: invocation.sub,
        args: invocation.args,
      });

      if (result.error) {
        return result;
      } else {
        subscription = new QuerySubscription(this, invocation, result.ok);
        this.subscriptions.set(id, subscription);
        this.send(invocation);
      }
    }

    return { ok: subscription };
  }
  perform<Command extends ConsumerCommand<Protocol<Space>>>(
    command: Command,
  ): Promise<InferConsumerReturn<Protocol<Space>, Command>> {
    const id = refer(command).toString();
    let invocation = this.invocations.get(id);
    if (!invocation) {
      const { promise, succeed } = defer<ProviderReturn<Protocol<Space>>>();
      invocation = { promise, return: succeed };
      this.invocations.set(id, invocation);
      this.send(command);
    }
    return invocation.promise as Promise<InferConsumerReturn<Protocol<Space>, Command>>;
  }
  close() {}
  cancel() {}
  open(controller: TransformStreamDefaultController<ConsumerCommand<Protocol>>) {
    this.controller = controller;
  }

  mount<Subject extends Space>(space: Subject): MemorySpaceConsumerSession<Subject> {
    return new MemorySpaceConsumerSession(space, this as MemoryConsumerSession<Subject>);
  }
}

class MemorySpaceConsumerSession<Space extends MemorySpace> {
  constructor(public space: Space, public session: MemoryConsumerSession<Space>) {}
  transact(source: Transaction["args"]) {
    return this.session.perform({
      cmd: "/memory/transact",
      iss: this.session.as,
      sub: this.space,
      args: source,
    });
  }
  query(source: Query["args"]) {
    return this.session.perform({
      cmd: "/memory/query",
      iss: this.session.as,
      sub: this.space,
      args: source,
    });
  }
  subscribe(query: Watch["args"]): AsyncResult<QuerySubscription<Space>, QueryError> {
    return this.session.subscribe({
      cmd: "/memory/watch",
      iss: this.session.as,
      sub: this.space,
      args: query,
    });
  }
}

class QuerySubscription<Space extends MemorySpace> extends ReadableStream<Selection<Space>> {
  controller: ReadableStreamDefaultController<Selection<Space>> | undefined;
  constructor(
    public session: MemoryConsumerSession<Space>,
    public invocation: Watch,
    public selection: Selection<Space>,
  ) {
    let init: ReadableStreamDefaultController<Selection<Space>> | undefined;
    super({
      start: (controller) => {
        init = controller;
      },
      cancel: async () => {
        this.close();
      },
    });

    this.controller = init;
  }

  async close() {
    this.controller = undefined;
    return await this.session.perform({
      cmd: "/memory/unwatch",
      iss: this.invocation.iss,
      sub: this.invocation.sub,
      args: { source: refer(this.invocation) },
    });
  }

  transact(transaction: Transaction<Space>) {
    const selection = this.selection[transaction.sub];
    const changed = {};
    for (const [of, attributes] of Object.entries(transaction.args.changes)) {
      for (const [the, changes] of Object.entries(attributes)) {
        const [[cause, change]] = Object.entries(changes);
        if (change !== true) {
          const state = Object.entries(selection?.[of as Entity]?.[the] ?? {});
          const [current] = state.length > 0 ? state[0] : [];
          if (cause !== current) {
            Changes.set(changed, [of], the, { [cause]: change });
            Changes.set(selection, [of], the, { [cause]: change });
          }
        }
      }
    }

    if (Object.keys(changed).length > 0) {
      this.integrate({ [transaction.sub]: changed } as Selection<Space>);
    }

    return { ok: {} };
  }

  get facts() {
    return [...Fact.iterate(this.selection[this.invocation.sub as Space])];
  }

  integrate(differential: Selection<Space>) {
    this.controller?.enqueue(differential);
  }
}

const defer = <T>() => {
  let succeed: undefined | Deferred<T>["succeed"];
  let fail: undefined | Deferred<T>["fail"];
  const promise = new Promise<T>((resolve, reject) => {
    succeed = resolve;
    fail = reject;
  });

  return { promise, succeed, fail } as Deferred<T>;
};

type Deferred<T, X extends Error = Error> = {
  promise: Promise<T>;
  succeed: (ok: T) => void;
  fail: (error: X) => void;
};
