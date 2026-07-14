import type { ContextualFlowControl } from "../cfc.ts";
import type { Cell } from "../cell.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { isPrimitiveCellLink, parseLink } from "../link-utils.ts";

const LIST_ELEMENT_PATTERN_INPUT_SCHEMA = { type: "unknown" } as const;

/**
 * Build the link for one raw list slot without reading the slot's value.
 *
 * A linked slot already carries its target path and optional schema, so parse
 * it directly against the list base. The list link's container schema only
 * needs narrowing when the slot is inline at this array index.
 */
export function listElementLink(
  cfc: ContextualFlowControl,
  listBase: NormalizedFullLink,
  slot: unknown,
  index: number,
): NormalizedFullLink {
  if (isPrimitiveCellLink(slot)) return parseLink(slot, listBase);

  const indexPart = String(index);
  const elementSchema = listBase.schema === undefined
    ? undefined
    : cfc.schemaAtPath(listBase.schema, [indexPart]);
  const slotBase: NormalizedFullLink = {
    ...listBase,
    path: [...listBase.path, indexPart],
    schema: elementSchema,
  };

  return slotBase;
}

/**
 * Keep the coordinator's schema-bearing element cell identity-only when it is
 * passed into the child pattern. The child pattern's argument schema supplies
 * the value shape; serializing the source's structural type here would turn a
 * direct alias callback into a materialized value instead of a reference.
 */
export function listElementPatternInput(element: Cell<any>): Cell<any> {
  return element.asSchema(LIST_ELEMENT_PATTERN_INPUT_SCHEMA);
}
