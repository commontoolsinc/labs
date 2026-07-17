import { isRecord } from "@commonfabric/utils/types";
import type { JSONSchema } from "../builder/types.ts";
import type { ContextualFlowControl } from "../cfc.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { isPrimitiveCellLink, parseLink } from "../link-utils.ts";

/**
 * Build the link for one raw list slot without reading the slot's value.
 *
 * A linked slot already carries its target path and optional schema, so parse
 * it directly against the list base. The list link's container schema only
 * needs narrowing when the slot is inline at this array index.
 *
 * `virtualSlot` marks a slot that came from the list schema's `default`
 * rather than a stored doc (CT-1880: the list doc is absent and the default
 * supplied the slots — see `getRaw({ schemaDefault: true })`). The slot value
 * IS that element's default slice, so it is attached as the element schema's
 * `default`, making it observable to schema-governed reads at the slot path.
 * Strictness holds because the whole list is absent in this case; slots of a
 * stored list never get synthesized defaults (a declared items-level default
 * still applies through normal narrowing).
 */
export function listElementLink(
  cfc: ContextualFlowControl,
  listBase: NormalizedFullLink,
  slot: unknown,
  index: number,
  virtualSlot = false,
): NormalizedFullLink {
  if (isPrimitiveCellLink(slot)) return parseLink(slot, listBase);

  const indexPart = String(index);
  let elementSchema = listBase.schema === undefined
    ? undefined
    : cfc.schemaAtPath(listBase.schema, [indexPart]);
  if (
    virtualSlot && slot !== undefined && elementSchema !== false &&
    !(isRecord(elementSchema) && elementSchema.default !== undefined)
  ) {
    elementSchema = isRecord(elementSchema)
      ? { ...elementSchema, default: slot } as JSONSchema
      : { default: slot } as JSONSchema;
  }
  const slotBase: NormalizedFullLink = {
    ...listBase,
    path: [...listBase.path, indexPart],
    schema: elementSchema,
  };

  return slotBase;
}
