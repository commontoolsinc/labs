import type {
  Abilities,
  Authorization,
  AuthorizationError,
  Await,
  CauseString,
  Clock,
  Command,
  ConnectionError,
  ConsumerCommandFor,
  ConsumerCommandInvocation,
  ConsumerEffectFor,
  ConsumerInvocationFor,
  ConsumerResultFor,
  DID,
  EnhancedCommit,
  Fact,
  FactSelection,
  InferOf,
  Invocation,
  InvocationURL,
  MemorySpace,
  MIME,
  OfTheCause,
  Proto,
  Protocol,
  ProviderChannel,
  ProviderCommand,
  Query,
  QueryArgs,
  QueryError,
  Reference,
  Result,
  Revision,
  SchemaPathSelector,
  SchemaQuery,
  SchemaQueryArgs,
  SchemaSelector,
  Seconds,
  Select,
  SelectAll,
  Selection,
  Selector,
  Signer,
  StorableDatum,
  Transaction,
  TransactionResult,
  UCAN,
  URI,
  UTCUnixTimestampInSeconds,
} from "./interface.ts";
import { fromJSON, refer } from "./reference.ts";
import * as Socket from "./socket.ts";
import {
  getSelectorRevision,
  iterate,
  setEmptyObj,
  setRevision,
} from "./selection.ts";
import * as FactModule from "./fact.ts";
import * as Access from "./access.ts";
import * as Subscription from "./subscription.ts";
import { toStringStream } from "./ucan.ts";
import { fromStringStream } from "./receipt.ts";
import * as Settings from "./settings.ts";
export * from "./interface.ts";
import { toRevision } from "./commit.ts";
import { getLogger } from "@commontools/utils/logger";

const logger = getLogger("memory-consumer", {
  enabled: true,
  level: "info",
});

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
> implements MemoryConsumer<Space> {
  controller:
    | TransformStreamDefaultController<
      UCAN<ConsumerCommandInvocation<MemoryProtocol>>
    >
    | undefined;
  invocations: Map<
    InvocationURL<Reference<Invocation>>,
    Job<Abilities<MemoryProtocol>, MemoryProtocol>
  > = new Map();

  // Promises that are resolved when the message is at the front of the queue
  private sendQueue: PromiseWithResolvers<void>[] = [];

  // Batch signing state: accumulate invocations and sign them together
  private pendingBatch: {
    invocation: ConsumerInvocation<string, MemoryProtocol>;
    queueEntry: PromiseWithResolvers<void>;
  }[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private batchStartTime: number | null = null;
  private lastFlushTime: number | null = null;
  private cancelled = false;

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
      transform: (command) => {
        try {
          return this.receive(command as ProviderCommand<MemoryProtocol>);
        } catch (error) {
          logger.error(
            "stream-error",
            () => ["TransformStream transform error:", error],
          );
          logger.error(
            "stream-error",
            () => ["Failed command:", JSON.stringify(command)],
          );
          throw error;
        }
      },
      flush: () => {
        try {
          return this.close();
        } catch (error) {
          logger.error(
            "stream-error",
            () => ["TransformStream flush error:", error],
          );
          throw error;
        }
      },
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
        invocation !== undefined &&
        !invocation.return(command.is as NonNullable<unknown>)
      ) {
        this.invocations.delete(id);
      }
    } // If it is an effect it can be for one specific subscription, yet we may
    // have other subscriptions that will be affected.
    // We can't just send one message over, since the client needs to know
    // about which extra objects are needed for that specific subscription.
    // There's a chance we'll send the same object over more than once because
    // of this (in particular, this is almost guaranteed by the cache that
    // maintains a subscription to every object in the cache).
    // For now, I think this is the best approach, but we can use the since
    // fields to remove these later.
    else if (command.the === "task/effect") {
      const invocation = this.invocations.get(id);
      invocation?.perform(command.is);
    }
  }

  invoke<Ability extends string>(
    command: ConsumerCommandFor<Ability, MemoryProtocol>,
    options?: { immediate?: boolean },
  ) {
    const invocation = ConsumerInvocation.create(
      this.as.did(),
      command as Command<Ability, InferOf<MemoryProtocol>>,
      this.clock.now(),
      this.ttl,
    );
    this.execute(invocation, options);
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
    options?: { immediate?: boolean },
  ) {
    if (this.cancelled) {
      // deno-lint-ignore no-explicit-any
      invocation.return({ error: new Error("session cancel") } as any);
      return;
    }
    const queueEntry = Promise.withResolvers<void>();
    // put it in the queue immediately -- messages are sent in the order
    // they are executed, regardless of authorization timing
    this.sendQueue.push(queueEntry);

    this.pendingBatch.push({
      invocation: invocation as ConsumerInvocation<string, MemoryProtocol>,
      queueEntry,
    });

    if (this.batchStartTime === null) {
      this.batchStartTime = Date.now();
    }

    // Immediate flag or first invocation in a quiet period: flush now
    const inCoalesceWindow = this.lastFlushTime !== null &&
      (Date.now() - this.lastFlushTime) < Settings.batchCoalesceMs;
    if (
      options?.immediate ||
      (this.pendingBatch.length === 1 && !inCoalesceWindow)
    ) {
      await this.flushBatch();
      return;
    }

    const elapsed = Date.now() - this.batchStartTime;
    if (
      this.pendingBatch.length >= Settings.batchMaxSize ||
      elapsed >= Settings.batchMaxAccumulateMs
    ) {
      await this.flushBatch();
    } else {
      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(
        () => this.flushBatch(),
        Settings.batchDebounceMs,
      );
    }
  }

  private async flushBatch() {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.batchStartTime = null;
    this.lastFlushTime = Date.now();

    const batch = this.pendingBatch;
    this.pendingBatch = [];
    if (batch.length === 0) return;

    const refs = batch.map(({ invocation }) => invocation.refer());
    // If authorize throws, convert to a Result error so executeAuthorized
    // can propagate it to each invocation through the normal path.
    const authorizationResult = await Access.authorize(refs, this.as)
      .catch((error: unknown) => ({
        error: error instanceof Error ? error : new Error(String(error)),
      } as Awaited<ReturnType<typeof Access.authorize>>));

    for (let i = 0; i < batch.length; i++) {
      const { invocation, queueEntry } = batch[i];
      if (queueEntry !== this.sendQueue[0]) {
        try {
          await queueEntry.promise;
        } catch {
          // Session was cancelled — fail remaining invocations whose
          // promises would otherwise hang forever.
          for (let j = i; j < batch.length; j++) {
            batch[j].invocation.return(
              // deno-lint-ignore no-explicit-any
              { error: new Error("session cancel") } as any,
            );
          }
          return;
        }
        if (
          this.sendQueue.length === 0 || queueEntry !== this.sendQueue[0]
        ) {
          for (let j = i; j < batch.length; j++) {
            batch[j].invocation.return(
              // deno-lint-ignore no-explicit-any
              { error: new Error("session cancel") } as any,
            );
          }
          return;
        }
      }
      try {
        this.executeAuthorized(authorizationResult, invocation);
      } finally {
        this.sendQueue.shift();
        if (this.sendQueue.length > 0) {
          this.sendQueue[0].resolve();
        }
      }
    }
  }

  private executeAuthorized<
    Ability extends string,
    Access extends Reference[],
  >(
    authorizationResult: Result<Authorization<Access[number]>, Error>,
    invocation: ConsumerInvocation<Ability, MemoryProtocol>,
  ) {
    const { error, ok: authorization } = authorizationResult;
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

  /** Immediately flush any debounced batch without waiting for the timer. */
  flush() {
    return this.flushBatch();
  }

  close() {
    this.cancel();
    this.controller?.terminate();
  }
  cancel() {
    this.cancelled = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.batchStartTime = null;
    this.lastFlushTime = null;
    // Fail pending batch invocations so their promises resolve (with error)
    // rather than hanging forever.
    const pendingBatch = this.pendingBatch;
    this.pendingBatch = [];
    for (const queueEntry of [...this.sendQueue]) {
      // Suppress unhandled rejection for entries that may not yet be awaited
      // (e.g. batched entries whose flushBatch timer hasn't fired)
      queueEntry.promise.catch(() => {});
      queueEntry.reject(new Error("session cancel"));
    }
    this.sendQueue = [];
    // Return pending invocations last — their .then() handlers may trigger
    // new execute() calls, which will bail out via the cancelled flag.
    for (const { invocation } of pendingBatch) {
      // deno-lint-ignore no-explicit-any
      invocation.return({ error: new Error("session cancel") } as any);
    }
  }
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
  as: Signer;
  mount<Subject extends Space>(space: Subject): MemorySpaceSession<Subject>;
}

export interface MemoryConsumer<Space extends MemorySpace>
  extends
    MemorySession<Space>,
    TransformStream<
      ProviderCommand<Protocol>,
      UCAN<ConsumerCommandInvocation<Protocol>>
    > {
  as: Signer;
  cancel(): void;
}

export interface MemorySpaceSession<Space extends MemorySpace = MemorySpace> {
  as: Signer;
  flush(): Promise<void>;
  transact(
    source: Transaction<Space>["args"],
    options?: { immediate?: boolean },
  ): TransactionResult<Space>;
  query(
    source: Query["args"] | SchemaQuery["args"],
  ): QueryView<Space, Protocol<Space>>;
}

export type { QueryView };

class MemorySpaceConsumerSession<Space extends MemorySpace>
  implements MemorySpaceSession<Space> {
  as: Signer;
  constructor(
    public space: Space,
    public session: MemoryConsumerSession<Space, Protocol<Space>>,
  ) {
    this.as = session.as;
  }
  flush() {
    return this.session.flush();
  }
  transact(source: Transaction["args"], options?: { immediate?: boolean }) {
    return this.session.invoke({
      cmd: "/memory/transact",
      sub: this.space,
      args: source,
    }, options);
  }
  query(
    source: Query["args"] | SchemaQuery["args"],
  ): QueryView<Space, Protocol<Space>> {
    const selectSchema = ("select" in source)
      ? MemorySpaceConsumerSession.asSelectSchema(source)
      : source;
    // Queries are always awaited by the caller, so flush immediately
    // rather than debouncing (batching queries adds latency with no benefit).
    const query = this.session.invoke({
      cmd: "/memory/graph/query" as const,
      sub: this.space,
      args: selectSchema,
    }, { immediate: true });
    return QueryView.create(this.session, query);
  }

  private static asSelectSchema(queryArg: QueryArgs): SchemaQueryArgs {
    const selectSchema: Select<
      URI,
      Select<MIME, Select<CauseString, SchemaPathSelector>>
    > = {};
    for (const [of, attributes] of Object.entries(queryArg.select)) {
      const entityEntry: Select<
        MIME,
        Select<CauseString, SchemaPathSelector>
      > = {};
      selectSchema[of as URI | SelectAll] = entityEntry;
      let attrEntries = Object.entries(attributes);
      // A Selector may not have a "the", but SchemaSelector needs all three levels
      if (attrEntries.length === 0) {
        attrEntries = [["_", {}]];
      }
      for (const [the, causes] of attrEntries) {
        const attributeEntry: Select<CauseString, SchemaPathSelector> = {};
        entityEntry[the as MIME | SelectAll] = attributeEntry;
        // A Selector may not have a cause, but SchemaSelector needs all three levels
        let causeEntries = Object.entries(causes);
        if (causeEntries.length === 0) {
          causeEntries = [["_", {}]];
        }
        for (const [cause, _selector] of causeEntries) {
          const causeEntry: SchemaPathSelector = {
            path: [],
            schema: false,
          };
          attributeEntry[cause as CauseString | SelectAll] = causeEntry;
        }
      }
    }
    return {
      selectSchema: selectSchema,
      ...queryArg.since ? { since: queryArg.since } : {},
    };
  }
}

interface InvocationHandle {
  toURL(): InvocationURL<Invocation>;
}

interface Job<Ability, Protocol extends Proto> {
  promise: Promise<ConsumerResultFor<Ability, Protocol>>;
  // Return false to remove listener
  return(input: Await<ConsumerResultFor<Ability, Protocol>>): boolean;
  perform(effect: ConsumerEffectFor<Ability, Protocol>): void;
}

class ConsumerInvocation<Ability extends string, Protocol extends Proto> {
  promise: Promise<ConsumerResultFor<Ability, Protocol>>;

  return: (input: ConsumerResultFor<Ability, Protocol>) => boolean;

  source: ConsumerInvocationFor<Ability, Protocol>;

  #reference: Reference<Invocation>;

  static create<Ability extends string, Protocol extends Proto>(
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

  constructor(source: ConsumerInvocationFor<Ability, Protocol>) {
    // JSON.parse(JSON.stringify) is used to strip `undefined` values and ensure consistent serialization
    this.source = JSON.parse(JSON.stringify(source));
    this.#reference = refer(this.source);
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
    onReject: (reason: unknown) => X | Promise<X>,
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

  perform(_effect: ConsumerEffectFor<Ability, Protocol>) {}
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
      // FIXME: typing
      // deno-lint-ignore no-explicit-any
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
      Result<
        QueryView<Space, MemoryProtocol>,
        QueryError | AuthorizationError | ConnectionError
      >
    >,
  ) {
    invocation.perform = (
      effect:
        | ConsumerEffectFor<"/memory/query", MemoryProtocol>
        | ConsumerEffectFor<"/memory/graph/query", MemoryProtocol>,
    ) => this.perform(effect as Selection<Space>);
    this.selection = { [this.space]: {} } as Selection<InferOf<Protocol>>;
    this.selector = ("select" in this.invocation.args)
      ? (this.invocation.args as { select?: Selector }).select as Selector
      : (this.invocation.args as { selectSchema?: Selector })
        .selectSchema as SchemaSelector;
  }

  return(selection: Selection<InferOf<Protocol>>) {
    this.selection = selection;
    return !("subscribe" in this.selector && this.selector.subscribe === true);
  }

  perform(effect: Selection<Space>) {
    const differential = effect[this.space];
    this.integrate(differential);
    return { ok: effect };
  }

  then<T, X>(
    onResolve: (
      value: Result<
        QueryView<Space, MemoryProtocol>,
        QueryError | AuthorizationError | ConnectionError
      >,
    ) => T | PromiseLike<T>,
    onReject: (reason: unknown) => X | Promise<X>,
  ) {
    return this.promise.then(onResolve, onReject);
  }

  get space(): Space {
    return this.invocation.sub as MemorySpace as Space;
  }

  integrate(differential: FactSelection) {
    const selection = this.selection[this.space];
    for (const change of iterate(differential)) {
      setRevision(selection, change.of, change.the, change.cause, change.value);
    }
  }

  get facts(): Revision<Fact>[] {
    return [...FactModule.iterate(this.selection[this.space])];
  }

  // Get the facts returned by the query, together with the associated
  // SchemaPathSelector used to query
  get schemaFacts(): [Revision<Fact>, SchemaPathSelector | undefined][] {
    return this.facts.map((fact) => [fact, this.getSchemaPathSelector(fact)]);
  }

  subscribe() {
    const subscription = new QuerySubscriptionInvocation(this);
    this.session.execute(subscription);

    return subscription;
  }

  // Get the SchemaPathSelector used to fetch the specified fact.
  // If the fact was included from another fact, it will not have a schema.
  getSchemaPathSelector(fact: Revision<Fact>): SchemaPathSelector | undefined {
    const factSelector = this.selector as SchemaSelector;
    const value = getSelectorRevision(factSelector, fact.of, fact.the);
    return value !== undefined
      ? { path: value?.path, schema: value?.schema }
      : undefined;
  }
}

class QuerySubscriptionInvocation<
  Space extends MemorySpace,
  MemoryProtocol extends Protocol<Space>,
> extends ConsumerInvocation<"/memory/query/subscribe", MemoryProtocol> {
  readable: ReadableStream<EnhancedCommit<Space>>;
  controller:
    | undefined
    | ReadableStreamDefaultController<EnhancedCommit<Space>>;
  patterns: { the?: MIME; of?: URI; cause?: CauseString }[];

  selection: Selection<Space>;
  constructor(public query: QueryView<Space, MemoryProtocol>) {
    super({
      ...query.invocation.source,
      cmd: "/memory/query/subscribe",
    });

    this.readable = new ReadableStream<EnhancedCommit<Space>>({
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

  open(controller: ReadableStreamDefaultController<EnhancedCommit<Space>>) {
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

  // This function is called for both subscriptions to the commit log as well as subscriptions
  // to individual docs.
  override perform(commit: EnhancedCommit<Space>) {
    const selection = this.selection[this.space];
    // Here we will collect subset of changes that match the query.
    const differential: OfTheCause<{ is?: StorableDatum; since: number }> = {};
    const fact = toRevision(commit.commit);

    const { the, of, is } = fact;
    const cause = fact.cause.toString() as CauseString;
    const { transaction, since } = is;
    const matchCommit = this.patterns.some((pattern) =>
      (!pattern.of || pattern.of === of) &&
      (!pattern.the || pattern.the === the) &&
      (!pattern.cause || pattern.cause === cause)
    );

    if (matchCommit) {
      // Update the main application/commit+json record for the space
      setRevision(differential, of, the, cause, { is, since });
    }
    for (const [k1, attributes] of Object.entries(transaction.args.changes)) {
      const of = k1 as URI;
      for (const [k2, changes] of Object.entries(attributes)) {
        const the = k2 as MIME;
        const causeEntries = Object.entries(changes);
        if (causeEntries.length === 0) {
          // A classified object will not have a cause/change pair
          const matchDoc = this.patterns.some((pattern) =>
            (!pattern.of || pattern.of === of) &&
            (!pattern.the || pattern.the === the) && !pattern.cause
          );
          if (matchDoc) {
            setEmptyObj(differential, of, the);
          }
        } else {
          const [[k3, change]] = causeEntries;
          const cause = k3 as CauseString;
          if (change !== true) {
            const state = Object.entries(
              selection?.[of]?.[the] ?? {},
            );
            const [current] = state.length > 0 ? state[0] : [];
            if (cause !== current) {
              const matchDoc = this.patterns.some((pattern) =>
                (!pattern.of || pattern.of === of) &&
                (!pattern.the || pattern.the === the) &&
                (!pattern.cause || pattern.cause === cause)
              );

              if (matchDoc) {
                const value = change.is
                  ? { is: change.is, since: since }
                  : { since: since };
                setRevision(differential, of, the, cause, value);
              }
            }
          }
        }
      }
    }

    if (Object.keys(differential).length !== 0) {
      this.query.integrate(differential);
    }
    this.integrate(commit);
    // This is a bit strange, but the revisions in here aren't proper
    // They've lost their Reference methods, so recreate them
    commit.revisions.forEach((item) => {
      item.cause = fromJSON(JSON.parse(JSON.stringify(item.cause)));
    });

    return { ok: {} };
  }
  integrate(commit: EnhancedCommit<Space>) {
    this.controller?.enqueue(commit);
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
