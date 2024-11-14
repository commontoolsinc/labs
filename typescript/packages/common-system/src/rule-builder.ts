import {
  Selector,
  Clause,
  InferBindings,
  Term,
  Entity,
  Attribute,
  API,
} from "datalogia";
import { $, Instruction, Fact } from "synopsys";
import { Node } from "./jsx.js";
export { $ } from "synopsys";

export type Update<Match extends Selector> = (
  props: InferBindings<Match>,
) => Array<Instruction>;

export type Edit<Match extends Selector> = (
  props: InferBindings<Match>,
) => Fact;

export type View<Match extends Selector> = (
  props: InferBindings<Match>,
) => Node<any>;

export class Where {
  #where: Array<Clause>;

  constructor(...clauses: Array<Clause>) {
    this.#where = [...clauses];
  }

  match(
    entity: Term<Entity>,
    attribute: Term<Attribute>,
    value: Term<API.Constant> = $._,
  ): Where {
    return new Where(...this.#where, {
      Case: [entity, attribute, value],
    });
  }

  or(builder: (q: Where) => Where): Where {
    const clauses = builder(new Where()).commit();
    return new Where(...this.#where, {
      Or: clauses,
    });
  }

  and(builder: (q: Where) => Where): Where {
    const clauses = builder(new Where()).commit();
    return new Where(...this.#where, {
      And: clauses,
    });
  }

  not(builder: (q: Where) => Where): Where {
    const clauses = builder(new Where()).commit();
    return new Where(...this.#where, {
      Not: {
        And: clauses,
      },
    });
  }

  commit(): Clause[] {
    return this.#where;
  }
}

export const where = (...clauses: Array<Clause>) => new Where(...clauses);

export class Select<Match extends Selector = Selector> {
  #select: Match;
  #where: Where;
  #transaction: Transaction<Match>;

  constructor(
    select: Match,
    where: Where = new Where(),
    transaction: Transaction<Match> = new Transaction(),
  ) {
    this.#select = select;
    this.#where = where;
    this.#transaction = transaction;
  }

  where(builder: (q: Where) => Where): Select<Match> {
    return new Select<Match>(this.#select, this.#where.and(builder));
  }

  match(
    entity: Term<Entity>,
    attribute: Term<Attribute>,
    value: Term<API.Constant> = $._,
  ): Select<Match> {
    return new Select<Match>(
      this.#select,
      this.#where.match(entity, attribute, value),
    );
  }

  or(builder: (q: Where) => Where): Select<Match> {
    return this.where((q) => q.or(builder));
  }

  and(builder: (q: Where) => Where): Select<Match> {
    return this.where((q) => q.and(builder));
  }

  not(builder: (q: Where) => Where): Select<Match> {
    return this.where((q) => q.not(builder));
  }

  transaction(
    builder: (q: Transaction<Match>) => Transaction<Match>,
  ): Select<Match> {
    return new Select<Match>(
      this.#select,
      this.#where,
      builder(this.#transaction),
    );
  }

  assert(edit: Edit<Match>): Select<Match> {
    return this.transaction((tx) => tx.assert(edit));
  }

  retract(edit: Edit<Match>): Select<Match> {
    return this.transaction((tx) => tx.retract(edit));
  }

  upsert(edit: Edit<Match>): Select<Match> {
    return this.transaction((tx) => tx.upsert(edit));
  }

  update(update: Update<Match>): Select<Match> {
    return this.transaction((tx) => tx.update(update));
  }

  render(view: View<Match>): Select<Match> {
    return this.transaction((tx) => tx.render(view));
  }

  commit() {
    return {
      select: this.#select,
      where: this.#where.commit(),
      update: this.#transaction.commit(),
    };
  }
}

/**
 * Create a datalog query builder
 * @example
 */
export const select = <Match extends Selector = Selector>(select: Match) =>
  new Select(select);

export class Transaction<Match extends Selector = Selector> {
  #updates: Array<Update<Match>> = [];

  constructor(...updates: Array<Update<Match>>) {
    this.#updates = updates;
  }

  assert(edit: Edit<Match>) {
    const up = (props: InferBindings<Match>): Array<Instruction> => {
      return [{ Assert: edit(props) }];
    };
    return new Transaction(...this.#updates, up);
  }

  retract(edit: Edit<Match>) {
    const up = (props: InferBindings<Match>): Array<Instruction> => {
      return [{ Retract: edit(props) }];
    };
    return new Transaction(...this.#updates, up);
  }

  upsert(edit: Edit<Match>) {
    const up = (props: InferBindings<Match>): Array<Instruction> => {
      return [{ Upsert: edit(props) }];
    };
    return new Transaction(...this.#updates, up);
  }

  update(update: Update<Match>) {
    return new Transaction(...this.#updates, update);
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

  commit() {
    return (selection: InferBindings<Match>): Array<Instruction> => {
      const changes: Array<Instruction> = [];
      for (const update of this.#updates) {
        changes.push(...update(selection));
      }
      return changes;
    };
  }
}

export const transaction = <Match extends Selector = Selector>(
  ...updates: Array<Update<Match>>
) => new Transaction(...updates);
