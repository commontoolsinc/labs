import {
  Abilities,
  AuthorizationError,
  Await,
  Cause,
  Changes,
  Clock,
  Command,
  Commit,
  ConnectionError,
  ConsumerCommandFor,
  ConsumerCommandInvocation,
  ConsumerEffectFor,
  ConsumerInvocationFor,
  ConsumerResultFor,
  DID,
  Entity,
  Fact,
  InferOf,
  Invocation,
  InvocationURL,
  MemorySpace,
  Proto,
  Protocol,
  ProviderChannel,
  ProviderCommand,
  Query,
  QueryError,
  Reference,
  Result,
  Revision,
  SchemaContext,
  SchemaPathSelector,
  SchemaQuery,
  SchemaSelector,
  Seconds,
  Selection,
  Selector,
  Signer,
  The,
  Transaction,
  TransactionResult,
  UCAN,
  UTCUnixTimestampInSeconds,
} from "./interface.ts";
import { refer } from "./reference.ts";
import * as Socket from "./socket.ts";
import * as ChangesBuilder from "./changes.ts";
import * as FactModule from "./fact.ts";
import * as Access from "./access.ts";
import * as Subscription from "./subscription.ts";
import { toStringStream } from "./ucan.ts";
import { fromStringStream } from "./receipt.ts";
import * as Settings from "./settings.ts";
export * from "./interface.ts";
import { toRevision } from "./commit.ts";
import { isObj } from "../utils/src/isObj.ts";

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
}) => {
  const { readable, writable } = Socket.from<string, string>(
    new WebSocket(address),
  );
  const invocations = toStringStream();
  invocations.readable.pipeTo(writable);

  return open({
    as,
    clock,
    ttl,
    session: {
      writable: invocations.writable,
      readable: readable.pipeThrough(fromStringStream()),
    },
  });
};

export const open = ({
  as,
  session,
  clock,
  ttl,
}: {
  as: Signer;
  session: ProviderChannel<Protocol>;
  clock?: Clock;
  ttl?: Seconds;
}) => {
  const consumer = create({ as, clock, ttl });
  session.readable.pipeThrough(consumer).pipeTo(
    session.writable as WritableStream<Protocol>,
  );
  return consumer;
};

export const create = (
  { as, clock, ttl }: { as: Signer; clock?: Clock; ttl?: Seconds },
) => new MemoryConsumerSession(as, clock, ttl);

class MemoryConsumerSession<
  Space extends MemorySpace,
  MemoryProtocol extends Protocol<Space>,
> extends TransformStream<
  ProviderCommand<Protocol>,
  UCAN<ConsumerCommandInvocation<Protocol>>
> implements MemorySession<Space> {
  controller:
    | TransformStreamDefaultController<
      UCAN<ConsumerCommandInvocation<MemoryProtocol>>
    >
    | undefined;
  invocations: Map<
    InvocationURL<Reference<Invocation>>,
    Job<Abilities<MemoryProtocol>, MemoryProtocol>
  > = new Map();

  constructor(
    public as: Signer,
    public clock: Clock = Settings.clock,
    public ttl: Seconds = Settings.ttl,
  ) {
    let controller:
      | undefined
      | TransformStreamDefaultController<
        UCAN<ConsumerCommandInvocation<MemoryProtocol>>
      >;
    super({
      start: (control) => {
        controller = control as typeof this.controller;
      },
      transform: (command) =>
        this.receive(command as ProviderCommand<MemoryProtocol>),
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
      const invocation = this.invocations.get(id);
      if (
        invocation !== undefined && "args" in invocation &&
        isObj(invocation.args) && "subscribe" in invocation.args &&
        invocation.args.subscribe
      ) {
        console.log("Skipping delete");
      } else {
        this.invocations.delete(id);
      }
      invocation?.return(command.is as NonNullable<unknown>);
    } // If it is an effect it can be for one specific subscription, yet we may
    // have other subscriptions that will be affected. There for we simply
    // pass effect to each one and they can detect if it concerns them.
    // ℹ️ We could optimize this in the future and try indexing subscriptions
    // so we don't have to broadcast to all.
    else if (command.the === "task/effect") {
      const invocation = this.invocations.get(id);
      invocation?.perform(command.is);

      // TODO: revisit
      // for (const [, invocation] of this.invocations) {
      //   invocation.perform(command.is);
      // }
    }
  }

  invoke<Ability extends string>(
    command: ConsumerCommandFor<Ability, MemoryProtocol>,
  ) {
    const invocation = ConsumerInvocation.create(
      this.as.did(),
      command as Command<Ability, InferOf<MemoryProtocol>>,
      this.clock.now(),
      this.ttl,
    );
    this.execute(invocation);
    return invocation;
  }

  getInvocation<Ability extends string>(
    command: ConsumerCommandFor<Ability, MemoryProtocol>,
  ) {
    const invocation = ConsumerInvocation.create(
      this.as.did(),
      command as Command<Ability, InferOf<MemoryProtocol>>,
      this.clock.now(),
      this.ttl,
    );
    return invocation;
  }

  async execute<Ability extends string>(
    invocation: ConsumerInvocation<Ability, MemoryProtocol>,
  ) {
    const { error, ok: authorization } = await Access.authorize([
      invocation.refer(),
    ], this.as);
    if (error) {
      invocation.return({ error });
    } else {
      const url = invocation.toURL();
      const pending = this.invocations.get(url);
      if (pending) {
        invocation.return(
          pending.promise as unknown as ConsumerResultFor<
            Ability,
            MemoryProtocol
          >,
        );
      } else {
        this.invocations.set(
          url,
          invocation as unknown as Job<Ability, MemoryProtocol>,
        );
        this.send(
          { invocation: invocation.source, authorization } as unknown as UCAN<
            ConsumerCommandInvocation<MemoryProtocol>
          >,
        );
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
  mount<Subject extends Space>(
    space: Subject,
  ): MemorySpaceConsumerSession<Subject> {
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
  query(
    source: Query["args"] | SchemaQuery["args"],
  ): QueryView<Space, Protocol<Space>>;
}

export type { QueryView };

class MemorySpaceConsumerSession<Space extends MemorySpace>
  implements MemorySpaceSession<Space> {
  constructor(
    public space: Space,
    public session: MemoryConsumerSession<Space, Protocol<Space>>,
  ) {}
  transact(source: Transaction["args"]) {
    return this.session.invoke({
      cmd: "/memory/transact",
      sub: this.space,
      args: source,
    });
  }
  query(
    source: Query["args"] | SchemaQuery["args"],
  ): QueryView<Space, Protocol<Space>> {
    if ("select" in source) {
      const query = this.session.invoke({
        cmd: "/memory/query" as const,
        sub: this.space,
        args: source,
      });
      return QueryView.create(this.session, query);
    } else { // selectSchema
      const query = this.session.invoke({
        cmd: "/memory/graph/query" as const,
        sub: this.space,
        args: source,
      });
      return QueryView.create(this.session, query);
    }
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
    this.return = receive as typeof receive & NonNullable<unknown>;
  }

  refer() {
    return this.#reference;
  }

  toURL() {
    return `job:${this.refer()}` as InvocationURL<Invocation>;
  }

  then<T, X>(
    onResolve: (
      value: ConsumerResultFor<Ability, Protocol>,
    ) => T | PromiseLike<T>,
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

class QueryView<
  Space extends MemorySpace,
  MemoryProtocol extends Protocol<Space>,
> {
  static create<
    Space extends MemorySpace,
    MemoryProtocol extends Protocol<Space>,
  >(
    session: MemoryConsumerSession<Space, MemoryProtocol>,
    invocation:
      | ConsumerInvocation<"/memory/query", MemoryProtocol>
      | ConsumerInvocation<"/memory/graph/query", MemoryProtocol>,
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
  selector: Selector | SchemaSelector;

  constructor(
    public session: MemoryConsumerSession<Space, MemoryProtocol>,
    public invocation:
      | ConsumerInvocation<"/memory/query", MemoryProtocol>
      | ConsumerInvocation<"/memory/graph/query", MemoryProtocol>,
    public promise: Promise<
      Result<QueryView<Space, MemoryProtocol>, QueryError | ConnectionError>
    >,
  ) {
    invocation.perform = (
      effect:
        | ConsumerEffectFor<"/memory/query", MemoryProtocol>
        | ConsumerEffectFor<"/memory/graph/query", MemoryProtocol>,
    ) => this.perform(effect as any);
    this.selection = { [this.space]: {} } as Selection<InferOf<Protocol>>;
    this.selector = ("select" in this.invocation.args)
      ? (this.invocation.args as { select?: Selector }).select as Selector
      : (this.invocation.args as { selectSchema?: Selector })
        .selectSchema as SchemaSelector;
  }

  return(selection: Selection<InferOf<Protocol>>) {
    this.selection = selection;
  }

  perform(effect: Selection<Space>) {
    // This effect may not be intended for us, since any effect is sent to all
    // invocations. If not, ignore it.
    console.log("In QueryView.perform", effect);
    if (effect[this.space] && this.space in effect[this.space]) {
      // This is the commit+json subscription, and it's not for us
      console.log("Ignoring", effect);
      return { ok: {} };
    }
    const differential = { ...effect[this.space] } as Selection<Space>;
    this.integrate(differential);
    return { ok: effect };
  }

  then<T, X>(
    onResolve: (
      value: Result<
        QueryView<Space, MemoryProtocol>,
        QueryError | ConnectionError
      >,
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

  get facts(): Revision<Fact>[] {
    return [...FactModule.iterate(this.selection[this.space])];
  }

  // Get the facts returned by the query, together with the associated
  // schema context used to query
  get schemaFacts(): [Revision<Fact>, SchemaContext | undefined][] {
    return this.facts.map((fact) => [fact, this.getSchema(fact)]);
  }

  subscribe() {
    const subscription = new QuerySubscriptionInvocation(this);
    this.session.execute(subscription);

    return subscription;
  }

  // A SchemaSelector query will include results that aren't in the selector
  // Since we already have these results, we don't want to re-fetch them, so
  // make a QueryView available for subscriptions to use that lets us skip
  // that step when we subscribe.
  // TODO: Remove this code when we remove the rest of remote.ts
  includedQueryView(): QueryView<MemorySpace, MemoryProtocol> | undefined {
    const factSelection = this.selection[this.space];
    const subSelector: Selector = {};
    for (const [of, attributes] of Object.entries(factSelection)) {
      if (of === "_" || of in this.selector) {
        continue;
      }
      const entityEntry: Record<The, Record<Cause, any>> = {};
      for (const [the, _causes] of Object.entries(attributes)) {
        entityEntry[the as Entity] = { _: {} };
      }
      subSelector[of as Entity] = entityEntry;
    }
    if (Object.entries(subSelector).length == 0) {
      // Nothing new
      return undefined;
    }
    // If we included any entries in our selection that were not in our
    // selector, create a new QueryView for them, and subscribe to that
    // We pre-populate the query view with the results
    const invocation = this.session.getInvocation({
      cmd: "/memory/query" as const,
      sub: this.space,
      args: { select: subSelector },
    });
    invocation.return(Promise.resolve(this.selection));
    const subQueryView = new QueryView(
      this.session,
      invocation,
      Promise.resolve({ ok: this }),
    );

    subQueryView.selection = this.selection;
    subQueryView.selector = subSelector;
    subQueryView.promise = Promise.resolve({ ok: subQueryView });
    return subQueryView;
  }

  // Get the schema context used to fetch the specified fact.
  // If the fact was included from another fact, it will not have a schemaContext.
  getSchema(fact: Revision<Fact>): SchemaContext | undefined {
    const factSelector = this.selector;
    const attributes = factSelector[fact.of];
    if (attributes !== undefined) {
      const causes = attributes[fact.the] as Record<Cause, SchemaPathSelector>;
      if (causes !== undefined) {
        for (const [_cause, selector] of Object.entries(causes)) {
          return selector.schemaContext;
        }
      }
    }
    return undefined;
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
  override perform(commit: Commit<Space>) {
    if (
      !(this.space in commit) ||
      !("application/commit+json" in commit[this.space])
    ) {
      console.log("QSI ignoring non-commit");
      return { ok: {} };
    }
    const selection = this.selection[this.space];
    // Here we will collect subset of changes that match the query.
    let differential = null;

    const fact = toRevision(commit);

    const { the, of, is } = fact;
    const cause = fact.cause.toString();
    const { transaction, since } = is;
    for (const pattern of this.patterns) {
      const match = (!pattern.of || pattern.of === of) &&
        (!pattern.the || pattern.the === the) &&
        (!pattern.cause || pattern.cause === cause);

      if (match) {
        differential = differential ?? {};
        ChangesBuilder.set(differential, [of], the, {
          [cause]: {
            is,
            since,
          },
        });
      }

      for (const [of, attributes] of Object.entries(transaction.args.changes)) {
        for (const [the, changes] of Object.entries(attributes)) {
          const [[cause, change]] = Object.entries(changes);
          if (change !== true) {
            const state = Object.entries(
              selection?.[of as Entity]?.[the] ?? {},
            );
            const [current] = state.length > 0 ? state[0] : [];
            if (cause !== current) {
              for (const pattern of this.patterns) {
                const match = (!pattern.of || pattern.of === of) &&
                  (!pattern.the || pattern.the === the) &&
                  (!pattern.cause || pattern.cause === cause);

                if (match) {
                  differential = differential ?? {};
                  ChangesBuilder.set(differential, [of], the, {
                    [cause]: { ...change, since },
                  });
                }
              }
            }
          }
        }
      }
    }

    if (differential) {
      this.query.integrate(differential);
      this.integrate({ [this.space]: differential } as Selection<Space>);
    }

    return { ok: {} };
  }
  integrate(differential: Selection<Space>) {
    this.controller?.enqueue(differential);
  }

  getReader() {
    return this.readable.getReader();
  }

  async *[Symbol.asyncIterator]() {
    const reader = this.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        } else {
          yield next.value;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
