import { Position, refer, Type, } from "synopsys"
import { Clause, Entity, Instruction, Selector, Term, Variable, Constant, InferBindings } from "datalogia";
import { $, Reference } from "@commontools/common-system";

export type CollectionSelection = {
  collection: any,
  of: [{
    key: any,
    value: any
  }]
}

type At = {
  before?: any,
  after?: any,
}

export class Collection {
  #model: InferBindings<CollectionSelection>;

  static select(variable: Variable): CollectionSelection {
    const key = $[`${variable.toString()}.key`]
    const value = $[`${variable.toString()}.value`]
    return {
      collection: variable,
      of: [{ key, value }]
    }
  }
  static includes(collection: Term<Entity>, member: Term<Entity>): Clause {
    const key = $[`${collection.toString()}.key`]
    const value = $[`${collection.toString()}.value`]
    return {
      And: [
        { Case: [collection, key, value] },
        { Match: [$.value, '==', member] }
      ]
    }
  }

  static new(context: Reference, membership: string): Instruction {
    return { Assert: [context, membership, refer({ context, membership, items: [] })] }
  }

  static from(model: InferBindings<CollectionSelection>) {
    return new Collection(model)
  }
  constructor(model: InferBindings<CollectionSelection>) {
    this.#model = model
  }
  [Symbol.iterator]() {
    return this.values()
  }
  get first() {
    return this.#model.of[0]
  }
  get last() {
    return this.#model.of.at(-1)
  }
  entries() {
    return this.#model
        .of
        .sort((left, right) => left.key.localeCompare(right.key))
        .map(({ key, value }) => [key, value])
  }
  values() {
    return this.entries().map(([, value]) => value)
  }
  keys() {
    return this.entries().map(([key]) => key)
  }
  insert(member: Record<string, Term>, at: At): Instruction[] {
    const collection = this.#model
    const before = at.before ? collection.of.find($ => $.value === at.before) : undefined
    const after = at.after ? collection.of.find($ => $.value === at.after) : undefined
    const position = Position.insert(member, { before, after })

    // We derive reference from the source data collection and a position within it.
    const entity = refer({ member, at, of: collection })

    const changes: Instruction[] = [{
      Assert: [
        collection.collection,
        position,
        entity
      ]
    }]

    for (const [key, value] of Object.entries(member)) {
      // ⚠️ Need to handle deep traversal case, but otherwise it should do what
      // one expects
      if (value && typeof value === 'object' && !(value['/'])) {
        throw new TypeError('Nested objects must be References')
      }
      changes.push({
        Assert: [entity, key, value]
      })
    }

    return changes
  }
}
