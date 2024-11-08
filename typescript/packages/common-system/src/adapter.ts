import * as DB from "synopsys";
import { run, CellImpl } from "@commontools/common-runner";
import {
  NAME,
  UI,
  recipe,
  cell as createCell,
} from "@commontools/common-builder";
import { html } from "@commontools/common-html";

import { Task } from "synopsys";
export { refer, Reference, $, _, Task, Instruction, Fact } from "synopsys";

/**
 * Behavior is a collection of rules that define behavior for a specific
 * entity. This roughly corresponds to "spell".
 */
export interface Behavior<
  Rules extends Record<string, Rule> = Record<string, Rule>,
> {
  readonly rules: Rules;

  spawn(source?: {}): CellImpl<{}>;
}

export interface Service<Effects extends Record<string, Effect>> {
  readonly rules: Effects;
  spawn(source?: {}): CellImpl<{}>;
}

export interface Effect<Select extends DB.API.Selector = DB.API.Selector> {
  select: Select;
  where: DB.API.Query["where"];
  perform: (input: DB.API.InferBindings<Select>) => Task.Task<DB.Instruction[]>;
}

/**
 * Rule defines a specific behavior for an entity referenced by the `?`
 * variable. It provides a selector to query entity and relevant relations
 * and provides an update logic that submits new facts to the database when
 * when result of the selector changes.
 */
export interface Rule<Select extends DB.API.Selector = DB.API.Selector> {
  select: Select;
  where: DB.API.Query["where"];
  update: (input: DB.API.InferBindings<Select>) => DB.Transaction;
}

/**
 * This function does not serve any other purpose but to activate TS type
 * inference specifically it ensures that rule `update` functions infer it's
 * arguments from the rules `select`.
 */
export const behavior = <Source extends Record<string, any>>(rules: {
  [K in keyof Source]: Rule<Source[K]>;
}): Behavior<{ [K in keyof Source]: FX<Source[K]> }> => {
  const effects = Object.entries(rules).map(([key, rule]) => [
    key,
    FX.from(rule),
  ]);
  return new BehaviorEngine(Object.fromEntries(effects));
};

export const service = <Source extends Record<string, any>>(effects: {
  [K in keyof Source]: Effect<Source[K]>;
}): Service<{ [K in keyof Source]: Effect<Source[K]> }> =>
  new BehaviorEngine(effects);

class BehaviorEngine<Effects extends Record<string, Effect>> {
  rules: Effects;
  id: DB.Reference;
  constructor(rules: Effects) {
    this.rules = rules;
    this.id = DB.refer({
      rules: Object.fromEntries(
        Object.entries(this.rules).map(([name, rule]) => [
          name,
          { select: rule.select, where: rule.where },
        ]),
      ),
    });
  }
  spawn(source: {} = this.id) {
    const entity = DB.refer(source);
    const charm = DB.refer({ entity, rules: this.id });

    return run(
      recipe(charm.toString(), () => {
        const cell = createCell({ name: "" });

        return {
          [NAME]: cell.name,
          [UI]: html`<common-charm
            id=${charm.toString()}
            spell=${() => this.rules}
            entity=${() => entity}
            $cell=${cell}
          />`,
        };
      }),
    );
  }
}

class FX<Select extends DB.API.Selector = DB.API.Selector> {
  static from<Select extends DB.API.Selector = DB.API.Selector>(
    rule: Rule<Select>,
  ): Effect<Select> {
    return new this(rule);
  }

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
  update(input: DB.API.InferBindings<Select>) {
    return this.rule.update(input);
  }

  *perform(
    input: DB.API.InferBindings<Select>,
  ): Task.Task<DB.Instruction[], never> {
    return [...this.rule.update(input)];
  }
}
