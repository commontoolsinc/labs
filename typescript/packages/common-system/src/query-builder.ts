import {
  Query,
  Selector,
  Clause,
  InferBindings,
  Term,
  Entity,
  Attribute,
  API,
  Bindings,
  Confirmation,
  Formula,
} from "datalogia";
import { $, Instruction, Fact } from "synopsys";
import { Node } from "./jsx.js";

export type Update<Match extends Selector> = (
  props: InferBindings<Match>,
) => Array<Instruction>;

export type Edit<Match extends Selector> = (
  props: InferBindings<Match>,
) => Fact;

export type View<Match extends Selector> = (
  props: InferBindings<Match>,
) => Node<any>;

export type EditStep<Match extends Selector> = {
  operation: "Assert" | "Retract" | "Upsert";
  edit: Edit<Match>;
};

export class Select<Match extends Selector = Selector> {
  #select: Match;
  #where: Array<Clause> = [];
  #steps: Array<EditStep<Match>> = [];
  #negation = false;

  constructor(select: Match) {
    this.#select = select;
  }

  where(...clauses: Array<Clause>) {
    this.#where = [...this.#where, ...clauses];
    return this;
  }

  match(
    entity: Term<Entity>,
    attribute: Term<Attribute>,
    value: Term<API.Constant> = $._,
  ): Select<Match> {
    if (this.#negation) {
      this.#negation = false;
      return this.where(not(match(entity, attribute, value)));
    } else {
      return this.where(match(entity, attribute, value));
    }
  }

  get not() {
    this.#negation = true;
    return this;
  }

  edit(operation: "Assert" | "Retract" | "Upsert", edit: Edit<Match>) {
    this.#steps.push({
      operation,
      edit,
    });
    return this;
  }

  assert(edit: Edit<Match>) {
    return this.edit("Assert", edit);
  }

  retract(edit: Edit<Match>) {
    return this.edit("Retract", edit);
  }

  upsert(edit: Edit<Match>) {
    return this.edit("Upsert", edit);
  }

  render(view: View<Match>) {
    return this.update((props) => {
      const vnode = view(props);
      return [
        {
          Assert: [(props as any).self, "~/common/ui", vnode as any] as const,
        },
      ];
    });
  }

  update(update: Update<Match>) {
    return {
      select: this.#select,
      where: this.#where,
      update,
    };
  }

  commit(): Query<Match> {
    return {
      select: this.#select,
      where: this.#where,
    };
  }
}

/**
 * Create a datalog query builder
 * @example
 */
export const select = <Match extends Selector = Selector>(select: Match) =>
  new Select(select);

export const and = (...clauses: Array<Clause>): Clause => ({
  And: clauses,
});

export const or = (...clauses: Array<Clause>): Clause => ({
  Or: clauses,
});

export const not = (clause: Clause): Clause => ({
  Not: clause,
});

/** Case */
export const match = (
  entity: Term<Entity>,
  attribute: Term<Attribute>,
  value: Term<API.Constant>,
): Clause => ({
  Case: [entity, attribute, value],
});

export const form = <Variables extends Selector>(
  selector: Variables,
  confirm: (selector: Selector, bindings: Bindings) => Confirmation,
): Clause => ({
  Form: {
    selector,
    confirm,
  },
});

export const rule = <Match extends Selector = Selector>(
  input: Selector,
  rule?: API.Rule<Match>,
): Clause => ({
  Rule: {
    input,
    rule,
  },
});

export const is = (
  binding: Term<API.Constant>,
  value: Term<API.Constant>,
): Clause => ({
  Is: [binding, value],
});

export const formula = (formula: Formula): Clause => ({
  Match: formula,
});
