import { h, $, Instruction, Select, select, refer, Rule, Reference } from '@commontools/common-system'

const CAUSE = "instance/cause"
const NEW = "~/new"

export const build = (membership: string): Rule => {
    return {
      select: {
        self: $.self,
        cause: $.cause,
        data: $.new
      },
      where: [
          { Case: [$.self, NEW, $.new] },
          {Or: [
            { Case: [$.self, CAUSE, $.cause] },
            {
              And: [
                { Not: { Case: [$.self, CAUSE, $._] } },
                { Match: [null, "==", $.cause] }
              ]
            }
          ]}
      ],
      update: ({ cause, self, data }: { cause: Reference, self: Reference, data: Reference }) => {
        const entity = refer({ data, after: cause, of: self })
        const changes: Instruction[] = [
          { Retract: [self, NEW, data]},
          { Upsert: [self, CAUSE, entity] },
          { Assert: [self, membership, entity] }
        ]

        // Assert all relations on the given member.
        for (const [key, value] of Object.entries(fromReference(data))) {
          changes.push({ Assert: [entity, key, value] })
        }

        return changes;
      }
    }
}

const refs = new WeakMap()

export const toReference = (options: Record<string, any>) => {
  const reference = refer(options)
  refs.set(reference, options)
  return reference
}

export const fromReference = (reference: Reference): Record<string, any> => {
  const data = refs.get(reference)
  if (data == undefined) {
    throw new ReferenceError(`Reference not found`)
  }
  return data
}

export const make = (self: Reference, relations: Record<string, any>): Instruction => {
  for (const value of Object.values(relations)) {
    if (value !== null && typeof value === 'object') {
      throw new Error('Only scalar values are allowed')
    }
  }

  return {
    // DB data model does not support structured data, just scalars.
    // For replicated facts we'd need to serialize relations then
    // deserialize them, however since it's local facts we simply
    // store corresponding data in the weak map to avoid serialize
    // deserialize steps.
    Upsert: [self, NEW, toReference(relations)]
  }
}
