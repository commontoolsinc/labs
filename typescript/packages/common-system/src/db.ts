import {
  Type,
  Task,
  Hybrid,
  Fact,
  Selector,
  refer,
  Reference,
  Codec,
  Variant,
  Transaction,
} from "synopsys";

import * as IDB from "synopsys/store/idb";
import * as Memory from "synopsys/store/memory";
import * as Session from "./session.js";
import type { Effect, Instruction } from "./adapter.js";
import { Constant } from "datalogia";
import { explainMutation, logQuery } from "./debug.js";
export * from "synopsys";

export type DB =
  ReturnType<typeof Hybrid.open> extends Type.Task<infer T> ? T : never;

export type Command = Variant<{
  Transact: Transaction;
  Dispatch: [Reference, string, Event];
  Integrate: Transaction;
}>;

export interface Options {
  remote?: { url?: URL };
  idb?: { name?: string; version?: number; store?: string };
}

class Connection {
  static *open(options: Options = {}) {
    const durable = yield* IDB.open({
      idb: {
        name: options.idb?.name ?? "synopsys",
        version: options.idb?.version ?? 1,
        store: options.idb?.store ?? "facts",
      },
    });

    // const durable = yield* Memory.open();
    const ephemeral = yield* Memory.open();

    const local = yield* Hybrid.open({
      durable,
      ephemeral,
    });

    const remote = new Remote({
      url: options.remote?.url ?? new URL("http://localhost:8080/"),
    });

    return new Connection(local, remote);
  }
  constructor(
    public local: DB,
    public remote: Remote,
  ) {}

  *dispatch([entity, attribute, event]: [Reference, string, Event]) {
    yield* this.local.transact([
      Session.upsert([entity, attribute, event as any]),
    ]);

    // Poll all the subscriptions
    const feedback = yield* poll();

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
    return yield* poll();
  }
}

class Database {
  idle = true;

  inbox: Command[] = [];
  upstream: Instruction[] = [];

  connection: Task.Invocation<Connection, Error>;

  subscriptions = new Set<Subscription>();

  constructor(options: Options = {}) {
    this.connection = Task.perform(Connection.open(options));
    Task.perform(this.pull());

    this.query = this.query.bind(this);
    this.dispatch = this.dispatch.bind(this);
    this.transact = this.transact.bind(this);
  }

  *open(options: Options) {
    const durable = yield* IDB.open({
      idb: {
        name: options.idb?.name ?? "synopsys",
        version: options.idb?.version ?? 1,
        store: options.idb?.store ?? "facts",
      },
    });

    // const durable = yield* Memory.open();
    const ephemeral = yield* Memory.open();

    const local = yield* Hybrid.open({
      durable,
      ephemeral,
    });

    const remote = new Remote({
      url: options.remote?.url ?? new URL("http://localhost:8080/"),
    });

    return { local, remote };
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
    if (command.Integrate) {
      this.upstream.push(...command.Integrate);
    } else {
      this.inbox.push(command);
    }

    if (this.idle) {
      yield* Task.fork(this.work());
    }
  }

  *work() {
    if (this.idle) {
      this.idle = false;
      const { inbox, upstream: pull } = this;
      const connection = yield* Task.wait(this.connection);
      while (inbox.length + pull.length > 0) {
        // We process all the local updates before we start integrate upstream
        // changes as we don't want to block local interactions.
        while (inbox.length) {
          const command = inbox.shift() as Command;
          if (command.Dispatch) {
            const feedback = yield* connection.dispatch(command.Dispatch);
            if (feedback.length > 0) {
              inbox.push({ Transact: feedback });
            }
          } else if (command.Transact) {
            const feedback = yield* connection.transact(command.Transact);
            if (feedback.length > 0) {
              inbox.push({ Transact: feedback });
            }
          } else {
            throw new Error(
              `Unexpected command in the inbox: ${Object.keys(command)}`,
            );
          }
        }

        // Now that we have processed all the local updates we will proceed with
        // integrating upstream changes.
        while (pull.length) {
          const feedback = yield* connection.integrate(pull.splice(0));
          if (feedback.length > 0) {
            inbox.push({ Transact: feedback });
          }
        }

        yield* Task.sleep(0);
      }

      this.idle = true;
    }
  }

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
}

const db = new Database();

class PullSource implements UnderlyingDefaultSource<Type.Transaction> {
  cancelled = false;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  constructor(
    public url: URL,
    public offset: number,
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
        controller.enqueue(transaction);
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

class PushTarget implements UnderlyingSink<Type.Transaction> {
  closed = false;
  controller = new AbortController();
  constructor(public url: URL) {}
  async start() {}
  async write(transaction: Type.Transaction) {
    if (this.closed || this.controller.signal.aborted) {
      throw new Error("Stream is closed");
    }

    const response = await fetch(this.url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/synopsys-sync",
      },
      body: Codec.encodeTransaction(transaction),
      signal: this.controller.signal,
    });

    if (!response.ok) {
      throw new Error(response.statusText);
    }

    const result = await response.json();
    if (result.error) {
      throw new Error(result.error);
    }

    return result.ok;
  }
  async close() {
    this.closed = true;
  }
  abort(reason: unknown) {
    this.controller.abort(reason);
  }
}

class Remote {
  static *open(options: { url: URL; offset?: number }) {
    return new Remote(options);
  }

  url: URL;

  readable: ReadableStream<Type.Transaction>;
  writable: WritableStream<Type.Transaction>;

  writer: WritableStreamDefaultWriter<Type.Transaction>;
  reader: ReadableStreamDefaultReader<Type.Transaction>;

  constructor({ url, offset = 0 }: { url: URL; offset?: number }) {
    this.url = url;

    this.readable = new ReadableStream(new PullSource(url, offset));
    this.writable = new WritableStream(new PushTarget(url));

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
  }
}

export const { transact, dispatch, query } = db;

/**
 * Polls all the rules and returns set of derived updates.
 */
export function* poll() {
  const changes = [];
  for (const subscription of subscriptions) {
    changes.push(...(yield* subscription.poll()));
  }
  return changes;
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

const isLocal = ([_entity, attribute, value]: Fact) =>
  typeof attribute === "string" &&
  attribute.startsWith("~/") &&
  !Constant.is(value);

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

const subscriptions = new Set<Subscription>();
export function* subscribe<Select extends Type.Selector>(
  id: Reference,
  name: string,
  query: Type.Query<Select>,
  effect: Effect<Select>,
) {
  const connection = yield* Task.wait(db.connection);
  const subscription = new Subscription(
    id,
    name,
    query,
    effect,
    connection.local,
  );
  subscriptions.add(subscription);

  return subscription;
}

class Subscription<Select extends Selector = Selector> {
  effect: Effect<Select>;
  query: Type.Query<Select>;
  revision: Reference;
  name: string;
  id: Reference;
  db: DB;

  constructor(
    id: Reference,
    name: string,
    query: Type.Query<Select>,
    effect: Effect<Select>,
    db: DB,
  ) {
    this.id = id;
    this.name = name;
    this.query = query;
    this.effect = effect;
    this.revision = refer([]);
    this.db = db;
  }
  *poll() {
    const start = performance.now();
    const selection = yield* this.db.query(this.query);
    const queryTime = performance.now() - start;
    console.log(
      `%c${this.name} ${queryTime.toFixed(2)}ms (spell/${this.id.toString()})`,
      "color: #999; font-size: 0.8em; font-style: italic;",
    );

    const revision = refer(selection);
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
          explainMutation({
            query: this.query,
            selection,
            changes,
          }).then(explanation => {
            window.dispatchEvent(
              new CustomEvent("mutation", {
                detail: {
                  rule: this.name,
                  spell: this.id.toString(),
                  entity: self?.toString(),
                  query: this.query,
                  selection,
                  changes,
                  explanation,
                  revision,
                },
              }),
            );
          });
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
    subscriptions.delete(this);
  }
}
