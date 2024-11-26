import { Type, Task, Hybrid, Fact, Selector, refer, Reference } from "synopsys";

import * as IDB from "synopsys/store/idb";
import * as Memory from "synopsys/store/memory";
import * as Session from "./session.js";
import type { Effect, Instruction } from "./adapter.js";
import { Constant } from "datalogia";
import { explainMutation, logQuery } from "./debug.js";
export * from "synopsys";

export type DB =
  ReturnType<typeof Hybrid.open> extends Type.Task<infer T> ? T : never;

export function* open(): Task.Task<DB, Error> {
  const durable = yield* IDB.open({
    idb: {
      name: "synopsys",
      version: 1,
      store: "facts",
    },
  });

  // const durable = yield* Memory.open();
  const ephemeral = yield* Memory.open();

  const db = yield* Hybrid.open({
    durable,
    ephemeral,
  });

  return db;
}

export const local = Task.perform(open());

export const upstream = {
  remote: {
    url: new URL("http://localhost:8080/"),
    fetch: globalThis.fetch.bind(globalThis),
  },
};

export function* transact(
  changes: Type.Transaction,
): Task.Task<Type.Commit, Error> {
  const db = yield* Task.wait(local);

  const transaction = [...changes].map(resolve);
  const commit = yield* db.transact(transaction);

  const updates = yield* publish(db);
  if (updates.length > 0) {
    yield* Task.fork(submit(updates));
  }
  // yield* Task.fork(synchronize(db, upstream));
  return commit;
}

const debounce = <Args extends unknown[]>(
  work: (...args: Args) => Task.Task<unknown, Error>,
  wait: number,
): ((...args: Args) => Task.Task<void, Error>) => {
  let idle = true;
  let previous = 0;
  return function* spawn(...args: Args): Task.Task<void, Error> {
    previous = Date.now();
    if (idle) {
      idle = false;
      let passed = Date.now() - previous;
      while (wait > passed) {
        yield* Task.sleep(wait - passed);
        passed = Date.now() - previous;
      }

      idle = true;
      yield* work(...args);
    }
  };
};

function* submit(changes: Type.Transaction) {
  yield* Task.sleep(0);
  yield* transact(changes);
}

const isLocal = ([_entity, attribute, value]: Fact) =>
  typeof attribute === "string" && attribute.startsWith("~/") && !Constant.is(value);

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

export const synchronize = debounce(function* (
  local: DB,
  remote: Hybrid.Address,
) {
  const upstream = yield* Hybrid.connect(remote);
  return yield* local.merge(upstream);
}, 100);

export function* query<Select extends Type.Selector>(
  select: Type.Query<Select>,
) {
  const db = yield* Task.wait(local);
  return yield* db.query(select);
}

const subscriptions = new Set<Subscription>();
export function* subscribe<Select extends Type.Selector>(
  id: Reference,
  name: string,
  query: Type.Query<Select>,
  effect: Effect<Select>,
) {
  const subscription = new Subscription(id, name, query, effect);
  subscriptions.add(subscription);

  return subscription;
}

export function* publish(db: DB) {
  const changes = [];
  for (const subscription of subscriptions) {
    changes.push(...(yield* subscription.poll(db)));
  }
  return changes;
}

class Subscription<Select extends Selector = Selector> {
  effect: Effect<Select>;
  query: Type.Query<Select>;
  revision: Reference;
  name: string;
  id: Reference;

  constructor(id: Reference,  name: string, query: Type.Query<Select>, effect: Effect<Select>) {
    this.id = id;
    this.name = name;
    this.query = query;
    this.effect = effect;
    this.revision = refer([]);
  }
  *poll(db: DB) {
    const start = performance.now();
    const selection = yield* db.query(this.query);
    const queryTime = performance.now() - start;
    console.log(`%c${this.name} ${queryTime.toFixed(2)}ms (spell/${this.id.toString()})`, 'color: #999; font-size: 0.8em; font-style: italic;');

    const revision = refer(selection);
    const changes: Instruction[] = [];
    if (this.revision.toString() !== revision.toString()) {
      this.revision = revision;
      if (selection.length > 0) {
        console.group(`%c${this.name}`, 'color: #4CAF50; font-weight: bold;');
        logQuery(this.query);
        console.log('%crevision%c:', 'color: #2196F3; font-weight: bold;', 'color: inherit;', this.revision.toString());
        console.log('%cselection%c:', 'color: #2196F3; font-weight: bold;', 'color: inherit;', selection);
      }
      const processStartTime = performance.now();
      for (const match of selection) {
        const self = (match as any).self
        const effectStartTime = performance.now();
        const matchChanges = (yield* this.effect.perform(match));
        const effectTime = performance.now() - effectStartTime;
        console.log(`%c ↳ self/${self?.toString() || 'none'} ${effectTime.toFixed(2)}ms`, 'color: #999; font-size: 0.8em; font-style: italic;');

        if (self) {
          window.dispatchEvent(new CustomEvent('query-triggered', {
            detail: { rule: this.name, spell: this.id.toString(), entity: self.toString(), match, performanceMs: queryTime }
          }))
        }
        for (const change of matchChanges) {
          console.log('%cchange%c:', 'color: #E91E63; font-weight: bold;', 'color: inherit;', JSON.stringify(change), change);
        }
        changes.push(...matchChanges);

        if (matchChanges.length > 0) {
          explainMutation({
            query: this.query,
            selection,
            changes
          }).then(explanation => {
            window.dispatchEvent(new CustomEvent('mutation', {detail:{
              rule: this.name,
              spell: this.id.toString(),
              entity: self?.toString(),
              query: this.query,
              selection,
              changes,
              explanation,
              revision
            }}))
          })
        }
      }
      if (selection.length > 0) {
        const totalTime = performance.now() - processStartTime;
        console.log(`%cTotal reaction: ${totalTime.toFixed(2)}ms`, 'color: #999; font-size: 0.8em; font-style: italic;');
        console.groupEnd();
      }
    }

    return changes;
  }
  abort() {
    subscriptions.delete(this);
  }
}
