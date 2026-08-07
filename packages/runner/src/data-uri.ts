/**
 * Cell-side integration of the `data:` cell URI codec. The dividing line
 * between this module and `data-model`'s `data-uri-codec.ts` is the need
 * for the cell/link machinery: everything that can be expressed against
 * `data-model` alone lives in the codec (in that package); this module
 * holds the two operations that cannot -- {@link dataUriFromValueWithResolvedLinks},
 * which rewrites relative links against a base before encoding, and
 * {@link findAndInlineDataUriLinks}, which dissolves `data:` URI links
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
import { refuseFabricInstance } from "./fabric-special-object.ts";
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
  dataUriFromValue,
  isFabricDataUri,
  valueFromDataUri,
} from "@commonfabric/data-model/data-uri-codec";

/**
 * Makes a `data:` URI that names a cell whose content is carried in the id
 * itself. Reading such a cell means decoding its own id; there is no document
 * in a space to fetch.
 *
 * The encoded payload is the cell's value itself; the document view that
 * the address grammar needs is synthesized on read (see the module doc).
 *
 * This is the encode half of the matched set this module exists to hold;
 * {@link valueFromDataUri} is what reads back what this writes. Both
 * sides speak only the standard `data-model` `FabricValue` encoding, which
 * carries that codec's prefix tag.
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
export function dataUriFromValueWithResolvedLinks(
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
            traverseAndAddBaseIdToRelativeLinks(value, seen),
          ]),
        );
      }
    } finally {
      seen.delete(value);
    }
  }

  return dataUriFromValue(
    traverseAndAddBaseIdToRelativeLinks(data, new Set()),
  );
}

/**
 * Find any data: URI links and inline them.
 *
 * Only this codec's media type is inlined, the one
 * {@link dataUriFromValue} mints. A link naming a `data:` URI of any other
 * media type is returned as it came in, on the same footing as a link
 * naming a document in a space.
 *
 * A `FabricPrimitive` comes back as the same instance: a leaf holds no link to
 * inline. A `FabricInstance` is refused, since passing one through would leave
 * a link inside it un-inlined.
 *
 * @param value - The value to find and inline data: URI links in.
 * @returns The value with any data: URI links inlined.
 */
export function findAndInlineDataUriLinks(value: any): any {
  if (isCellLink(value)) {
    const dataLink = parseLink(value)!;

    if (dataLink.id !== undefined && isFabricDataUri(dataLink.id)) {
      let dataValue: any = valueFromDataUri(dataLink.id);
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
            schema = ContextualFlowControl.getSchemaAtPath(schema, path);
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
          return findAndInlineDataUriLinks(newSigilLink);
        }
        if (path.length > 0) {
          // TODO(danfuzz): a path segment naming something inside a
          // `FabricInstance` indexes it by property name and yields
          // `undefined`, because an instance's contents are reachable only
          // through its codec. A `FabricPrimitive` needs nothing here: it is a
          // leaf, so no path can legitimately point inside one.
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
      const inlined = findAndInlineDataUriLinks(current);
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
  } else if (value instanceof FabricPrimitive) {
    // A leaf, and `isRecord`, so it leaves ahead of the record branch below.
    // It holds no link to inline, so returning it whole is the answer rather
    // than an omission.
    return value;
  } else if (value instanceof FabricInstance) {
    // NOT answered by passing through. An instance's state can carry a `data:`
    // URI link -- a `FabricError`'s extras bag, for one -- and this walk exists
    // to inline exactly those. Handing the value back whole hands it back
    // _untransformed_, so the link survives as a link and the walk's purpose is
    // defeated for everything inside the wrapper. It refuses rather than doing
    // that quietly.
    //
    // Nothing reaches this in production today, de facto rather than by
    // construction: a `FabricError` is ungated and exposed to pattern authors,
    // so what keeps this safe is that nothing yet routes one through a `data:`
    // URI.
    //
    // TODO(danfuzz): descend by codec-mediated traversal into instance state,
    // at which point this becomes a walk rather than a refusal -- the same gap
    // marked at the sibling walk in `dataUriFromValueWithResolvedLinks()`.
    refuseFabricInstance(value, "when inlining `data:` URI links");
  } else if (isRecord(value)) {
    let next: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const inlined = findAndInlineDataUriLinks(entry);
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
