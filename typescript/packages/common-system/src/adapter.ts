import { Type, Task, refer, $ } from "synopsys";
import { run, CellImpl, cell as createRunnerCell } from "@commontools/common-runner";
import * as DB from "./db.js";
import { NAME, UI, recipe } from "@commontools/common-builder";
import { html } from "@commontools/common-html";
import { Reference } from "merkle-reference";

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

  spawn(source?: {}, defaultName?: string): CellImpl<{}>;

  disableRule(ruleName: keyof Rules): void;
  enableRule(ruleName: keyof Rules): void;
  isRuleEnabled(ruleName: keyof Rules): boolean;
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

function spellId<Rules extends Record<string, any>>(rules: Rules) {
  return refer({
    rules: Object.fromEntries(
      Object.entries(rules).map(([name, rule]) => [
        name,
        { select: rule.select, where: rule.where },
      ]),
    ),
  });
}
class SystemBehavior<Rules extends Record<string, Rule>> {
  rules: Rules;
  id: Reference;
  private subscriptionMap: Map<string, any>;
  private disabledRules: Set<string>;

  constructor(rules: Rules) {
    this.rules = rules;
    this.id = spellId(rules);
    this.subscriptionMap = new Map();
    this.disabledRules = new Set();
  }

  disableRule(ruleName: keyof Rules) {
    const subscription = this.subscriptionMap.get(ruleName as string);
    if (subscription) {
      subscription.suspended = true;
    }
    this.disabledRules.add(ruleName as string);
  }

  enableRule(ruleName: keyof Rules) {
    const subscription = this.subscriptionMap.get(ruleName as string);
    if (subscription) {
      subscription.suspended = false;
    }
    this.disabledRules.delete(ruleName as string);
  }

  isRuleEnabled(ruleName: keyof Rules): boolean {
    if (this.disabledRules.has(ruleName as string)) {
      return false;
    }
    const subscription = this.subscriptionMap.get(ruleName as string);
    return subscription ? !subscription.suspended : true;
  }

  *fork(self: Reference = this.id) {
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
        spellId(this.rules),
        name,
        query as Type.Query,
        toEffect(rule),
      );
      this.subscriptionMap.set(name, subscription);

      if (this.disabledRules.has(name)) {
        subscription.suspended = true;
      }

      changes.push(...(yield* subscription.poll()));
    }

    if (changes.length) {
      yield* DB.transact(changes);
    }

    try {
      yield* Task.suspend();
      return {};
    } finally {
      for (const subscription of this.subscriptionMap.values()) {
        subscription.abort();
      }
      this.subscriptionMap.clear();
    }
  }

  spawn(source: {} = this.id, defaultName: string = "pending") {
    const entity = refer(source);
    const charm = refer({ entity, rules: this.id });

    return run(
      recipe(charm.toString(), () => {
        const name = createRunnerCell(defaultName);

        return {
          [NAME]: name,
          [UI]: html`<common-charm
            id=${charm.toString()}
            entity=${() => entity}
            spell=${() => this}
            $cell=${name}
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
        spellId(this.rules),
        name,
        query as Type.Query,
        rule,
      );
      subscriptions.push(subscription);

      changes.push(...(yield* subscription.poll()));
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
