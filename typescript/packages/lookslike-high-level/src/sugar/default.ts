import { $, Clause, Reference, Variable } from "@commontools/common-system";

export function defaultTo(
  entity: Variable<any>,
  attribute: string,
  field: Variable<any>,
  defaultValue: any,
): Clause {
  return {
    Or: [
      {
        And: [
          { Not: { Case: [entity, attribute, $._] } },
          { Match: [defaultValue, "==", field] },
        ],
      },
      { Case: [entity, attribute, field] },
    ],
  };
}

export function isEmpty(self: Variable<Reference>, attribute: string): Clause {
  return { Not: { Case: [self, attribute, $._] } };
}
