import {
  Query,
  Selector,
  Clause,
  Transaction,
  InferBindings,
  Term,
  Entity,
  Attribute,
  API,
  Bindings,
  Confirmation,
  Formula,
} from "datalogia";
import { Reference } from "synopsys";
import { Node } from "./jsx.js";

export type Update<Match extends Selector> = (
  props: InferBindings<Match>,
) => Transaction;

export type View<Match extends Selector> = (
  props: InferBindings<Match>,
) => Node<any>;

export class Select<Match extends Selector = Selector> {
  #select: Match;
  #where: Array<Clause> = [];

  constructor(select: Match) {
    this.#select = select;
  }

  where(...clauses: Array<Clause>) {
    this.#where = [...this.#where, ...clauses];
    return this;
  }

  update(func: Update<Match>) {
    return {
      select: this.#select,
      where: this.#where,
      update: func,
    };
  }

  render(entity: Reference, view: View<Match>) {
    return this.update((props) => [
      {
        Assert: [entity, "~/common/ui", view(props) as any] as const,
      },
    ]);
  }

  done(): Query<Match> {
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

export class ClauseBuilder {
  #clause: Clause;

  constructor(clause: Clause) {
    this.#clause = clause;
  }

  and(
    entity: Term<Entity>,
    attribute: Term<Attribute>,
    value: Term<API.Constant>,
  ) {
    return new ClauseBuilder(
      and(this.#clause, match(entity, attribute, value)),
    );
  }

  or(
    entity: Term<Entity>,
    attribute: Term<Attribute>,
    value: Term<API.Constant>,
  ) {
    return new ClauseBuilder(or(this.#clause, match(entity, attribute, value)));
  }

  not() {
    return new ClauseBuilder(not(this.#clause));
  }

  done() {
    return this.#clause;
  }
}

export const matching = (
  entity: Term<Entity>,
  attribute: Term<Attribute>,
  value: Term<API.Constant>,
) => new ClauseBuilder(match(entity, attribute, value));
