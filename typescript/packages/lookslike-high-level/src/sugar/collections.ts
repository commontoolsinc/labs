import {
  $,
  Reference,
  Position,
  Selection,
  Selector,
  Variable,
  Instruction,
  API,
  refer,
  isTerm,
} from "@commontools/common-system";

export type MemberSelection<Select extends Selector> = {
  at: Position.At;
  value: Selection<Select>;
};

export interface CollectionSelector {
  collection: Variable<Reference>;
  of: [{ at: Variable<Position.At>; value: Variable }];
}
export type CollectionSelection<T extends Selector> = {
  collection: Reference;
  of: [MemberSelection<T>];
};

export interface MemberSelector
  extends Record<PropertyKey, API.Term | MemberSelector> {}

function* match(
  self: Variable,
  selector: MemberSelector,
): Iterable<API.Clause> {
  if (isTerm(selector)) {
    yield { Is: [self, selector] };
  } else {
    const clauses: API.Clause[] = [];
    for (const [relation, member] of Object.entries(selector)) {
      if (isTerm(member)) {
        yield { Case: [self as API.Term<Reference>, relation, member] };
      } else {
        const nested = $[`${self}.${relation}`];
        yield { Case: [self as API.Term<Reference>, relation, nested] };
        yield* match(nested, member);
      }
    }
  }
}

export class Member<Select extends MemberSelector> {
  #select: Select;
  #variable: Variable;
  id: Reference;
  constructor(select: Select) {
    this.id = refer(select);
    this.#variable = $[`[${this.id}]`];
    this.#select = select;
  }

  get $() {
    return this.#variable;
  }

  *match(term?: API.Term): Iterable<API.Clause> {
    if (term) {
      yield { Is: [term, this.#variable] };
    }
    yield* match(this.#variable, this.#select);
  }
}

class Collection<Select extends MemberSelector = MemberSelector> {
  collection: Variable<Reference>;
  of: [{ at: Variable<Position.At>; value: Select }];
  #member: Member<Select>;
  #at: Variable<Position.At>;

  constructor(select: Select) {
    this.#member = new Member(select);
    this.#at = $[`${this.#member.id}@`];
    this.collection = $[`${this.#member.id}[]`];
    this.of = [
      {
        at: this.#at,
        value: select,
      },
    ];
  }

  get $() {
    return this.collection;
  }

  /**
   * It is expected to provide a single named reference to the owner of the
   * collection. Although you could technically provide a multiple owner
   * references in which case relation with each one will be captured.
   */
  new(
    relations: Record<string, Reference>,
    members: Selection<Select>[] = [],
  ): TransactionBuilder<Select> {
    const collection = refer({ relations });
    const instructions: Instruction[] = [];
    for (const [key, owner] of Object.entries(relations)) {
      instructions.push({
        Assert: [owner, key, collection],
      });
    }

    const transaction = new TransactionBuilder(collection, instructions);
    for (const member of members) {
      transaction.push(member);
    }

    return transaction as TransactionBuilder<Select>;
  }

  from(selection: CollectionSelection<Select>) {
    return new CollectionView(selection);
  }

  get select() {
    return {
      collection: this.collection,
      of: this.of,
    }
  }

  match(term: API.Term): API.Clause {
    return {
      And: [
        { Is: [term, this.$] },
        { Case: [this.$, this.#at, this.#member.$] },
        ...this.#member.match(),
      ],
    };
  }
}

export class CollectionView<Select extends Selector> {
  #model: CollectionSelection<Select>;

  constructor(model: CollectionSelection<Select>) {
    this.#model = model;
  }
  *[Symbol.iterator]() {
    yield* this.values();
  }
  get first() {
    return this.#model.of[0];
  }
  get last() {
    return this.#model.of.at(-1);
  }
  entries() {
    return this.#model.of
      .sort((left, right) => left.at.localeCompare(right.at))
      .map(({ at: key, value }) => [key, value] as const);
  }
  values() {
    return this.entries().map(([, value]) => value);
  }
  keys() {
    return this.entries().map(([key]) => key);
  }

  edit() {
    return new TransactionBuilder(
      this.#model.collection,
      [],
      this.first,
      this.last,
    );
  }
  insert(
    member: Selection<Select>,
    {
      before,
      after,
    }: {
      before?: MemberSelection<Select> | null;
      after?: MemberSelection<Select> | null;
    } = {},
  ) {
    const builder = this.edit();
    builder.insert(member, { before, after });
    return builder;
  }

  push(member: Selection<Select>) {
    return this.insert(member, { after: this.last, before: null });
  }
  unshift(member: Selection<Select>) {
    return this.insert(member, { before: this.first, after: null });
  }
}

export class TransactionBuilder<Select extends Selector>
  implements Iterable<Instruction>
{
  #instructions: Instruction[];
  #self: Reference;

  constructor(
    self: Reference,
    instructions: Instruction[] = [],
    public first: MemberSelection<Select> | undefined = undefined,
    public last: MemberSelection<Select> | undefined = undefined,
  ) {
    this.#instructions = instructions;
    this.#self = self;
  }

  /**
   * It is expected to provide a single named reference to the owner of the
   * collection. Although you could technically provide a multiple owner
   * references in which case relation with each one will be captured.
   */
  static new<Select extends Selector>(
    relations: Record<string, Reference>,
    members: Selection<Select>[] = [],
  ): TransactionBuilder<Select> {
    const collection = refer({ relations });
    const instructions: Instruction[] = [];
    for (const [key, owner] of Object.entries(relations)) {
      instructions.push({
        Assert: [owner, key, collection],
      });
    }

    const transaction = new TransactionBuilder(collection, instructions);
    for (const member of members) {
      transaction.push(member);
    }

    return transaction as TransactionBuilder<Select>;
  }

  push(member: Selection<Select>) {
    return this.insert(member, { after: this.last });
  }
  unshift(member: Selection<Select>) {
    return this.insert(member, { before: this.first });
  }

  insert(
    member: Selection<Select>,
    {
      after = this.first,
      before = this.last,
    }: {
      before?: MemberSelection<Select> | null;
      after?: MemberSelection<Select> | null;
    } = {},
  ) {
    const site = {
      ...(before ? { before: before.at } : {}),
      // Need to make sure that we do not pass same before and after because
      // there will be no position between the two.
      ...(after && after.at != before?.at ? { after: after.at } : {}),
    };

    // We derive unique reference to the element in the collection
    // at a desired position.
    const entity = refer({ member, of: this.#self, site });

    // Derive a bias that will be used to offset position slightly
    // in order to create wiggle room for concurrent inserts in the same range.
    const bias = entity["/"].subarray(-4);
    const at = Position.insert(bias, site);

    this.#instructions.push({
      Assert: [this.#self, at, entity],
    });

    for (const [key, value] of Object.entries(member)) {
      // ⚠️ Need to handle deep traversal case, but otherwise it should do what
      // one expects
      if (value && typeof value === "object" && !value["/"]) {
        throw new TypeError("Nested objects must be References");
      }
      this.#instructions.push({
        Assert: [entity, key, value],
      });
    }
    const view = new MemberView(entity, at, member);

    if (this.last == null) {
      this.first = view;
    }

    if (this.first == null) {
      this.first = view;
    }

    return this;
  }
  *[Symbol.iterator]() {
    yield* this.#instructions;
  }
}

class MemberView<Select extends Selector> implements Reference {
  #entity: Reference;
  at: Position.At;
  value: Selection<Select>;
  constructor(entity: Reference, at: Position.At, value: Selection<Select>) {
    this.#entity = entity;
    this.at = at;
    this.value = value;
  }
  get ["/"]() {
    return this.#entity["/"];
  }
  toString() {
    return this.#entity.toString();
  }
  toJSON() {
    return {
      ...this.#entity.toJSON(),
      at: this.at,
    };
  }
}

export const of = <Select extends MemberSelector>(member: Select) =>
  new Collection(member);
