/**
 * Cell-side integration of the `data:` cell URI codec. The dividing line
 * between this module and `data-uri-codec.ts` is the need for the
 * cell/link machinery: everything that can be expressed against
 * `data-model` alone lives in the codec (a leaf module); this module holds
 * the two operations that cannot -- {@link dataCellURIWithResolvedLinks},
 * which rewrites relative links against a base before encoding, and
 * {@link findAndInlineDataURILinks}, which dissolves `data:` URI links
 * back into the values they carry.
 *
 * The payload encodes the cell's VALUE, and the codec's decode entry
 * points return that value. The document view that the address grammar
 * requires (`["value", ...]`-rooted and facet paths) is synthesized by the
 * one reader that thinks in documents -- `storage/transaction/
 * attestation.ts`'s `load()` -- which also guarantees that payload content
 * can never alias a document facet (`cfc`, `source`).
 *
 * The dependency on the link machinery is one-way: this module imports
 * from `link-utils.ts`, and `link-utils.ts` imports nothing back. The
 * relationship with `cell.ts` is mutual -- this module needs `isCell` (and
 * the `Cell` type) while `cell.ts` consumes it -- the same two-way shape
 * `cell.ts` and `link-utils.ts` had while these functions lived there,
 * relocated rather than newly introduced.
 */

import {
  FabricInstance,
  FabricPrimitive,
  type FabricValue,
} from "@commonfabric/data-model/fabric-value";
import { isRecord } from "@commonfabric/utils/types";
import { type Cell, isCell } from "./cell.ts";
import { isPrimitiveCellLink, type NormalizedLink } from "./link-types.ts";
import {
  createSigilLinkFromParsedLink,
  isCellLink,
  KeepAsCell,
  parseLink,
} from "./link-utils.ts";
import { ContextualFlowControl } from "./cfc.ts";
import type { URI } from "./sigil-types.ts";
import {
  dataCellURIFromValue,
  valueFromDataCellURI,
} from "./data-uri-codec.ts";

/**
 * Makes a `data:` URI that names a cell whose content is carried in the id
 * itself. Reading such a cell means decoding its own id; there is no document
 * in a space to fetch.
 *
 * The encoded payload is the cell's value itself; the document view that
 * the address grammar needs is synthesized on read (see the module doc).
 *
 * This is the encode half of the matched set this module exists to hold;
 * {@link valueFromDataCellURI} is what reads back what this writes. Both
 * sides speak only the standard `data-model` `FabricValue` encoding
 * (tagged `fvj1:`).
 *
 * Each primitive cell link within `data` is rewritten to a full sigil link,
 * with relative links resolved against `base`. That rewriting is what makes
 * the result self-contained: the ids it embeds don't depend on where it was
 * minted, so the URI denotes the same value wherever it later gets read.
 *
 * The standard encoding canonicalizes plain-object key order (UTF-8 byte
 * order, per `3-json-encoding.md` section 10), so two runtimes holding the
 * same value mint the same id regardless of key insertion history -- the
 * property that makes this content addressing actually address content.
 *
 * @param data The value to encode. Must be acyclic.
 * @param base Optional base link; relative links within `data` are resolved
 *   against it.
 * @returns A `data:` URI naming a cell whose content is `data`.
 * @throws If `data` contains a reference cycle.
 */
export function dataCellURIWithResolvedLinks(
  data: FabricValue,
  base?: Cell | NormalizedLink,
): URI {
  const baseLink = isCell(base) ? base.getAsNormalizedFullLink() : base;

  function traverseAndAddBaseIdToRelativeLinks(
    value: FabricValue,
    seen: Set<object>,
  ): FabricValue {
    if (!isRecord(value)) return value;
    if (seen.has(value)) {
      throw new Error(`Cycle detected when creating data URI`);
    }
    seen.add(value);
    try {
      if (isPrimitiveCellLink(value)) {
        const link = parseLink(value, baseLink);
        return createSigilLinkFromParsedLink(link, {
          includeSchema: true,
          keepAsCell: KeepAsCell.All,
        });
      } else if (value instanceof FabricPrimitive) {
        // A `FabricPrimitive` is a leaf; the value encoding represents it
        // via its codec.
        return value;
      } else if (value instanceof FabricInstance) {
        // TODO(danfuzz): A `FabricInstance` is not a leaf: its state can
        // carry cell links, which need the same relative-to-absolute
        // rewriting as everything else. That requires codec-mediated
        // traversal into instance state; until that exists, the instance
        // passes through unrewritten (encoded correctly in form, but any
        // relative link within it stays relative).
        return value;
      } else if (Array.isArray(value)) {
        return value.map((item) =>
          traverseAndAddBaseIdToRelativeLinks(item, seen)
        );
      } else { // isObject
        return Object.fromEntries(
          Object.entries(value).map((
            [key, value],
          ) => [
            key,
            traverseAndAddBaseIdToRelativeLinks(value as FabricValue, seen),
          ]),
        );
      }
    } finally {
      seen.delete(value);
    }
  }

  return dataCellURIFromValue(
    traverseAndAddBaseIdToRelativeLinks(data, new Set()),
  );
}

/**
 * Find any data: URI links and inline them.
 *
 * TODO(danfuzz): This `isRecord`-gated walk has no `FabricSpecialObject`
 * guard: after the link check, a non-link `FabricPrimitive`/`FabricInstance`
 * falls into the `Object.entries` descent, which walks it by enumerable own
 * props instead of treating it as a leaf. An instance with no enumerable
 * props happens to pass through by reference, but the copy-on-write branch
 * (`{ ...value }`) silently flattens any instance whose entry inlines
 * differently into a plain object. The payload walk
 * (`dataValue[path.shift()]`) indexes into decoded content with the same
 * blindness.
 *
 * @param value - The value to find and inline data: URI links in.
 * @returns The value with any data: URI links inlined.
 */
export function findAndInlineDataURILinks(value: any): any {
  if (isCellLink(value)) {
    const dataLink = parseLink(value)!;

    if (dataLink.id?.startsWith("data:")) {
      let dataValue: any = valueFromDataCellURI(dataLink.id);
      const path = [...dataLink.path];

      // If there is a link on the way to `path`, follow it, appending remaining
      // path to the target link.
      while (dataValue !== undefined) {
        if (isPrimitiveCellLink(dataValue)) {
          // Parse the link found in the data URI
          // Do NOT pass parsedLink as base to avoid inheriting the data: URI id
          const newLink = parseLink(dataValue);
          let schema = newLink.schema;
          if (schema !== undefined && path.length > 0) {
            const cfc = new ContextualFlowControl();
            schema = cfc.getSchemaAtPath(schema, path);
          }
          // Create new link by merging dataLink with remaining path
          const newSigilLink = createSigilLinkFromParsedLink({
            // Start with values from the original data link
            ...dataLink,

            // overwrite with values from the new link
            ...newLink,

            // extend path with remaining segments
            path: [...newLink.path, ...path],

            // use resolved schema if we have one
            ...(schema !== undefined && { schema }),
          }, {
            includeSchema: true,
            keepAsCell: KeepAsCell.All,
          });
          return findAndInlineDataURILinks(newSigilLink);
        }
        if (path.length > 0) {
          dataValue = dataValue[path.shift()!];
        } else {
          break;
        }
      }

      return dataValue;
    } else {
      return value;
    }
  } else if (Array.isArray(value)) {
    let next: any[] | undefined;
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) continue;
      const current = value[index];
      const inlined = findAndInlineDataURILinks(current);
      if (next) {
        next[index] = inlined;
      } else if (!Object.is(inlined, current)) {
        // `Object.is`: an untouched `NaN` leaf comes back as the same value
        // and must not force a clone of the whole array.
        next = value.slice();
        next[index] = inlined;
      }
    }
    return next ?? value;
  } else if (isRecord(value)) {
    let next: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const inlined = findAndInlineDataURILinks(entry);
      if (next) {
        next[key] = inlined;
      } else if (!Object.is(inlined, entry)) {
        // `Object.is`: see the array case above.
        next = { ...value };
        next[key] = inlined;
      }
    }
    return next ?? value;
  } else {
    return value;
  }
}
