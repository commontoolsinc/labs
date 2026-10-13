/**
 * Cell-side integration of the `data:` cell URI codec. The dividing line
 * between this module and `data-model`'s `codec-data-uri.ts` is the need
 * for the cell/link machinery: everything that can be expressed against
 * `data-model` alone lives in the codec (in that package); this module
 * holds the two operations that cannot -- {@link dataUriFromValueWithResolvedLinks},
 * which rewrites relative links against a base before encoding (and whose
 * companion {@link dataUriSnapshotWithResolvedLinks} also returns the value
 * to walk under the result), and {@link findAndInlineDataUriLinks}, which
 * dissolves `data:` URI links back into the values they carry.
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
  refuseFabricInstance,
} from "@commonfabric/data-model";
import { linkRefFrom, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import {
  dataUriFromValue,
  isFabricDataUri,
  valueFromDataUri,
} from "@commonfabric/data-model/codec-data-uri";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { type Cell, isCell } from "./cell.ts";
import { ContextualFlowControl } from "./cfc.ts";
import {
  isPrimitiveCellLink,
  type NormalizedLink,
  type PrimitiveCellLink,
} from "./link-types.ts";
import {
  createSigilLinkFromParsedLink,
  isCellLink,
  KeepAsCell,
  parseLink,
} from "./link-utils.ts";
import type { URI } from "./sigil-types.ts";

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
 * A link's schema is encoded as given. Where that is a content-addressed
 * reference, a read resolves it in the space carried by the address that
 * names the returned URI, so a caller minting from a value read out of a
 * stored document addresses the result in that document's space, which
 * holds the schema documents the reference names. Nothing here checks that
 * the space a caller goes on to use holds them.
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
  return mintWithResolvedLinks(data, baseLinkOf(base)).id;
}

/**
 * Like {@link dataUriFromValueWithResolvedLinks}, except that it also returns
 * the value a reader walks under the URI.
 *
 * That value is `data` with one change: a link that names no document is
 * given the id of `base`. Such a link takes its id from the address it is
 * read under, which under the `data:` address is the snapshot itself, so
 * `data` walked there as given would read the link's path inside the
 * snapshot. Every other link is `data`'s own, schema included, and `data`
 * itself is returned where it holds no such link or `base` has no id.
 *
 * The returned value shares the containers of `data` it did not rewrite, so
 * it is to be read and not written.
 *
 * @param data The value to encode. Must be acyclic.
 * @param base Optional base link; relative links within `data` are resolved
 *   against it.
 * @returns The `data:` URI as `id`, and the value to walk under it as `value`.
 * @throws If `data` contains a reference cycle.
 */
export function dataUriSnapshotWithResolvedLinks(
  data: FabricValue,
  base?: Cell | NormalizedLink,
): { id: URI; value: FabricValue } {
  const baseLink = baseLinkOf(base);
  const { id, namesNoDocument } = mintWithResolvedLinks(data, baseLink);
  const baseId = baseLink?.id;
  const value = namesNoDocument && baseId !== undefined
    ? mapLinks(data, (link) => {
      const payload = linkRefPayload(link);
      return payload.id === undefined
        ? linkRefFrom({ ...payload, id: baseId })
        : link;
    })
    : data;
  return { id, value };
}

/** Returns the link a `base` argument of this module's mint functions names. */
function baseLinkOf(
  base: Cell | NormalizedLink | undefined,
): NormalizedLink | undefined {
  return isCell(base) ? base.getAsNormalizedFullLink() : base;
}

/**
 * Helper for the two mint functions, which encodes `data` with each link in
 * it rewritten to a full sigil link resolved against `baseLink`, and reports
 * as `namesNoDocument` whether any link in `data` named no document.
 *
 * @throws If `data` contains a reference cycle.
 */
function mintWithResolvedLinks(
  data: FabricValue,
  baseLink: NormalizedLink | undefined,
): { id: URI; namesNoDocument: boolean } {
  let namesNoDocument = false;
  const encoded = mapLinks(data, (link) => {
    if (linkRefPayload(link).id === undefined) namesNoDocument = true;
    return createSigilLinkFromParsedLink(parseLink(link, baseLink), {
      includeSchema: true,
      keepAsCell: KeepAsCell.All,
    });
  });
  return { id: dataUriFromValue(encoded), namesNoDocument };
}

/**
 * Helper for the two mint functions, which returns `value` with each
 * primitive cell link in it replaced by what `rewrite` returns for it.
 *
 * @throws If `value` contains a reference cycle.
 */
function mapLinks(
  value: FabricValue,
  rewrite: (link: PrimitiveCellLink) => FabricValue,
  seen: Set<object> = new Set(),
): FabricValue {
  if (!isObjectOrArray(value)) return value;
  if (seen.has(value)) {
    throw new Error(`Cycle detected when creating data URI`);
  }
  seen.add(value);
  try {
    if (isPrimitiveCellLink(value)) {
      return rewrite(value);
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
      // Copy on write, here and in the object branch below: a container
      // whose members all come back by identity is returned by identity
      // too, so the encoder that reads the result gets the caller's own
      // containers. A value carrying no link anywhere within it comes
      // through this walk without an allocation.
      let next: FabricValue[] | undefined;
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) continue;
        const current = value[index];
        const rewritten = mapLinks(current, rewrite, seen);
        if (next) {
          next[index] = rewritten;
        } else if (!Object.is(rewritten, current)) {
          next = value.slice();
          next[index] = rewritten;
        }
      }
      return next ?? value;
    } else { // not an array
      let next: Record<string, FabricValue> | undefined;
      for (const [key, entry] of Object.entries(value)) {
        const rewritten = mapLinks(entry, rewrite, seen);
        if (next) {
          next[key] = rewritten;
        } else if (!Object.is(rewritten, entry)) {
          next = { ...value };
          next[key] = rewritten;
        }
      }
      return next ?? value;
    }
  } finally {
    seen.delete(value);
  }
}

/**
 * Find any data: URI links and inline them.
 *
 * Only this codec's media type is inlined, the one
 * {@link dataUriFromValue} mints. A link naming a `data:` URI of any other
 * media type is returned as it came in, on the same footing as a link
 * naming a document in a space.
 *
 * The value a `data:` link carries is searched in turn, so a `data:` link
 * held inside it is inlined as well, to any depth.
 *
 * A `FabricPrimitive` comes back as the same instance: a leaf holds no link to
 * inline. A `FabricInstance` is refused, since passing one through would leave
 * a link inside it un-inlined. The refusal covers `value` and the root of the
 * value a `data:` link carries. A `FabricInstance` below that root comes back
 * as the same instance, with any link inside it left as it is, unless
 * `options.refuseCarriedInstances` asks for the refusal there as well.
 *
 * @param value - The value to find and inline data: URI links in.
 * @param options.refuseCarriedInstances - Refuses a `FabricInstance` anywhere
 *   in the value a `data:` link carries. For a caller whose destination admits
 *   no instance, where returning one whole would put it there.
 * @returns The value with any data: URI links inlined.
 * @throws If it reaches a `FabricInstance` it refuses.
 */
export function findAndInlineDataUriLinks(
  value: any,
  options: { refuseCarriedInstances?: boolean } = {},
): any {
  return inlineDataUriLinks(
    value,
    false,
    options.refuseCarriedInstances === true,
  );
}

/**
 * Recursive worker for {@link findAndInlineDataUriLinks}. `decoded` says
 * `value` lies inside the value a `data:` link carried, where a
 * `FabricInstance` is returned whole unless `refuseCarried` is set.
 */
function inlineDataUriLinks(
  value: any,
  decoded: boolean,
  refuseCarried: boolean,
): any {
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
          return inlineDataUriLinks(newSigilLink, decoded, refuseCarried);
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

      // The decoded payload gets the same dispatch the walk applies anywhere
      // else. Without it the refusal below has a bypass: an instance handed
      // over directly is refused, while the same one decoded out of a `data:`
      // URI leaves silently, and a guard with a way around it is worse than no
      // guard, since it reads as covering the case.
      if (dataValue instanceof FabricInstance) {
        refuseFabricInstance(
          dataValue,
          "when inlining a `data:` URI whose content is a `FabricInstance`",
        );
      }

      // The payload can hold a `data:` link of its own, an immutable cell
      // that was handed a snapshot's cell for one, so it is walked as well.
      // The descent ends: an id embedded in a payload is shorter than the id
      // that encodes the payload, so no id can contain itself.
      return inlineDataUriLinks(dataValue, true, refuseCarried);
    } else {
      return value;
    }
  } else if (Array.isArray(value)) {
    let next: any[] | undefined;
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) continue;
      const current = value[index];
      const inlined = inlineDataUriLinks(current, decoded, refuseCarried);
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
    // A leaf, and `isObjectOrArray`, so it leaves ahead of the record branch below.
    // It holds no link to inline, so returning it whole is the answer rather
    // than an omission.
    return value;
  } else if (value instanceof FabricInstance) {
    // Below the root of a decoded payload an instance is returned whole, and
    // a link inside it survives as a link, for a caller that has not asked
    // for the refusal there.
    if (decoded && !refuseCarried) return value;

    // Refused. An instance's state can carry a `data:` URI link, and inlining
    // those is what this walk is for, so passing the value through would hand
    // it back _untransformed_ -- the link surviving as a link, the walk's
    // purpose defeated for everything inside the wrapper.
    //
    // Nothing reaches this today, de facto rather than by construction. A link
    // ends up inside an error only if an author attaches a cell to one, which
    // `fabricFromConvertibleJsValue()` would then convert, and nothing in the
    // tree does that; the whole suite runs green with this throw in place.
    //
    // It cannot be narrowed to instances that actually carry such a link, which
    // is the shape that would sound safer: deciding that means reading the
    // instance's codec contents, the very traversal whose absence causes the
    // gap. So it is all instances or none -- and a tripwire that announces
    // itself the moment these classes see real use beats a comment nobody runs.
    //
    // TODO(danfuzz): descend by codec-mediated traversal into instance state,
    // at which point this becomes a walk rather than a refusal -- the same gap
    // marked at the sibling walk in `dataUriFromValueWithResolvedLinks()`.
    refuseFabricInstance(value, "when inlining `data:` URI links");
  } else if (isObjectOrArray(value)) {
    let next: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const inlined = inlineDataUriLinks(entry, decoded, refuseCarried);
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
