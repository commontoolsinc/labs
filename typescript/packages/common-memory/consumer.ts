import {
  MemorySpace,
  Query,
  Transaction,
  Entity,
  Principal,
  Selection,
  ProviderCommand,
  ConsumerCommand,
  ConsumerCommandFor,
  Await,
  QueryError,
  Result,
  ConsumerSession,
  ConsumerResultFor,
  ProviderSession,
  Reference,
  Protocol,
  ConnectionError,
  ConsumerEffectFor,
  InferProtocol,
  Abilities,
  Invocation,
  InvocationURL,
  TransactionResult,
  Subscribe,
} from "./interface.ts";
import { refer } from "./reference.ts";
import * as Socket from "./socket.ts";
import * as Changes from "./changes.ts";
import * as Fact from "./fact.ts";

export * from "./interface.ts";
export { Changes as ChangesBuilder };

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

export const create = ({ as }: { as: Principal }) => new MemoryConsumerSession(as);

class MemoryConsumerSession
  extends TransformStream<ProviderCommand<Protocol>, ConsumerCommand<Protocol>>
  implements ConsumerSession<Protocol>, MemorySession
{
  controller: TransformStreamDefaultController<ConsumerCommand<Protocol>> | undefined;
  invocations: Map<InvocationURL<Reference<Invocation>>, Job<Abilities<Protocol>, Protocol>> =
    new Map();
  constructor(public as: Principal) {
    let controller: undefined | TransformStreamDefaultController<ConsumerCommand<Protocol>>;
    super({
      start: (control) => {
        controller = control;
      },
      transform: (command) => this.receive(command as ProviderCommand<Protocol>),
      cancel: () => this.cancel(),
      flush: () => this.close(),
    });

    this.controller = controller;
  }
  send(command: ConsumerCommand<Protocol>) {
    this.controller?.enqueue(command);
  }
  receive(command: ProviderCommand<Protocol>) {
    const id = command.of;
    if (command.the === "task/return") {
      const invocation = this.invocations.get(id);
      this.invocations.delete(id);
      invocation?.return(command.is);
    } else if (command.the === "task/effect") {
      const invocation = this.invocations.get(id);
      invocation?.perform(command.is);
    }
  }

  execute<Space extends MemorySpace, Ability extends string>(
    invocation: ConsumerInvocation<Space, Ability>,
  ) {
    const command = invocation.toJSON();

    const id = `job:${refer(command)}` as InvocationURL<Reference<Invocation>>;
    const pending = this.invocations.get(id);
    if (!pending) {
      this.invocations.set(id, invocation as unknown as Job<Ability, Protocol>);
      this.send(command as ConsumerCommand<Protocol>);
    } else {
      invocation.return(pending.promise as any);
    }
  }

  close() {
    this.controller?.terminate();
  }
  cancel() {}

  abort<Ability extends Abilities<Protocol>>(
    invocation: InferProtocol<Protocol>[Ability]["Invocation"] & { cmd: Ability },
  ) {
    const command = invocation.toJSON();
    const id = `job:${refer(command)}` as InvocationURL<Reference<Invocation>>;
    this.invocations.delete(id);
  }

  mount<Space extends MemorySpace>(space: Space): MemorySpaceConsumerSession<Space> {
    return new MemorySpaceConsumerSession(space, this);
  }
}

export interface MemorySession {
  mount<Space extends MemorySpace>(space: Space): MemorySpaceSession<Space>;
}

export interface MemorySpaceSession<Space extends MemorySpace = MemorySpace> {
  transact(source: Transaction<Space>["args"]): TransactionResult<Space>;
  query(source: Query["args"]): QueryView<Space>;
}

export type { QueryView };

class MemorySpaceConsumerSession<Space extends MemorySpace> implements MemorySpaceSession<Space> {
  constructor(public space: Space, public session: MemoryConsumerSession) {}
  transact(source: Transaction["args"]) {
    const invocation = new ConsumerInvocation({
      cmd: "/memory/transact",
      iss: this.session.as,
      sub: this.space,
      args: source,
    });

    this.session.execute(invocation);

    return invocation;
  }
  query(source: Query["args"]): QueryView<Space> {
    const invocation = new ConsumerInvocation<Space, "/memory/query">({
      cmd: "/memory/query",
      iss: this.session.as,
      sub: this.space,
      args: source,
    });

    this.session.execute(invocation);

    return QueryView.new(this.session, invocation);
  }
}

interface Job<Ability, Protocol> {
  toJSON(): ConsumerCommand<Protocol>;
  promise: Promise<ConsumerResultFor<Ability, Protocol>>;
  return(input: Await<ConsumerResultFor<Ability, Protocol>>): void;
  perform(effect: ConsumerEffectFor<Ability, Protocol>): void;
}

class ConsumerInvocation<Space extends MemorySpace, Ability extends string> {
  promise: Promise<ConsumerResultFor<Ability, Protocol<Space>>>;
  return: (input: ConsumerResultFor<Ability, Protocol<Space>>) => void;

  constructor(public source: ConsumerCommandFor<Ability, Protocol<Space>>) {
    let receive;
    this.promise = new Promise<ConsumerResultFor<Ability, Protocol<Space>>>(
      (resolve) => (receive = resolve),
    );
    this.return = receive as typeof receive & {};
  }

  then<T, X>(
    onResolve: (value: ConsumerResultFor<Ability, Protocol<Space>>) => T | PromiseLike<T>,
    onReject: (reason: any) => X | Promise<X>,
  ) {
    return this.promise.then(onResolve, onReject);
  }

  perform(effect: ConsumerEffectFor<Ability, Protocol>) {}

  get cmd() {
    return this.source.cmd;
  }
  get iss() {
    return this.source.iss;
  }
  get sub() {
    return this.source.sub;
  }
  get args() {
    return this.source.args;
  }
  get meta() {
    return this.source.meta;
  }
  toJSON(): ConsumerCommand<Protocol<Space>> {
    const { cmd, iss, sub, args, meta } = this.source;
    return {
      cmd,
      iss,
      sub,
      args,
      ...(meta ? { meta } : undefined),
    } as ConsumerCommand<Protocol<Space>>;
  }
}

class QueryView<Space extends MemorySpace> {
  static new<Space extends MemorySpace>(
    session: MemoryConsumerSession,
    invocation: ConsumerInvocation<Space, "/memory/query">,
  ): QueryView<Space> {
    const view: QueryView<Space> = new QueryView(
      session,
      invocation,
      invocation.promise.then((result: any) => {
        if (result.error) {
          return result;
        } else {
          view.selection = result.ok as Selection<Space>;
          return { ok: view };
        }
      }),
    );

    return view;
  }
  selection: Selection<Space>;
  constructor(
    public session: MemoryConsumerSession,
    public invocation: ConsumerInvocation<Space, "/memory/query">,
    public promise: Promise<Result<QueryView<Space>, QueryError | ConnectionError>>,
  ) {
    this.selection = { [this.space]: {} } as Selection<Space>;
  }

  return(selection: Selection<Space>) {
    this.selection = selection;
  }

  then<T, X>(
    onResolve: (
      value: Result<QueryView<Space>, QueryError | ConnectionError>,
    ) => T | PromiseLike<T>,
    onReject: (reason: any) => X | Promise<X>,
  ) {
    return this.promise.then(onResolve, onReject);
  }

  get space() {
    return this.invocation.sub;
  }

  transact(transaction: Transaction<Space>) {
    const selection = this.selection[this.space];
    for (const [of, attributes] of Object.entries(transaction.args.changes)) {
      for (const [the, changes] of Object.entries(attributes)) {
        const [[cause, change]] = Object.entries(changes);
        if (change !== true) {
          const state = Object.entries(selection?.[of as Entity]?.[the] ?? {});
          const [current] = state.length > 0 ? state[0] : [];
          if (cause !== current) {
            Changes.set(selection, [of], the, { [cause]: change });
          }
        }
      }
    }

    return { ok: {} };
  }

  get facts() {
    return [...Fact.iterate(this.selection[this.space])];
  }

  subscribe() {
    const subscription = new QuerySubscriptionInvocation(this);
    this.session.execute(subscription);

    return subscription.readable;
  }
}

class QuerySubscriptionInvocation<Space extends MemorySpace> extends ConsumerInvocation<
  Space,
  "/memory/query/subscribe"
> {
  readable: ReadableStream<Selection<Space>>;
  controller: undefined | ReadableStreamDefaultController<Selection<Space>>;

  selection: Selection<Space>;
  constructor(public query: QueryView<Space>) {
    super({
      cmd: "/memory/query/subscribe",
      iss: query.invocation.iss,
      sub: query.invocation.sub,
      args: query.invocation.args,
      meta: query.invocation.meta,
    });

    this.readable = new ReadableStream<Selection<Space>>({
      start: (controller) => this.open(controller),
      cancel: () => this.close().then(),
    });

    this.selection = query.selection;
  }

  open(controller: ReadableStreamDefaultController<Selection<Space>>) {
    this.controller = controller;
  }
  async close() {
    this.controller = undefined;
    this.query.session.abort(this);
    const invocation = new ConsumerInvocation({
      cmd: "/memory/query/unsubscribe",
      iss: this.iss,
      sub: this.sub,
      args: { source: `job:${refer(this.toJSON())}` as InvocationURL<Reference<Subscribe>> },
    });

    this.query.session.execute(invocation);

    await invocation;
  }
  override perform(transaction: Transaction<Space>) {
    const selection = this.selection[this.sub];
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

    this.query.transact(transaction);

    if (Object.keys(changed).length > 0) {
      this.integrate({ [transaction.sub]: changed } as Selection<Space>);
    }

    return { ok: {} };
  }
  integrate(differential: Selection<Space>) {
    this.controller?.enqueue(differential);
  }
}
