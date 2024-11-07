import * as DB from "synopsys";
import { run, CellImpl } from "@commontools/common-runner";
import {
  NAME,
  UI,
  recipe,
  cell as createCell,
} from "@commontools/common-builder";
import { html } from "@commontools/common-html";

export { refer, Reference, $, _ } from "synopsys";

/**
 * Behavior is a collection of rules that define behavior for a specific
 * entity. This roughly corresponds to "spell".
 */
export interface Behavior<
  Rules extends Record<string, Rule> = Record<string, Rule>,
> {
  readonly rules: Rules;

  spawn(source: {}): CellImpl<{}>;
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
}): Behavior<{ [K in keyof Source]: Rule<Source[K]> }> => new System(rules);

class System<Rules extends Record<string, Rule>> {
  rules: Rules;
  id: DB.Reference;
  constructor(rules: Rules) {
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
  spawn(source: {}) {
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
