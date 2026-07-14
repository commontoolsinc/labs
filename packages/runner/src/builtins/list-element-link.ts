import type { ContextualFlowControl } from "../cfc.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { isPrimitiveCellLink, parseLink } from "../link-utils.ts";

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
