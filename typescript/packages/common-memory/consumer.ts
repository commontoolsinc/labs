import {
  The,
  MemorySpace,
  Query,
  Transaction,
  Entity,
  DID,
  Selection,
  ProviderCommand,
  ConsumerInvocationFor,
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
  Abilities,
  Invocation,
  InvocationURL,
  TransactionResult,
  UCAN,
  ConsumerCommandInvocation,
  ConsumerCommandFor,
  Command,
  InferOf,
  Proto,
  Signer,
  Clock,
  UTCUnixTimestampInSeconds,
  Seconds,
  Selector,
  Changes,
  Cause,
} from "./interface.ts";
import { refer } from "./reference.ts";
import * as Socket from "./socket.ts";
import * as ChangesBuilder from "./changes.ts";
import * as Fact from "./fact.ts";
import * as Access from "./access.ts";
import * as Subscription from "./subscription.ts";

export * from "./interface.ts";
export { ChangesBuilder };

export const connect = ({
  address,
  as,
  clock,
  ttl,
}: {
  address: URL;
  as: Signer;
  clock?: Clock;
  ttl?: Seconds;
}) =>
  open({
    as,
    clock,
    ttl,
    session: Socket.from(new WebSocket(address)) as ProviderSession<Protocol>,
  });

export const open = ({
  as,
  session,
  clock,
  ttl,
}: {
  as: Signer;
  session: ProviderSession<Protocol>;
  clock?: Clock;
  ttl?: Seconds;
}) => {
  const consumer = create({ as, clock, ttl });
  session.readable.pipeThrough(consumer).pipeTo(session.writable);
  return consumer;
};

export const create = ({ as, clock, ttl }: { as: Signer; clock?: Clock; ttl?: Seconds }) =>
  new MemoryConsumerSession(as, clock, ttl);

class MemoryConsumerSession<Space extends MemorySpace, MemoryProtocol extends Protocol<Space>>
  extends TransformStream
  // <
  //   // ProviderCommand<Protocol>,
  //   InferProtocol<Protocol>,
  //   // UCAN<ConsumerCommandInvocation<Protocol>>
  //   unknown
  // >
  implements ConsumerSession<MemoryProtocol>, MemorySession<Space>
{
  static clock: Clock = {
    now(): UTCUnixTimestampInSeconds {
      return (Date.now() / 1000) | 0;
    },
  };
  /**
   * Default TTL is 1 hour.
   */
  static ttl = 60 * 60;
  controller:
    | TransformStreamDefaultController<UCAN<ConsumerCommandInvocation<MemoryProtocol>>>
    | undefined;
  invocations: Map<
    InvocationURL<Reference<Invocation>>,
    Job<Abilities<MemoryProtocol>, MemoryProtocol>
  > = new Map();
  constructor(
    public as: Signer,
    public clock: Clock = MemoryConsumerSession.clock,
    public ttl: Seconds = MemoryConsumerSession.ttl,
  ) {
    let controller:
      | undefined
      | TransformStreamDefaultController<UCAN<ConsumerCommandInvocation<MemoryProtocol>>>;
    super({
      start: (control) => {
        controller = control;
      },
      transform: (command) => this.receive(command as ProviderCommand<MemoryProtocol>),
      cancel: () => this.cancel(),
      flush: () => this.close(),
    });
    this.controller = controller;
  }
  send(command: UCAN<ConsumerCommandInvocation<MemoryProtocol>>) {
    this.controller?.enqueue(command);
  }
  receive(command: ProviderCommand<MemoryProtocol>) {
    const id = command.of;
    if (command.the === "task/return") {
      command;
      const invocation = this.invocations.get(id);
      this.invocations.delete(id);
      invocation?.return(command.is as {});
    }
    // If it is an effect it can be for one specific subscription, yet we may
    // have other subscriptions that will be affected. There for we simply
    // pass effect to each one and they can detect if it concerns them.
    // ℹ️ We could optimize this in the future and try indexing subscriptions
    // so we don't have to broadcast to all.
    else if (command.the === "task/effect") {
      for (const [, invocation] of this.invocations) {
        invocation.perform(command.is);
      }
    }
  }

  invoke<Ability extends string>(command: ConsumerCommandFor<Ability, MemoryProtocol>) {
    const invocation = ConsumerInvocation.create(
      this.as.did(),
      command as Command<Ability, InferOf<MemoryProtocol>>,
      this.clock.now(),
      this.ttl,
    );
    this.execute(invocation);
    return invocation;
  }

  async execute<Ability extends string>(invocation: ConsumerInvocation<Ability, MemoryProtocol>) {
    const { error, ok: authorization } = await Access.authorize([invocation.refer()], this.as);
    if (error) {
      invocation.return({ error });
    } else {
      const url = invocation.toURL();
      const pending = this.invocations.get(url);
      if (pending) {
        invocation.return(pending.promise as unknown as ConsumerResultFor<Ability, MemoryProtocol>);
      } else {
        this.invocations.set(url, invocation as unknown as Job<Ability, MemoryProtocol>);
        this.send({ invocation: invocation.source, authorization } as unknown as UCAN<
          ConsumerCommandInvocation<MemoryProtocol>
        >);
      }
    }
  }
  close() {
    this.controller?.terminate();
  }
  cancel() {}
  abort(invocation: InvocationHandle) {
    this.invocations.delete(invocation.toURL());
  }
  mount<Subject extends Space>(space: Subject): MemorySpaceConsumerSession<Subject> {
    return new MemorySpaceConsumerSession(
      space,
      this as unknown as MemoryConsumerSession<Subject, Protocol<Subject>>,
    );
  }
}

export interface MemorySession<Space extends MemorySpace> {
  mount<Subject extends Space>(space: Subject): MemorySpaceSession<Subject>;
}

export interface MemorySpaceSession<Space extends MemorySpace = MemorySpace> {
  transact(source: Transaction<Space>["args"]): TransactionResult<Space>;
  query(source: Query["args"]): QueryView<Space, Protocol<Space>>;
}

export type { QueryView };

class MemorySpaceConsumerSession<Space extends MemorySpace> implements MemorySpaceSession<Space> {
  constructor(public space: Space, public session: MemoryConsumerSession<Space, Protocol<Space>>) {}
  transact(source: Transaction["args"]) {
    return this.session.invoke({
      cmd: "/memory/transact",
      sub: this.space,
      args: source as Transaction["args"],
    });
  }
  query(source: Query["args"]): QueryView<Space, Protocol<Space>> {
    const query = this.session.invoke({
      cmd: "/memory/query" as const,
      sub: this.space,
      args: source as Query["args"],
    });
    return QueryView.create(this.session, query);
  }
}

interface InvocationHandle {
  toURL(): InvocationURL<Invocation>;
}

interface Job<Ability, Protocol extends Proto> {
  promise: Promise<ConsumerResultFor<Ability, Protocol>>;
  return(input: Await<ConsumerResultFor<Ability, Protocol>>): void;
  perform(effect: ConsumerEffectFor<Ability, Protocol>): void;
}

class ConsumerInvocation<Ability extends The, Protocol extends Proto> {
  promise: Promise<ConsumerResultFor<Ability, Protocol>>;

  return: (input: ConsumerResultFor<Ability, Protocol>) => void;

  #reference: Reference<Invocation>;

  static create<Ability extends The, Protocol extends Proto>(
    as: DID,
    { cmd, sub, args, nonce }: Command<Ability, InferOf<Protocol>>,
    time: UTCUnixTimestampInSeconds,
    ttl: Seconds,
  ) {
    return new this({
      cmd,
      sub,
      args,
      iss: as,
      prf: [],
      iat: time,
      exp: time + ttl,
      ...(nonce ? { nonce } : undefined),
    } as ConsumerInvocationFor<Ability, Protocol>);
  }

  constructor(public source: ConsumerInvocationFor<Ability, Protocol>) {
    this.#reference = refer(source);
    let receive;
    this.promise = new Promise<ConsumerResultFor<Ability, Protocol>>(
      (resolve) => (receive = resolve),
    );
    this.return = receive as typeof receive & {};
  }

  refer() {
    return this.#reference;
  }

  toURL() {
    return `job:${this.refer()}` as InvocationURL<Invocation>;
  }

  then<T, X>(
    onResolve: (value: ConsumerResultFor<Ability, Protocol>) => T | PromiseLike<T>,
    onReject: (reason: any) => X | Promise<X>,
  ) {
    return this.promise.then(onResolve, onReject);
  }

  get sub() {
    return this.source.sub;
  }

  get meta() {
    return this.source.meta;
  }
  get args() {
    return this.source.args;
  }

  perform(effect: ConsumerEffectFor<Ability, Protocol>) {}
}

class QueryView<Space extends MemorySpace, MemoryProtocol extends Protocol<Space>> {
  static create<Space extends MemorySpace, MemoryProtocol extends Protocol<Space>>(
    session: MemoryConsumerSession<Space, MemoryProtocol>,
    invocation: ConsumerInvocation<"/memory/query", MemoryProtocol>,
  ): QueryView<Space, MemoryProtocol> {
    const view: QueryView<Space, MemoryProtocol> = new QueryView(
      session,
      invocation,
      invocation.promise.then((result: any) => {
        if (result.error) {
          return result;
        } else {
          view.selection = result.ok as Selection<InferOf<Protocol>>;
          return { ok: view };
        }
      }),
    );

    return view;
  }
  selection: Selection<Space>;

  constructor(
    public session: MemoryConsumerSession<Space, MemoryProtocol>,
    public invocation: ConsumerInvocation<"/memory/query", MemoryProtocol>,
    public promise: Promise<Result<QueryView<Space, MemoryProtocol>, QueryError | ConnectionError>>,
  ) {
    this.selection = { [this.space]: {} } as Selection<InferOf<Protocol>>;
  }

  get selector() {
    return (this.invocation.args as { select?: Selector }).select as Selector;
  }

  return(selection: Selection<InferOf<Protocol>>) {
    this.selection = selection;
  }

  then<T, X>(
    onResolve: (
      value: Result<QueryView<Space, MemoryProtocol>, QueryError | ConnectionError>,
    ) => T | PromiseLike<T>,
    onReject: (reason: any) => X | Promise<X>,
  ) {
    return this.promise.then(onResolve, onReject);
  }

  get space(): Space {
    return this.invocation.sub as MemorySpace as Space;
  }

  integrate(differential: Changes) {
    const selection = this.selection[this.space];
    for (const [of, attributes] of Object.entries(differential)) {
      for (const [the, changes] of Object.entries(attributes)) {
        for (const [cause, change] of Object.entries(changes)) {
          ChangesBuilder.set(selection, [of], the, { [cause]: change });
        }
      }
    }
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

class QuerySubscriptionInvocation<
  Space extends MemorySpace,
  MemoryProtocol extends Protocol<Space>,
> extends ConsumerInvocation<"/memory/query/subscribe", MemoryProtocol> {
  readable: ReadableStream<Selection<Space>>;
  controller: undefined | ReadableStreamDefaultController<Selection<Space>>;
  patterns: { the?: The; of?: Entity; cause?: Cause }[];

  selection: Selection<Space>;
  constructor(public query: QueryView<Space, MemoryProtocol>) {
    super({
      ...query.invocation.source,
      cmd: "/memory/query/subscribe",
    });

    this.readable = new ReadableStream<Selection<Space>>({
      start: (controller) => this.open(controller),
      cancel: () => this.close().then(),
    });

    this.selection = query.selection;

    this.patterns = [...Subscription.fromSelector(this.selector)];
  }
  get space() {
    return this.query.space;
  }
  get selector() {
    return this.query.selector;
  }

  open(controller: ReadableStreamDefaultController<Selection<Space>>) {
    this.controller = controller;
  }
  async close() {
    this.controller = undefined;
    this.query.session.abort(this);
    const unsubscribe = this.query.session.invoke({
      cmd: "/memory/query/unsubscribe",
      sub: this.sub,
      args: { source: this.toURL() },
    });

    await unsubscribe;
  }
  override perform(transaction: Transaction<Space>) {
    const selection = this.selection[this.sub as MemorySpace as Space];
    // Here we will collect subset of changes that match the query.
    let differential = null;

    for (const [of, attributes] of Object.entries(transaction.args.changes)) {
      for (const [the, changes] of Object.entries(attributes)) {
        const [[cause, change]] = Object.entries(changes);
        if (change !== true) {
          const state = Object.entries(selection?.[of as Entity]?.[the] ?? {});
          const [current] = state.length > 0 ? state[0] : [];
          if (cause !== current) {
            for (const pattern of this.patterns) {
              const match =
                (!pattern.of || pattern.of === of) &&
                (!pattern.the || pattern.the === the) &&
                (!pattern.cause || pattern.cause === cause);

              if (match) {
                differential = differential ?? {};
                ChangesBuilder.set(differential, [of], the, { [cause]: change });
              }
            }
          }
        }
      }
    }

    if (differential) {
      this.query.integrate(differential);
      this.integrate({ [transaction.sub]: differential } as Selection<Space>);
    }

    return { ok: {} };
  }
  integrate(differential: Selection<Space>) {
    this.controller?.enqueue(differential);
  }
}
