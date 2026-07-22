import { hashOf } from "@commonfabric/data-model/value-hash";
import { hasEntityUriScheme } from "./entity-kind.ts";
import { FabricSpecialObject } from "@commonfabric/data-model/fabric-value";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import {
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import {
  type EntityRef,
  entityRefFrom,
  entityRefFromString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
import { isRecord } from "@commonfabric/utils/types";
import { isModule, isPattern, isReactive } from "./builder/types.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import { isCell } from "./cell.ts";
import { fromURI } from "./uri-utils.ts";
import { isSigilLink, parseLink } from "./link-utils.ts";
import {
  createFactoryTraversalContext,
  mapFactoryForTraversal,
} from "./builder/factory-traversal.ts";

declare const ENTITY_ID_BRAND: unique symbol;

/**
 * An entity id: a {@link FabricHash} that specifically names a cell/document
 * within a space (as produced by {@link createRef}), as opposed to an arbitrary
 * content/value/schema hash. The brand is type-only — at runtime an `EntityId`
 * is just a `FabricHash` — and exists to keep "this hash is an entity id" a
 * distinct, intentional thing in the type system. Construct via
 * {@link entityIdFrom} (or {@link createRef}).
 */
export type EntityId = FabricHash & { readonly [ENTITY_ID_BRAND]: true };

/** Brands a content-hash string (or `FabricHash`) as an {@link EntityId}. */
export function entityIdFrom(hash: string | FabricHash): EntityId {
  return (typeof hash === "string"
    ? FabricHash.fromString(hash)
    : hash) as EntityId;
}

/**
 * Generates an entity ID.
 *
 * Derivation inputs must resolve: a Cell with no entityId or a Reactive with
 * no value throws rather than minting a random substitute, so a derived id never
 * silently becomes non-deterministic (audit S14). A missing `cause`, by
 * contrast, deliberately mints a fresh random id.
 *
 * @param source - The source object.
 * @param cause - Optional causal source. If omitted, a random id is minted.
 */
export function createRef(
  source: Record<string | number | symbol, any> = {},
  cause: any = (() => {
    console.error(
      "[createRef] NO CAUSE — falling back to randomUUID",
      new Error().stack,
    );
    return crypto.randomUUID();
  })(),
): EntityId {
  const seen = new Set<any>();
  const factoryContext = createFactoryTraversalContext();
  const factoryStateAncestors = new WeakSet<object>();

  // Unwrap query result proxies and replace docs with their ids. Admitted
  // factories retain their callable value and map only their hidden semantic
  // state; every other JavaScript function fails closed.
  function traverse(
    obj: any,
    insideFactoryState = false,
    allowLegacyImplementationFunction = false,
    insideLegacyPatternGraph = false,
  ): any {
    if (isAdmittedFabricFactory(obj)) {
      const state = factoryStateOf(obj);
      const legacyPattern = obj as unknown as { toJSON?: () => unknown };
      // Keyless hand-built patterns have no Factory@1 identity to hash. Keep
      // the explicit legacy structural-identity fallback used by
      // ensureKeylessPatternIdentity; every ref-backed factory takes the
      // canonical hidden-state path below.
      if (
        state.ref === undefined && state.kind === "pattern" &&
        typeof legacyPattern.toJSON === "function"
      ) {
        const pattern = obj as unknown as {
          argumentSchema?: unknown;
          resultSchema?: unknown;
          derivedInternalCells?: unknown;
          result?: unknown;
          nodes?: unknown;
          defaultScope?: unknown;
        };
        return traverse(
          {
            argumentSchema: pattern.argumentSchema,
            resultSchema: pattern.resultSchema,
            ...(pattern.derivedInternalCells === undefined
              ? {}
              : { derivedInternalCells: pattern.derivedInternalCells }),
            result: pattern.result,
            nodes: pattern.nodes,
            ...(pattern.defaultScope === undefined
              ? {}
              : { defaultScope: pattern.defaultScope }),
          },
          insideFactoryState,
          false,
          true,
        );
      }
      // A keyless root pattern's structural graph can also contain keyless
      // module/handler factories. They are not Fabric values and must never
      // reach the canonical Factory@1 codec, but the long-standing session
      // identity fallback still needs to hash their builder descriptors. Keep
      // this exception scoped to an already-recognized legacy pattern graph;
      // ordinary factory values continue to require a durable artifact ref.
      if (state.ref === undefined && insideLegacyPatternGraph) {
        return traverse(
          Object.fromEntries(Object.entries(obj)),
          insideFactoryState,
          false,
          true,
        );
      }
      return mapFactoryForTraversal(
        obj,
        (nested) => traverse(nested, true),
        factoryContext,
      );
    }

    if (typeof obj === "function") {
      if (allowLegacyImplementationFunction) return obj.toString();
      throw new TypeError(
        insideFactoryState
          ? "Arbitrary functions are not valid factory state values"
          : "Arbitrary functions are not valid createRef values",
      );
    }

    // Fabric-special values and serialized references are logical atoms. In
    // particular, inspect neither protocol internals nor enumerable wrapper
    // implementation details; hashOf() dispatches through their codecs.
    if (obj instanceof FabricSpecialObject) return obj;
    if (isSigilLink(obj) || isEntityRef(obj)) return obj;

    const factoryStateContainer = insideFactoryState && obj !== null &&
        typeof obj === "object"
      ? obj as object
      : undefined;
    if (factoryStateContainer !== undefined) {
      if (factoryStateAncestors.has(factoryStateContainer)) {
        throw new TypeError("Circular reference detected in factory state");
      }
      factoryStateAncestors.add(factoryStateContainer);
    }

    try {
      // Avoid cycles — only track objects/arrays/functions (not primitives).
      // Primitives use value equality in Set, so repeated strings like
      // "primary" would be incorrectly deduplicated, causing hash collisions
      // for patterns that differ only in the position of repeated values.
      if (
        obj !== null && (typeof obj === "object" || typeof obj === "function")
      ) {
        if (seen.has(obj)) return null;
        seen.add(obj);
      }

      // If there is a .toJSON method, replace obj with it, then descend.
      if (
        isRecord(obj) &&
        typeof obj.toJSON === "function"
      ) {
        obj = obj.toJSON() ?? obj;
      }

      if (isReactive(obj)) {
        const val = obj.export().value;
        if (val == null) {
          // An Reactive feeding a derived id must carry a value; otherwise the
          // id would silently become non-deterministic (audit S14). Fail closed.
          throw new Error(
            "[createRef] Reactive has no value; cannot derive a stable id",
          );
        }
        return val;
      }

      if (isCellResultForDereferencing(obj)) {
        // It'll traverse this and call .toJSON on the doc in the reference.
        obj = getCellOrThrow(obj);
      }

      // If referencing other docs, return their ids.
      if (isCell(obj)) {
        const id = obj.entityId;
        if (id == null) {
          // A Cell referenced from a derived id must have an entityId; otherwise
          // the id would silently become non-deterministic (audit S14). Fail
          // closed rather than mint a random substitute.
          throw new Error(
            "[createRef] Cell has no entityId; cannot derive a stable id",
          );
        }
        return id;
      } else if (Array.isArray(obj)) {
        return obj.map((value) =>
          traverse(value, insideFactoryState, false, insideLegacyPatternGraph)
        );
      } else if (isRecord(obj)) {
        return Object.fromEntries(
          Object.entries(obj).map(([key, value]) => [
            key,
            traverse(
              value,
              insideFactoryState,
              insideLegacyPatternGraph && key === "implementation" &&
                isModule(obj),
              insideLegacyPatternGraph,
            ),
          ]),
        );
      } else return obj;
    } finally {
      if (factoryStateContainer !== undefined) {
        factoryStateAncestors.delete(factoryStateContainer);
      }
    }
  }

  // The entity kind deliberately does NOT enter the preimage: a computed
  // cell and a state cell minted from the same cause share hash bytes and
  // differ only in their URI scheme (`computed:` vs `of:`, applied by
  // `toURI`). The full URI string is the identity; nothing may rebuild a
  // computed cell's URI from its bare hash.
  return entityIdFrom(hashOf(
    traverse(
      { ...source, causal: cause },
      false,
      false,
      isPattern(source),
    ),
  ));
}

/**
 * Helper to consistently get an entity ID from various object types
 */
export function getEntityId(value: any): EntityRef | undefined {
  if (typeof value === "string") {
    // Handle URI format with an entity scheme ("of:", "computed:", ...)
    if (hasEntityUriScheme(value)) {
      value = fromURI(value);
    }
    return entityRefFromString(value);
  }

  const link = parseLink(value);

  if (!link || !link.id) return undefined;

  const baseRef = entityRefFromString(fromURI(link.id));

  if (link.path && link.path.length > 0) {
    return entityRefFrom(createRef({ path: link.path }, baseRef));
  } else return baseRef;
}
