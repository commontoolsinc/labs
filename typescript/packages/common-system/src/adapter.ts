import { Type, Task, refer, Reference, $ } from "synopsys";
import { run, CellImpl } from "@commontools/common-runner";
import * as DB from "./db.js";
import {
  NAME,
  UI,
  recipe,
  cell as createCell,
} from "@commontools/common-builder";
import { html } from "@commontools/common-html";

export { refer, Reference, $, _, Task, Instruction, Fact } from "synopsys";

/**
 * Behavior is a collection of rules that define behavior for a specific
 * entity. This roughly corresponds to "spell".
 */
export interface Behavior<
  Rules extends Record<string, Rule> = Record<string, Rule>,
> {
  readonly rules: Rules;

  readonly id: Reference;

  fork(self?: Reference): Task.Task<{}, Error>;

  spawn(source?: {}): CellImpl<{}>;
}

export interface Service<Effects extends Record<string, Effect>> {
  readonly rules: Effects;
  // spawn(source?: {}): CellImpl<{}>;

  spawn(source?: {}): {};
}

export interface Effect<Select extends Type.Selector = Type.Selector> {
  select: Select;
  where: Type.Where;
  perform: (input: Type.Selection<Select>) => Task.Task<Type.Instruction[]>;
}

/**
 * Rule defines a specific behavior for an entity referenced by the `?`
 * variable. It provides a selector to query entity and relevant relations
 * and provides an update logic that submits new facts to the database when
 * when result of the selector changes.
 */
export interface Rule<Select extends Type.Selector = Type.Selector> {
  select: Select;
  where: Type.Where;
  update: (input: Type.Selection<Select>) => Type.Transaction;
}

export const toEffect = <Select extends Type.Selector = Type.Selector>(
  rule: Rule<Select>,
): Effect<Select> => {
  const effect = rule as (Rule<Select> & { perform?: void }) | Effect<Select>;
  return effect.perform ? (effect as Effect<Select>) : new RuleEffect(rule);
};

/**
 * This function does not serve any other purpose but to activate TS type
 * inference specifically it ensures that rule `update` functions infer it's
 * arguments from the rules `select`.
 */
export const behavior = <Source extends Record<string, any>>(rules: {
  [K in keyof Source]: Rule<Source[K]>;
}): Behavior<{ [K in keyof Source]: Rule<Source[K]> }> =>
  new SystemBehavior(rules);

export const service = <Source extends Record<string, any>>(effects: {
  [K in keyof Source]: Effect<Source[K]>;
}): Service<{ [K in keyof Source]: Effect<Source[K]> }> =>
  new SystemService(effects);

class SystemBehavior<Rules extends Record<string, Rule>> {
  rules: Rules;
  id: Reference;
  constructor(rules: Rules) {
    this.rules = rules;
    this.id = refer({
      rules: Object.fromEntries(
        Object.entries(this.rules).map(([name, rule]) => [
          name,
          { select: rule.select, where: rule.where },
        ]),
      ),
    });
  }

  *fork(self: Reference = this.id) {
    const db = yield* Task.wait(DB.local);
    const subscriptions = [];
    const changes = [];
    for (const [name, rule] of Object.entries(this.rules)) {
      const query = {
        select: rule.select,
        where: [
          { Match: [self, "==", $.self] },
          //
          ...rule.where,
        ],
      };

      const subscription = yield* DB.subscribe(
        name,
        query as Type.Query,
        toEffect(rule),
      );
      subscriptions.push(subscription);

      changes.push(...(yield* subscription.poll(db)));
    }

    if (changes.length) {
      yield* DB.transact(changes);
    }

    try {
      yield* Task.suspend();
      return {};
    } finally {
      for (const subscription of subscriptions) {
        subscription.abort();
      }
    }
  }
  spawn(source: {} = this.id) {
    const entity = refer(source);
    const charm = refer({ entity, rules: this.id });

    return run(
      recipe(charm.toString(), () => {
        const cell = createCell({ name: "" });

        return {
          [NAME]: cell.name,
          [UI]: html`<common-charm
            id=${charm.toString()}
            entity=${() => entity}
            spell=${() => this}
            $cell=${cell}
          />`,
        };
      }),
    );
  }
}

class SystemService<Effects extends Record<string, Effect>> {
  rules: Effects;
  id: Reference;
  constructor(rules: Effects) {
    this.rules = rules;
    this.id = refer({
      rules: Object.fromEntries(
        Object.entries(this.rules).map(([name, rule]) => [
          name,
          { select: rule.select, where: rule.where },
        ]),
      ),
    });
  }

  *fork(self: Reference = this.id) {
    const db = yield* Task.wait(DB.local);
    const subscriptions = [];
    const changes = [];
    for (const [name, rule] of Object.entries(this.rules)) {
      const query = {
        select: rule.select,
        where: [
          { Match: [self, "==", $.self] },
          //
          ...rule.where,
        ],
      };

      const subscription = yield* DB.subscribe(name, query as Type.Query, rule);
      subscriptions.push(subscription);

      changes.push(...(yield* subscription.poll(db)));
    }

    if (changes.length) {
      yield* DB.transact(changes);
    }

    try {
      yield* Task.suspend();
    } finally {
      for (const subscription of subscriptions) {
        subscription.abort();
      }
    }
  }

  spawn(self: Reference = this.id) {
    Task.perform(this.fork(self));
    return {};
  }
}

class RuleEffect<Select extends Type.Selector = Type.Selector> {
  rule: Rule<Select>;
  constructor(rule: Rule<Select>) {
    this.rule = rule;
  }

  get select() {
    return this.rule.select;
  }
  get where() {
    return this.rule.where;
  }
  update(input: Type.Selection<Select>) {
    return this.rule.update(input);
  }

  *perform(
    input: Type.Selection<Select>,
  ): Task.Task<Type.Instruction[], never> {
    return [...this.rule.update(input)];
  }
}
