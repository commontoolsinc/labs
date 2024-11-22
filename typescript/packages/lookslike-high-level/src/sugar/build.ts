import { h, $, Instruction, Select, select, refer, Rule, Reference, Session } from '@commontools/common-system'
import { Variable } from 'datalogia'

const CAUSE = "instance/cause"
const NEW = "~/new"

// bf: add helper function to do this annotation (rule() ?)
export const build = (membership: string): Rule<{ cause: Variable<Reference>, self: Variable<Reference>, data: Variable<Reference> }> => {
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
      update: ({ cause, self, data }) => {
        const entity = refer({ data, after: cause, of: self })
        const changes: Instruction[] = [
          { Retract: [self, NEW, data]},
          { Upsert: [self, CAUSE, entity] },
          { Assert: [self, membership, entity] }
        ]

        // Assert all relations on the given member.
        for (const [key, value] of Object.entries(Session.resolve(data) as Record<string, any>)) {
          changes.push({ Assert: [entity, key, value] })
        }

        return changes;
      }
    }
}

export const fromReference = (reference: Reference): Record<string, any> => {
  const data = Session.resolve(reference)
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
    Upsert: [self, NEW, relations as any]
  }
}
