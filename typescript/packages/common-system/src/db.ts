import {
  Type,
  API,
  Task,
  Hybrid,
  Fact,
  Selector,
  refer,
  Codec,
  Variant,
  Transaction,
  synopsys,
  $,
} from "synopsys";

import * as IDB from "synopsys/store/idb";
import * as Memory from "synopsys/store/memory";
import * as Session from "./session.js";
import type { Effect, Instruction } from "./adapter.js";
import { Constant } from "datalogia";
import { logQuery } from "./debug.js";
import * as Store from "./idb.js";
import { Reference } from "merkle-reference";
export * from "synopsys";

export type DB =
  ReturnType<typeof Hybrid.open> extends Type.Task<infer T> ? T : never;

export type Command = Variant<{
  Transact: Transaction;
  Dispatch: [Reference, string, Event];
  Integrate: Transaction;
}>;

export type RemoteOptions = {
  url?: URL;
  store?: Partial<Store.Address>;
};

export interface Options {
  remote?: RemoteOptions;
  local?: IDB.Open;
}

/**
 * Represents a connection to a local and a remote databases. It takes care
 * of synchronizing two by publishing local changes to remote and integrating
 * remote changes into local.
 */
class Connection {
  static *open(options: Options = {}) {
    const durable = yield* IDB.open(options.local);

    // const durable = yield* Memory.open();
    const ephemeral = yield* Memory.open();

    const local = yield* Hybrid.open({
      durable,
      ephemeral,
    });

    const remote = yield* Remote.open({
      local: local,
      ...options.remote,
    });

    return new Connection(local, remote);
  }

  subscriptions = new Set<Subscription>();
  constructor(
    public local: DB,
    public remote: Remote,
  ) {}

  *dispatch([entity, attribute, event]: [Reference, string, Event]) {
    yield* this.local.transact([
      Session.upsert([entity, attribute, event as any]),
    ]);

    // Poll all the subscriptions
    const feedback = yield* this.poll();

    yield* this.local.transact([
      Session.retract([entity, attribute, event as any]),
    ]);

    return feedback;
  }

  *transact(transaction: Transaction) {
    const changes = [...transaction].map(resolve);
    yield* Task.fork(this.remote.transact(changes));
    return yield* this.integrate(changes);
  }

  /**
   * Integrates transaction into a local db without pushing it upstream.
   * This is usually used to integrate upstream changes locally.
   */
  *integrate(changes: Instruction[]) {
    yield* this.local.transact(changes);
    return yield* this.poll();
  }

  *poll() {
    const changes = [];
    for (const subscription of this.subscriptions) {
      changes.push(...(yield* subscription.poll()));
    }
    return changes;
  }
}

/**
 * Database is a wrapper around {@link Connection} that adds a concurrency
 * management on top. It makes sure that local transactions take a priority
 * over upstream changes and that no transactions occur during rule reevaluation
 * in order to guarantee that event handling rules are run only once per event.
 */
class Database {
  idle = true;

  /**
   * Queue of local transaction and dispatch commands.
   */
  local: Command[] = [];
  /**
   * Queue of remote transactions to be integrate into local replica.
   */
  remote: Instruction[] = [];

  connection: Task.Invocation<Connection, Error>;

  constructor(options: Options = {}) {
    // We open connection to local and remote databases and start pulling
    // changes from the remote.
    this.connection = Task.perform(Connection.open(options));
    Task.perform(this.pull());

    // We bind all the methods because they get exported as statics.
    this.query = this.query.bind(this);
    this.dispatch = this.dispatch.bind(this);
    this.transact = this.transact.bind(this);
    this.subscribe = this.subscribe.bind(this);
  }

  transact(instruction: Transaction) {
    return this.enqueue({ Transact: instruction });
  }

  dispatch(fact: [Reference, string, Event]) {
    return this.enqueue({ Dispatch: fact });
  }
  integrate(changes: Transaction) {
    return this.enqueue({ Integrate: changes });
  }
  *enqueue(command: Command) {
    // Integration commands are added to the remote instruction queue
    // because they can be applied in a single batch and because they
    // are only run when the local queue is drained.
    if (command.Integrate) {
      this.remote.push(...command.Integrate);
    } else {
      this.local.push(command);
    }

    // If we are idle we will resume processing work queue.
    if (this.idle) {
      yield* Task.fork(this.work());
    }
  }

  /**
   * Main work loop that processes local and remote queues. It will process
   * local queue first and only then remote one. It will keep processing until
   * both queues are empty and then set itself to idle.
   */
  *work() {
    if (this.idle) {
      this.idle = false;
      const { local, remote } = this;
      const connection = yield* Task.wait(this.connection);
      // We keep processing until both queues are empty. It may appear redundant
      // given inner while loops, however we may have gotten more work in the
      // local queue while we were processing remote queue.
      while (local.length + remote.length > 0) {
        // We process all the local updates before we start integrate upstream
        // changes as we don't want to block local interactions.
        while (local.length) {
          const command = local.shift() as Command;
          if (command.Dispatch) {
            // Note that dispatch upserts fact corresponding to event evaluates
            // rules and then retracts that fact. This guarantees that rules are
            // evaluated only once per event.
            const feedback = yield* connection.dispatch(command.Dispatch);
            if (feedback.length > 0) {
              local.push({ Transact: feedback });
            }
          } else if (command.Transact) {
            const feedback = yield* connection.transact(command.Transact);
            if (feedback.length > 0) {
              local.push({ Transact: feedback });
            }
          } else {
            throw new Error(
              `Unexpected command in the queue: ${Object.keys(command)}`,
            );
          }
        }

        // Now that we have processed all the local updates we will proceed with
        // integrating upstream changes.
        while (remote.length) {
          const feedback = yield* connection.integrate(remote.splice(0));
          if (feedback.length > 0) {
            local.push({ Transact: feedback });
          }
        }

        // We take a breather here before we continue to avoid starve the event
        // loop.
        yield* Task.sleep(0);
      }

      // Looks like we have drained both queues so it's time to idle.
      this.idle = true;
    }
  }

  /**
   * This pulls changes from the remote and integrates them into local replica.
   */
  *pull() {
    const { remote } = yield* Task.wait(this.connection);
    while (true) {
      const read = yield* Task.wait(remote.reader.read());
      if (read.done) {
        break;
      }

      yield* this.integrate(read.value);
    }
  }

  *query<Select extends Type.Selector>(source: Type.Query<Select>) {
    const connection = yield* Task.wait(this.connection);
    return yield* connection.local.query(source);
  }

  *subscribe<Select extends Type.Selector>(
    id: Reference,
    name: string,
    query: Type.Query<Select>,
    effect: Effect<Select>,
  ) {
    const connection = yield* Task.wait(this.connection);
    const subscription = new Subscription(id, name, query, effect, connection);
    connection.subscriptions.add(subscription);

    return subscription;
  }
}

class PullOffset {
  static relation = "pull/offset";
  static match(term: API.Term, implicit: number = 0): API.Clause {
    return {
      Or: [
        { Case: [synopsys, this.relation, term] },
        {
          And: [
            { Not: { Case: [synopsys, this.relation, $._] } },
            { Match: [implicit, "==", term] },
          ],
        },
      ],
    };
  }
  static upsert(offset: number): Instruction {
    return { Upsert: [synopsys, this.relation, offset] };
  }

  static *find(db: DB) {
    const [{ offset }] = yield* db.query({
      select: { offset: $.offset },
      where: [PullOffset.match($.offset, 0)],
    });

    return offset;
  }
}

/**
 * PullSource is a readable stream source that pulls changes from the upstream.
 * It consults local replica to find the last known offset into remote replica
 * to continue replication from.
 */
class PullSource implements UnderlyingDefaultSource<Type.Transaction> {
  cancelled = false;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  offset = 0;
  constructor(
    public url: URL,
    public store: Store.Store,
    public db: DB,
  ) {}

  async start(controller: ReadableStreamDefaultController<Type.Transaction>) {
    while (!this.cancelled) {
      const { done, value } = await this.read();
      if (done) {
        controller.close();
        break;
      } else {
        const transaction = Codec.decodeTransaction(value);
        this.offset += value.byteLength;
        controller.enqueue([
          ...transaction,
          // We amend our transaction with another upsert which will store the
          // offset of the transaction log so in the next session we will be
          // able to resume replication from the last known offset.
          // ⚠️ Note there is a reason why we amend this change to a transaction
          // as opposed to storing it e.g. in IDB - code downstream may fail to
          // integrate a transaction while we will update offset and end up
          // missing some changes. Alternatively we could have stored the offset
          // after transaction is integrated but this would introduce more
          // coupling between Database and PullSource. Since we append change
          // to transaction itself it will update offset along with a
          // transaction itself.
          // 🚨 Please note important invariant - pulled changes are integrated
          // without pushing them back up to upstream. Without this invariant
          // different replicas will end up making conflicting updates and
          // racing. So please make sure that if some replication logic changes
          // that this invariant is either upheld or alternative strategy is
          // devised for maintaining pull offset.
          PullOffset.upsert(this.offset),
        ]);
      }
    }
  }
  async cancel() {
    this.cancelled = true;
    const { reader } = this;
    if (reader) {
      delete this.reader;
      await reader.cancel();
    }
  }
  async connect() {
    if (this.reader) {
      return this as Required<PullSource>;
    } else {
      // We find the last pull offset that got stored into local db to continue
      // replication from.
      this.offset = await Task.perform(PullOffset.find(this.db));

      const response = await fetch(this.url, {
        method: "GET",
        headers: {
          Accept: "application/synopsys-sync",
          Range: `bytes=${this.offset}-`,
        },
      });

      const body = response.body as ReadableStream<Uint8Array>;
      const transactions = Codec.partition(body);
      this.reader = transactions.getReader();
      return this as Required<PullSource>;
    }
  }
  async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (this.cancelled) {
      return { done: true, value: undefined };
    } else {
      const { reader } = this.reader
        ? (this as Required<PullSource>)
        : await this.connect();
      const chunk = await reader.read();
      // If stream was closed from the server, reconnect
      if (chunk.done && !this.cancelled) {
        delete this.reader;
        return await this.read();
      } else {
        return chunk;
      }
    }
  }
}

/**
 * Clock is a simple wall clock that is used to order locally stored
 * transactions. It borrows idea from hybrid logical clocks to make sure
 * that we never end up with two transactions with the same timestamp.
 */
class Clock {
  static time = Date.now();
  static now() {
    let now = Date.now();
    while (now < this.time) {
      now++;
    }
    this.time = now;
    return now;
  }
}

/**
 * PushTarget is a writable stream sink. It takes care of pushing transactions
 * up to upstream in an ordered fashion. It also handles network downtime by
 * storing all transactions in provided IDB and then flushing them to upstream
 * once connection is reestablished.
 */
class PushTarget implements UnderlyingSink<Type.Transaction>, API.Transactor {
  closed = false;
  idle = true;
  batchSize = 10;
  controller = new AbortController();
  constructor(
    public url: URL,
    public store: Store.Store<Uint8Array, ["push", number]>,
  ) {}
  start() {
    return Task.perform(this.flush());
  }
  async write(changes: Type.Transaction) {
    await Task.perform(this.transact(changes));
  }
  close() {
    this.closed = true;
  }
  abort(reason: unknown) {
    this.controller.abort(reason);
  }

  /**
   * Flushes stored transactions to upstream in an ordered fashion. It will
   * attempt to pull `batchSize` number of oldest transactions from the store
   * and send them one by one to the upstream. On network error flush will
   * throw an error and will be retried next time transaction is written. We
   * may want to device exponential backoff strategy in the future, but for now
   * it's simply will keep trying.
   */
  *flush() {
    if (this.idle) {
      this.idle = false;
      while (true) {
        const entries = yield* this.store
          .entries(IDBKeyRange.bound(["push", 0], ["push", Infinity]))
          .take(this.batchSize);

        if (entries.length === 0) {
          break;
        }

        for (const [key, value] of entries) {
          yield* this.send(value);
          yield* this.store.delete(key);
        }
      }
      this.idle = true;
    }
  }
  /**
   * Sends encoded transaction to the upstream. If response is not ok it will
   * throw an error. If response is ok it will return it.
   */
  *send(content: Uint8Array) {
    const response = yield* Task.wait(
      fetch(this.url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/synopsys-sync",
        },
        body: content,
        signal: this.controller.signal,
      }),
    );

    if (!response.ok) {
      throw new Error(response.statusText);
    }

    const result = yield* Task.wait(response.json());
    if (result.error) {
      throw new Error(result.error);
    }

    return result.ok;
  }

  /**
   * Implements same transaction interface as all other `Transactor`s. It will
   * store transaction in to an IDB store keyed by wall clock time and initiate
   * flush.
   */
  *transact(transaction: Type.Transaction) {
    if (this.closed || this.controller.signal.aborted) {
      throw new Error("Stream is closed");
    }

    const id = Clock.now();
    const content = Codec.encodeTransaction(transaction);
    yield* this.store.set(["push", id], content);
    if (this.idle) {
      yield* Task.fork(this.flush());
    }

    return {};
  }
}

/**
 * Remote is an abstraction over a remote replica. It is a duplex stream where
 * local transactions can be written to upstream and remote transaction can be
 * read from upstream. It also implements `Transactor` interface so it can be
 * used interchangeably with other `Transactor`s.
 */
class Remote implements API.Transactor {
  static *open({ local, ...options }: RemoteOptions & { local: DB }) {
    const url = options.url ?? new URL("http://localhost:8080/");
    const store = yield* Store.open<Uint8Array, ["push", number]>({
      name: "synopsys/sync",
      version: 1,
      store: `sync+${url}`,
      ...options.store,
    });

    const pull = new PullSource(url, store, local);
    const push = new PushTarget(url, store);

    return new Remote({ push, pull });
  }

  url: URL;

  readable: ReadableStream<Type.Transaction>;
  writable: WritableStream<Type.Transaction>;

  writer: WritableStreamDefaultWriter<Type.Transaction>;
  reader: ReadableStreamDefaultReader<Type.Transaction>;

  constructor({ pull, push }: { pull: PullSource; push: PushTarget }) {
    this.readable = new ReadableStream(pull);
    this.writable = new WritableStream(push);

    this.writer = this.writable.getWriter();
    this.reader = this.readable.getReader();
  }

  *transact(changes: Type.Transaction) {
    const transaction = [];
    for (const change of changes) {
      const fact = change.Assert ?? change.Upsert ?? change.Retract;
      if (!fact?.[1].toString().startsWith("~/")) {
        transaction.push(change);
      }
    }

    if (transaction.length > 0) {
      yield* Task.wait(this.writer.write(transaction));
    }

    return {};
  }
}

// const debounce = <Args extends unknown[]>(
//   work: (...args: Args) => Task.Task<unknown, Error>,
//   wait: number,
// ): ((...args: Args) => Task.Task<void, Error>) => {
//   let idle = true;
//   let previous = 0;
//   return function* spawn(...args: Args): Task.Task<void, Error> {
//     previous = Date.now();
//     if (idle) {
//       idle = false;
//       let passed = Date.now() - previous;
//       while (wait > passed) {
//         yield* Task.sleep(wait - passed);
//         passed = Date.now() - previous;
//       }

//       idle = true;
//       yield* work(...args);
//     }
//   };
// };

/**
 * Checks if the fact is local in order to decide whether to belongs to an
 * ephemeral or durable store.
 */
const isLocal = ([_entity, attribute, value]: Fact) =>
  typeof attribute === "string" &&
  attribute.startsWith("~/") &&
  !Constant.is(value);

/**
 * Resolves instruction via local session. Values for asserts up upserts will
 * end up getting replaced with local references while retracts will be delete
 * those references from the local session.
 */
const resolve = (change: Type.Instruction): Type.Instruction => {
  if (change.Assert) {
    if (isLocal(change.Assert)) {
      return Session.upsert(change.Assert);
    } else {
      return change;
    }
  }

  if (change.Upsert) {
    if (isLocal(change.Upsert)) {
      return Session.upsert(change.Upsert);
    } else {
      return change;
    }
  }

  if (change.Retract) {
    if (isLocal(change.Retract)) {
      return Session.retract(change.Retract);
    } else {
      return change;
    }
  }

  return change;
};

/**
 * Represents subscription to a query. It can be polled polled which will
 * rerun the query and perform bound effect if the result has changed.
 */
class Subscription<Select extends Selector = Selector> {
  revision: Reference = refer([]);
  suspended: boolean = false;

  constructor(
    public id: Reference,
    public name: string,
    public query: Type.Query<Select>,
    public effect: Effect<Select>,
    public connection: Connection,
  ) {}
  *poll() {
    if (this.suspended) {
      return [];
    }

    const start = performance.now();
    const selection = yield* this.connection.local.query(this.query);
    const queryTime = performance.now() - start;
    // console.log(
    //   `%c${this.name} ${queryTime.toFixed(2)}ms (spell/${this.id.toString()})`,
    //   "color: #999; font-size: 0.8em; font-style: italic;",
    // );

    let revision;
    try {
      revision = refer(selection);
    } catch (error) {
      console.error("Error creating reference from selection:", error);
      return [];
    }
    const changes: Instruction[] = [];
    if (this.revision.toString() !== revision.toString()) {
      this.revision = revision;
      if (selection.length > 0) {
        console.group(`%c${this.name}`, "color: #4CAF50; font-weight: bold;");
        logQuery(this.query);
        console.log(
          "%crevision%c:",
          "color: #2196F3; font-weight: bold;",
          "color: inherit;",
          this.revision.toString(),
        );
        console.log(
          "%cselection%c:",
          "color: #2196F3; font-weight: bold;",
          "color: inherit;",
          selection,
        );
      }
      const processStartTime = performance.now();
      for (const match of selection) {
        const self = (match as any).self;
        const effectStartTime = performance.now();
        const matchChanges = yield* this.effect.perform(match);
        const effectTime = performance.now() - effectStartTime;
        console.log(
          `%c ↳ self/${self?.toString() || "none"} ${effectTime.toFixed(2)}ms`,
          "color: #999; font-size: 0.8em; font-style: italic;",
        );

        if (self) {
          window.dispatchEvent(
            new CustomEvent("query-triggered", {
              detail: {
                rule: this.name,
                spell: this.id.toString(),
                entity: self.toString(),
                match,
                performanceMs: queryTime,
              },
            }),
          );
        }
        for (const change of matchChanges) {
          console.log(
            "%cchange%c:",
            "color: #E91E63; font-weight: bold;",
            "color: inherit;",
            JSON.stringify(change),
            change,
          );
        }
        changes.push(...matchChanges);

        if (matchChanges.length > 0) {
          window.dispatchEvent(
            new CustomEvent("mutation", {
              detail: {
                rule: this.name,
                spell: this.id.toString(),
                entity: self?.toString(),
                query: this.query,
                selection,
                changes,
                revision,
              },
            }),
          );
        }
      }
      if (selection.length > 0) {
        const totalTime = performance.now() - processStartTime;
        console.log(
          `%cTotal reaction: ${totalTime.toFixed(2)}ms`,
          "color: #999; font-size: 0.8em; font-style: italic;",
        );
        console.groupEnd();
      }
    }

    return changes;
  }
  abort() {
    this.connection.subscriptions.delete(this);
  }
}

export const { transact, dispatch, query, subscribe } = new Database();
