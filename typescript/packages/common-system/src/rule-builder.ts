import {
  Selector,
  Clause,
  InferBindings,
  Term,
  Entity,
  Attribute,
  API,
  Formula,
  Variable,
} from "datalogia";
import { $, Instruction, Fact, Scalar } from "synopsys";
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

export type BuilderOrValue<T> = ((q: T) => T) | T;

export type CommandBuilder<Match extends Selector> = (
  props: InferBindings<Match>,
  cmd: Commands,
) => void;

function transact<T extends Selector>(
  selection: InferBindings<T>,
  action: CommandBuilder<T>,
) {
  const cmd = new Commands();
  action(selection, cmd);
  return cmd.commit();
}

class Commands {
  commands: Instruction[];

  constructor() {
    this.commands = [];
  }

  add(...commands: Instruction[]) {
    this.commands.push(...commands);
  }

  commit() {
    return this.commands;
  }
}

export class Select<Match extends Selector = Selector> {
  #select: Match;
  #where: WhereBuilder;
  #transaction: TransactionBuilder<Match>;

  constructor(
    select: Match,
    where: WhereBuilder = new WhereBuilder(),
    transaction: TransactionBuilder<Match> = new TransactionBuilder(),
  ) {
    this.#select = select;
    this.#where = where;
    this.#transaction = transaction;
  }

  where(builder: BuilderOrValue<WhereBuilder>): Select<Match> {
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

  matches(
    ...match: Array<
      [
        entity: Term<Entity>,
        attribute: Term<Attribute>,
        value: Term<API.Constant>,
      ]
    >
  ): Select<Match> {
    return new Select<Match>(
      this.#select,
      match.reduce(
        (where, [entity, attribute, value]) =>
          where.match(entity, attribute, value),
        this.#where,
      ),
    );
  }

  clause(clause: Clause) {
    return new Select<Match>(this.#select, this.#where.clause(clause));
  }

  select<S extends Selector>(selector: S) {
    return new Select<S & Match>({ ...this.#select, ...selector }, this.#where);
  }

  with<T extends Selector>(other: Select<T>): Select<T & Match> {
    return new Select(
      { ...this.#select, ...other.#select },
      this.#where.merge(other.#where),
    );
  }

  event<T extends Scalar>(name: string) {
    return new Select<Match & { event: Variable<T> }>(
      {
        ...this.#select,
        event: $.event,
      },
      this.#where.match(
        $.self,
        name.startsWith("~/on/") ? name : `~/on/${name}`,
        $.event,
      ),
    );
  }

  or(builder: BuilderOrValue<WhereBuilder>): Select<Match> {
    return this.where(q => q.or(builder));
  }

  and(builder: BuilderOrValue<WhereBuilder>): Select<Match> {
    return this.where(q => q.and(builder));
  }

  not(builder: BuilderOrValue<WhereBuilder>): Select<Match> {
    return this.where(q => q.not(builder));
  }

  transaction(
    builder: (q: TransactionBuilder<Match>) => TransactionBuilder<Match>,
  ): Select<Match> {
    return new Select<Match>(
      this.#select,
      this.#where,
      builder(this.#transaction),
    );
  }

  assert(edit: Edit<Match>): Select<Match> {
    return this.transaction(tx => tx.assert(edit));
  }

  retract(edit: Edit<Match>): Select<Match> {
    return this.transaction(tx => tx.retract(edit));
  }

  upsert(edit: Edit<Match>): Select<Match> {
    return this.transaction(tx => tx.upsert(edit));
  }

  update(update: Update<Match>): Select<Match> {
    return this.transaction(tx => tx.update(update));
  }

  transact(commandBuilder: CommandBuilder<Match>) {
    return this.transaction(tx =>
      tx.update(selection => transact(selection, commandBuilder)),
    ).commit();
  }

  render(view: View<Match>): Select<Match> {
    return this.transaction(tx => tx.render(view));
  }

  commit() {
    return {
      select: this.#select,
      where: this.#where.commit(),
      update: this.#transaction.commit(),
    };
  }

  get selector(): Match {
    return { ...this.#select };
  }

  get constraints(): WhereBuilder {
    return this.#where;
  }

  get clauses(): Clause[] {
    return this.#where.commit();
  }
}

/**
 * Create a datalog query builder
 * @example
 */
export const select = <Match extends Selector = Selector>(select: Match) =>
  new Select(select);

export class WhereBuilder {
  #where: Array<Clause>;

  constructor(...clauses: Array<Clause>) {
    this.#where = [...clauses];
  }

  merge(other: WhereBuilder): WhereBuilder {
    return new WhereBuilder(...this.#where, ...other.#where);
  }

  match(
    entity: Term<Entity>,
    attribute: Term<Attribute>,
    value: Term<API.Constant> = $._,
  ): WhereBuilder {
    return new WhereBuilder(...this.#where, {
      Case: [entity, attribute, value],
    });
  }

  formula<F extends Formula>(f1: F[0], f2: F[1], f3: F[2]) {
    return new WhereBuilder(...this.#where, {
      Match: [f1, f2, f3] as Formula,
    });
  }

  or(builder: BuilderOrValue<WhereBuilder>): WhereBuilder {
    const where: WhereBuilder =
      typeof builder === "function" ? builder(new WhereBuilder()) : builder;
    return new WhereBuilder(...this.#where, {
      Or: where.commit(),
    });
  }

  and(builder: BuilderOrValue<WhereBuilder>): WhereBuilder {
    const where: WhereBuilder =
      typeof builder === "function" ? builder(new WhereBuilder()) : builder;
    return new WhereBuilder(...this.#where, {
      And: where.commit(),
    });
  }

  not(builder: BuilderOrValue<WhereBuilder>): WhereBuilder {
    const where: WhereBuilder =
      typeof builder === "function" ? builder(new WhereBuilder()) : builder;
    return new WhereBuilder(...this.#where, {
      Not: {
        And: where.commit(),
      },
    });
  }

  clause(clause: Clause) {
    return new WhereBuilder(...this.#where, clause);
  }

  commit(): Clause[] {
    return this.#where;
  }
}

export const where = (...clauses: Array<Clause>) =>
  new WhereBuilder(...clauses);

export class TransactionBuilder<Match extends Selector = Selector> {
  #updates: Array<Update<Match>> = [];

  constructor(...updates: Array<Update<Match>>) {
    this.#updates = updates;
  }

  assert(edit: Edit<Match>) {
    const up = (props: InferBindings<Match>): Array<Instruction> => {
      return [{ Assert: edit(props) }];
    };
    return new TransactionBuilder(...this.#updates, up);
  }

  retract(edit: Edit<Match>) {
    const up = (props: InferBindings<Match>): Array<Instruction> => {
      return [{ Retract: edit(props) }];
    };
    return new TransactionBuilder(...this.#updates, up);
  }

  upsert(edit: Edit<Match>) {
    const up = (props: InferBindings<Match>): Array<Instruction> => {
      return [{ Upsert: edit(props) }];
    };
    return new TransactionBuilder(...this.#updates, up);
  }

  update(update: Update<Match>) {
    return new TransactionBuilder(...this.#updates, update);
  }

  render(view: View<Match>) {
    return this.update(props => {
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
) => new TransactionBuilder(...updates);
