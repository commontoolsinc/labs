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
  FabricSpecialObject,
  type FabricValue,
} from "@commonfabric/data-model/fabric-value";
import {
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import { isRecord } from "@commonfabric/utils/types";
import { type Cell, isCell } from "./cell.ts";
import {
  isLegacyAlias,
  isPrimitiveCellLink,
  type NormalizedLink,
} from "./link-types.ts";
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
  valueFromDataUri,
} from "@commonfabric/data-model/data-uri-codec";
import { isPattern } from "./builder/types.ts";
import {
  createFactoryTraversalContext,
  hasTraversableFabricInstanceState,
  mapFabricInstanceStateForTraversal,
  mapFactoryForTraversal,
} from "./builder/factory-traversal.ts";

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
  const factoryContext = createFactoryTraversalContext();

  function traverseAndAddBaseIdToRelativeLinks(
    value: unknown,
    seen: Set<object>,
    insideLegacyPatternGraph = false,
  ): FabricValue {
    if (isAdmittedFabricFactory(value)) {
      const state = factoryStateOf(value);
      const legacyPattern = value as unknown as { toJSON?: () => unknown };
      if (
        insideLegacyPatternGraph && state.kind === "pattern" &&
        state.ref === undefined && typeof legacyPattern.toJSON === "function"
      ) {
        return traverseAndAddBaseIdToRelativeLinks(
          legacyPattern.toJSON(),
          seen,
          true,
        );
      }
      return mapFactoryForTraversal(
        value,
        (nested) => traverseAndAddBaseIdToRelativeLinks(nested, seen),
        factoryContext,
      ) as FabricValue;
    }
    if (typeof value === "function") {
      throw new TypeError("Arbitrary functions are not valid Fabric values");
    }
    // Structural legacy aliases are executable graph metadata, not references
    // relative to whichever inline document happens to transport the graph.
    if (insideLegacyPatternGraph && isLegacyAlias(value)) {
      return value as FabricValue;
    }
    // Modern links are Fabric instances, so recognize links before the generic
    // codec-instance/special-object branches.
    if (isPrimitiveCellLink(value)) {
      const link = parseLink(value, baseLink);
      return createSigilLinkFromParsedLink(link, {
        includeSchema: true,
        keepAsCell: KeepAsCell.All,
      });
    }
    if (hasTraversableFabricInstanceState(value)) {
      if (seen.has(value)) {
        throw new Error(`Cycle detected when creating data URI`);
      }
      seen.add(value);
      try {
        return mapFabricInstanceStateForTraversal(
          value,
          (state) =>
            traverseAndAddBaseIdToRelativeLinks(
              state,
              seen,
              insideLegacyPatternGraph,
            ),
        );
      } finally {
        seen.delete(value);
      }
    }
    if (value instanceof FabricSpecialObject) return value;
    if (!isRecord(value)) return value as FabricValue;
    if (seen.has(value)) {
      throw new Error(`Cycle detected when creating data URI`);
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) =>
          traverseAndAddBaseIdToRelativeLinks(
            item,
            seen,
            insideLegacyPatternGraph,
          )
        );
      } else { // isObject
        const childIsInsideLegacyPattern = insideLegacyPatternGraph ||
          isPattern(value);
        return Object.fromEntries(
          Object.entries(value).filter(([key, child]) =>
            !(childIsInsideLegacyPattern && key === "toJSON" &&
              typeof child === "function")
          ).map((
            [key, value],
          ) => [
            key,
            traverseAndAddBaseIdToRelativeLinks(
              value,
              seen,
              childIsInsideLegacyPattern,
            ),
          ]),
        ) as FabricValue;
      }
    } finally {
      seen.delete(value);
    }
  }

  return dataUriFromValue(
    traverseAndAddBaseIdToRelativeLinks(data, new Set()),
  );
}

/** Find data-URI links and inline them, including factory and codec state. */
export function findAndInlineDataUriLinks(value: any): any {
  return findAndInlineDataUriLinksInner(
    value,
    createFactoryTraversalContext(),
  );
}

function findAndInlineDataUriLinksInner(
  value: any,
  factoryContext: ReturnType<typeof createFactoryTraversalContext>,
): any {
  if (isAdmittedFabricFactory(value)) {
    return mapFactoryForTraversal(
      value,
      (nested) => findAndInlineDataUriLinksInner(nested, factoryContext),
      factoryContext,
    );
  } else if (typeof value === "function") {
    throw new TypeError("Arbitrary functions are not valid Fabric values");
  } else if (isCellLink(value)) {
    const dataLink = parseLink(value)!;

    if (dataLink.id?.startsWith("data:")) {
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
          return findAndInlineDataUriLinksInner(newSigilLink, factoryContext);
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
      const inlined = findAndInlineDataUriLinksInner(current, factoryContext);
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
  } else if (hasTraversableFabricInstanceState(value)) {
    return mapFabricInstanceStateForTraversal(
      value,
      (state) => findAndInlineDataUriLinksInner(state, factoryContext),
    );
  } else if (value instanceof FabricSpecialObject) {
    return value;
  } else if (isRecord(value)) {
    let next: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const inlined = findAndInlineDataUriLinksInner(entry, factoryContext);
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
