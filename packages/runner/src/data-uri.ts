/**
 * Immutable cell export and portable data-URI integration. Native snapshots
 * preserve a relative-link origin; outbound writes materialize those links and
 * expand immutable references to their contents. Portable data URIs use the
 * canonical data-model codec and remain available for offline capture.
 *
 * Both formats carry a cell value. Storage supplies the separate document
 * wrapper, keeping payload properties distinct from document facets.
 */

import {
  cloneIfNecessary,
  deepFreeze,
  FabricInstance,
  FabricPrimitive,
  type FabricValue,
  hashStringOf,
  refuseFabricInstance,
} from "@commonfabric/data-model";
import {
  codecOf,
  NULL_LIVE_ENVIRONMENT,
} from "@commonfabric/data-model/codec-common";
import { linkRefFrom, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import {
  dataUriFromValue,
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
  inlineExternalSchemaRefsInValue,
  isCellLink,
  KeepAsCell,
  parseLink,
} from "./link-utils.ts";
import {
  externalResolutionMissCount,
  onSchemaRegistryClear,
} from "./schema-registry.ts";
import type { URI } from "./sigil-types.ts";
import {
  immutableSnapshot,
  inlineCellValue,
  isImmutableCellId,
  isInlineCellId,
} from "./immutable-cell.ts";

/**
 * Makes a `data:` URI that names a cell whose content is carried in the id
 * itself. Reading such a cell means decoding its own id; there is no document
 * in a space to fetch.
 *
 * The encoded payload is the cell's value itself; the document view that
 * the address grammar needs is synthesized on read (see the module doc).
 *
 * This is the encode half of the matched set this module exists to hold;
 * `valueFromDataUri` is what reads back what this writes. Both
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
  includeSchemas = false,
): FabricValue {
  if (!isObjectOrArray(value)) return value;
  if (seen.has(value)) {
    throw new Error(`Cycle detected when creating data URI`);
  }
  seen.add(value);
  try {
    if (isPrimitiveCellLink(value)) {
      if (includeSchemas) {
        const link = inlineExternalSchemaRefsInValue(value);
        const payload = linkRefPayload(link);
        const schema = mapLinks(
          payload.schema,
          rewrite,
          seen,
          true,
        ) as typeof payload.schema;
        return rewrite(
          schema === payload.schema
            ? link
            : linkRefFrom({ ...payload, schema }),
        );
      }
      return rewrite(value);
    } else if (value instanceof FabricPrimitive) {
      // A `FabricPrimitive` is a leaf; the value encoding represents it
      // via its codec.
      return value;
    } else if (value instanceof FabricInstance) {
      return mapInstanceState(
        value,
        (state) => mapLinks(state, rewrite, seen, includeSchemas),
      );
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
        const rewritten = mapLinks(current, rewrite, seen, includeSchemas);
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
        const rewritten = mapLinks(entry, rewrite, seen, includeSchemas);
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

/** Maps an instance's codec state, preserving the instance when it is unchanged. */
function mapInstanceState(
  value: FabricInstance,
  map: (state: FabricValue) => FabricValue,
): FabricValue {
  const codec = codecOf(value);
  const state = codec.encode(value, NULL_LIVE_ENVIRONMENT);
  const mapped = map(state);
  return mapped === state ? value : deepFreeze(codec.decode(
    codec.tagForValue(value),
    cloneIfNecessary(mapped),
    NULL_LIVE_ENVIRONMENT,
  ));
}

/** Materializes relative links when a snapshot's raw value leaves its origin. */
export function resolveImmutableValueLinks(
  value: FabricValue,
  id: URI,
): FabricValue {
  if (!isImmutableCellId(id)) return value;
  const { origin } = immutableSnapshot(id);
  if (origin === undefined) return value;
  return mapLinks(
    value,
    (link) =>
      createSigilLinkFromParsedLink(parseLink(link, { ...origin, path: [] }), {
        includeSchema: true,
        keepAsCell: KeepAsCell.All,
      }),
  );
}

/**
 * Encodes an ephemeral identifier for a durable link, event, or replay fixture.
 * This boundary pays the encoding cost only when a snapshot must outlive its
 * runtime; ordinary reads and writes keep native values.
 */
export function portableSnapshotId(id: URI): URI {
  if (!isImmutableCellId(id)) return id;
  const value = resolveImmutableValueLinks(inlineCellValue(id), id);
  return dataUriFromValue(portableSnapshotLinks(value));
}

/** Cached content identities for comparisons with portable immutable links. */
let immutableContentIds = new WeakMap<object, string>();
onSchemaRegistryClear(() => {
  immutableContentIds = new WeakMap();
});

/** Returns the canonical portable content hash of either immutable format. */
export function immutableContentId(id: URI): string {
  if (!isImmutableCellId(id)) return hashStringOf(valueFromDataUri(id));
  const snapshot = immutableSnapshot(id);
  let hash = immutableContentIds.get(snapshot);
  if (hash === undefined) {
    const misses = externalResolutionMissCount();
    hash = hashStringOf(
      portableSnapshotLinks(resolveImmutableValueLinks(snapshot.value, id)),
    );
    if (externalResolutionMissCount() === misses) {
      immutableContentIds.set(snapshot, hash);
    }
  }
  return hash;
}

/** Replaces native link IDs with self-contained IDs at a portable boundary. */
export function portableSnapshotLinks(value: FabricValue): FabricValue {
  return mapLinks(
    value,
    (link) => {
      const payload = linkRefPayload(link);
      if (payload.id === undefined || !isImmutableCellId(payload.id)) {
        return link;
      }
      return linkRefFrom({ ...payload, id: portableSnapshotId(payload.id) });
    },
    new Set(),
    true,
  );
}

/**
 * Expands native snapshot links and portable Fabric data-URI links.
 *
 * For data URIs, only this codec's media type is inlined, the one
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
 * value an immutable link carries. Below that root, instance state is mapped
 * through its codec to expand embedded immutable links, unless
 * `options.refuseCarriedInstances` asks for refusal there as well.
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

    if (dataLink.id !== undefined && isInlineCellId(dataLink.id)) {
      let dataValue: any = resolveImmutableValueLinks(
        inlineCellValue(dataLink.id),
        dataLink.id,
      );
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

      // Immutable values may contain links to earlier immutable values.
      // Expand them before this value crosses the runtime boundary.
      return inlineDataUriLinks(dataValue, true, refuseCarried);
    } else {
      // Schema defaults can carry immutable links too. Keep the document link
      // while expanding those values before its schema crosses a boundary.
      const payload = isPrimitiveCellLink(value)
        ? linkRefPayload(inlineExternalSchemaRefsInValue(value))
        : dataLink;
      const schema = inlineDataUriLinks(payload.schema, decoded, refuseCarried);
      if (schema !== payload.schema) {
        if (isPrimitiveCellLink(value)) {
          return linkRefFrom({ ...payload, schema });
        }
        return createSigilLinkFromParsedLink({ ...dataLink, schema }, {
          includeSchema: true,
          keepAsCell: KeepAsCell.All,
        });
      }
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
    // A stored value may carry an instance below the payload root. Traverse
    // its canonical codec state so native snapshot IDs cannot escape in it.
    if (decoded && !refuseCarried) {
      return mapInstanceState(
        value,
        (state) => inlineDataUriLinks(state, decoded, refuseCarried),
      );
    }
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
