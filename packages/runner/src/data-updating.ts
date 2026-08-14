import type { JSONSchemaObj } from "@commonfabric/api";
import type { CfcAtom } from "@commonfabric/api/cfc";
import { linkRefFrom, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { isFabricDataUri } from "@commonfabric/data-model/data-uri-codec";
import {
  fabricFromNativeValue,
  type FabricPlainObject,
  FabricSpecialObject,
  type FabricValue,
  shallowFabricFromNativeValue,
} from "@commonfabric/data-model/fabric-value";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import { type CellScope, type JSONSchema } from "./builder/types.ts";
import {
  CellImpl,
  isCell,
  recordRelevantSchemaWritePolicyInput,
} from "./cell.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { canonicalizeLogicalPath } from "./cfc/canonical.ts";
import type { CfcConfClause } from "./cfc/clause.ts";
import {
  type CfcLabelView,
  cloneCfcLabelView,
  getCarriedCfcLabelView,
} from "./cfc/label-view-state.ts";
import { recordGeneratedWritePolicyForLink } from "./cfc/generated-write-policy.ts";
import { addRootConfidentiality } from "./cfc/schema-merge.ts";
import { spaceRootConfidentiality } from "./cfc/space-root-policy.ts";
import {
  type CfcCellLinkRefPayload,
  linkCfcLabelView,
} from "./cfc/link-label-view.ts";
import {
  readStoredCfcMetadata,
  storedCfcMetadataAppliesToPath,
} from "./cfc/metadata.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_SEED_MATERIALIZATION,
  type CfcAddress,
} from "./cfc/types.ts";
import { createRef } from "./create-ref.ts";
import { findAndInlineDataUriLinks } from "./data-uri.ts";
import { resolveLink } from "./link-resolution.ts";
import {
  areLinksSame,
  areMaybeLinkAndNormalizedLinkSame,
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  isCellLink,
  isPrimitiveCellLink,
  isSigilLink,
  isWriteRedirectLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import { type Runtime } from "./runtime.ts";
import {
  allowMutableTransactionRead,
  markReadAsAttemptedWrite,
} from "./scheduler.ts";
import { forEachSubschema } from "./schema-walk.ts";
import {
  resolveSchema,
  resolveSchemaForValue,
  schemaHasIfc,
} from "./schema.ts";
import { isCellScope, scopeRank } from "./scope.ts";
import { flattenBuilderArtifacts } from "./storage-preflight.ts";
import type {
  IExtendedStorageTransaction,
  IReadOptions,
} from "./storage/interface.ts";
import { ignoreReadForScheduling } from "./storage/reactivity-log.ts";
import { resolveSchemaRefsCanonical, schemaAcceptsType } from "./traverse.ts";
import { toURI } from "./uri-utils.ts";

const diffLogger = getLogger("normalizeAndDiff", {
  enabled: false,
  level: "debug",
});

// Sentinel value to distinguish "no precomputed value" from "precomputed value is undefined"
const NO_PRECOMPUTED = Symbol("no-precomputed");

// Docs whose seed-materialization absence check found a PRESENT value, keyed
// `space/id`, per runtime so tests with multiple runtimes stay isolated. A
// doc can't become un-created, so a settled entry can never suppress a needed
// seed; pending writes are deliberately not memoized (an aborted tx must
// re-seed). See the BRANCH_CELL seed materialization below.
const seedCheckSettled = new WeakMap<Runtime, Set<string>>();
const seededDocs = (runtime: Runtime): Set<string> => {
  let docs = seedCheckSettled.get(runtime);
  if (docs === undefined) {
    docs = new Set();
    seedCheckSettled.set(runtime, docs);
  }
  return docs;
};
// Scope is part of the key: per-user/per-session instances share an id with
// the space-scoped doc, and one scope's presence must not suppress another's
// seed.
const seedMemoKey = (link: NormalizedFullLink): string =>
  `${link.space}/${link.scope ?? "space"}/${link.id}`;

const cfcAddressFromLink = (link: NormalizedFullLink): CfcAddress => ({
  space: link.space,
  id: link.id,
  scope: link.scope,
  path: [...link.path],
});

const isPrefix = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

const pathsOverlap = (
  left: readonly string[],
  right: readonly string[],
): boolean => isPrefix(left, right) || isPrefix(right, left);

const pathSegmentMatches = (left: string, right: string): boolean =>
  left === right || left === "*" || right === "*";

const pathPrefixMatches = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => pathSegmentMatches(segment, path[index]));

const schemaPathsOverlap = (
  left: readonly string[],
  right: readonly string[],
): boolean => pathPrefixMatches(left, right) || pathPrefixMatches(right, left);

const labelHasValues = (
  label: {
    confidentiality?: readonly CfcConfClause[];
    integrity?: readonly CfcAtom[];
  },
): boolean =>
  (label.confidentiality?.length ?? 0) > 0 ||
  (label.integrity?.length ?? 0) > 0;

const cfcLabelViewHasValues = (view: CfcLabelView | undefined): boolean =>
  view?.entries.some((entry) => labelHasValues(entry.label)) ?? false;

// Exported for unit testing of the overlap predicate. Not part of the
// public surface.
export const schemaIfcOverlapsPath = (
  schema: JSONSchema | undefined,
  basePath: readonly string[],
  sourcePath: readonly string[],
): boolean => {
  if (schema === undefined || typeof schema === "boolean") {
    return false;
  }
  // Keyword descent via the shared walk. This predicate only decides
  // whether a schema-policy input MIGHT cover the written path — a true
  // records and evaluates the input — so over-matching errs safe. That is
  // why `items`/`additionalProperties` keep unconditional `*` segments even
  // beside prefixItems/properties (unlike walkIfcSchema's minted entries,
  // where a `*` covering named positions would over-taint them), and why
  // combinator branches and `not` descend at the same path. Tuple slots
  // overlap at their concrete index.
  const visit = (
    current: JSONSchema,
    path: readonly string[],
  ): boolean => {
    if (typeof current === "boolean") {
      return false;
    }
    if (
      isObjectOrArray(current.ifc) &&
      labelHasValues(current.ifc) &&
      schemaPathsOverlap(path, sourcePath)
    ) {
      return true;
    }
    return forEachSubschema(current, (child, keyword, key, index) => {
      const childPath = keyword === "properties"
        ? [...path, key!]
        : keyword === "prefixItems"
        ? [...path, String(index!)]
        : keyword === "items" || keyword === "additionalProperties"
        ? [...path, "*"]
        : path;
      return visit(child, childPath);
    });
  };
  return visit(schema, basePath);
};

const hasPendingSchemaPolicyInput = (
  tx: IExtendedStorageTransaction,
  source: NormalizedFullLink,
): boolean => {
  const sourcePath = canonicalizeLogicalPath(source.path);
  return tx.getCfcState().writePolicyInputs.some((input) =>
    input.kind === "schema" &&
    input.target.space === source.space &&
    input.target.id === source.id &&
    pathsOverlap(canonicalizeLogicalPath(input.target.path), sourcePath) &&
    schemaIfcOverlapsPath(
      input.schema,
      canonicalizeLogicalPath(input.target.path),
      sourcePath,
    )
  );
};

const recordLinkWritePolicyInput = (
  tx: IExtendedStorageTransaction,
  target: NormalizedFullLink,
  source: NormalizedFullLink,
  cfcLabelView?: CfcLabelView,
): void => {
  if (tx.getCfcState().enforcementMode === "disabled") {
    return;
  }
  const carriedCfcLabelView = cloneCfcLabelView(cfcLabelView);
  const sourceMetadata = readStoredCfcMetadata(tx, source);
  const sourceRelevant = schemaIfcOverlapsPath(source.schema, [], []) ||
    sourceMetadata !== undefined ||
    hasPendingSchemaPolicyInput(tx, source) ||
    cfcLabelViewHasValues(carriedCfcLabelView);
  const targetRelevant = storedCfcMetadataAppliesToPath(
    tx,
    target,
    ignoreReadForScheduling,
  ) ||
    hasPendingSchemaPolicyInput(tx, target);
  if (!sourceRelevant && !targetRelevant) {
    return;
  }

  tx.markCfcRelevant(`link-write:${target.id}`);
  if (!targetRelevant && target.path.length > 0) {
    const state = tx.getCfcState();
    const rootConfidentiality = spaceRootConfidentiality(
      state.enforcementMode,
      state.flowLabelsMode,
      target.space,
    );
    if (rootConfidentiality !== undefined) {
      recordRelevantSchemaWritePolicyInput(
        tx,
        { ...target, path: [] },
        { ifc: { confidentiality: [...rootConfidentiality] } },
      );
    }
  }
  tx.recordCfcWritePolicyInput({
    kind: "link-write",
    target: cfcAddressFromLink(target),
    source: cfcAddressFromLink(source),
    ...(source.schema !== undefined && { linkSchema: source.schema }),
    ...(carriedCfcLabelView !== undefined && {
      cfcLabelView: carriedCfcLabelView,
    }),
  });
};

const cfcLabelViewForPrimitiveLink = (
  value: unknown,
): CfcLabelView | undefined => {
  if (!isSigilLink(value)) {
    return undefined;
  }
  return cloneCfcLabelView(linkCfcLabelView(value));
};

const attachCfcLabelViewToSigilLink = (
  value: unknown,
  cfcLabelView: CfcLabelView | undefined,
): unknown => {
  const clonedView = cloneCfcLabelView(cfcLabelView);
  if (!clonedView || !isSigilLink(value)) {
    return value;
  }
  return linkRefFrom<CfcCellLinkRefPayload>({
    ...linkRefPayload(value),
    cfcLabelView: clonedView,
  });
};

const stripCfcLabelViewFromPrimitiveLink = (value: unknown): unknown => {
  if (!isSigilLink(value)) {
    return value;
  }
  const inner = linkRefPayload(value) as CfcCellLinkRefPayload;
  if (inner.cfcLabelView === undefined) {
    return value;
  }
  const { cfcLabelView: _cfcLabelView, ...cleanInner } = inner;
  return linkRefFrom(cleanInner);
};

/**
 * Whether a slot's schema would TOLERATE the value reading as missing —
 * i.e. it matches `undefined` or carries a `default` (ubik2's criterion on
 * #4561). Used to restrict the scope-isolation warn to slots where an
 * unresolvable link actually bites: a slot that accepts undefined (or
 * defaults) degrades harmlessly per reader, so storing a narrower-scoped
 * link there is a legitimate per-reader pattern rather than a footgun.
 * Complemented by the parent-`required` threading (see normalizeAndDiff's
 * `slotRequiredByParent`): the full criterion is "the read would actually
 * reject the missing cell".
 */
const _toleratesMissingCache = new WeakMap<object, boolean>();
function schemaToleratesMissing(schema: JSONSchema | undefined): boolean {
  if (schema === undefined) return true;
  if (!isObjectOrArray(schema)) return true;
  // Schemas are identity-stable (interned / deep-frozen) on the paths that
  // reach here, mirroring traverse's own ref cache — memoize the verdict so
  // per-row write loops don't re-resolve refs (a CI-visible cost otherwise).
  const cached = _toleratesMissingCache.get(schema);
  if (cached !== undefined) return cached;
  const verdict = computeToleratesMissing(schema);
  _toleratesMissingCache.set(schema, verdict);
  return verdict;
}

function computeToleratesMissing(schema: JSONSchema): boolean {
  // Resolve a top-level $ref before the default check (via the MEMOIZED
  // canonical resolver traverse uses), and apply the default with the same
  // LOOSE comparison the read side uses when it applies defaults
  // (`!= undefined`): a `default: null` is skipped by the read and therefore
  // does not make the slot tolerant, while `default: 0/""/false` do. Judged
  // on the resolved schema so a default carried by the $defs target counts.
  let resolved: JSONSchema | undefined = schema;
  if (isObjectOrArray(schema) && "$ref" in schema) {
    resolved = resolveSchemaRefsCanonical(schema as JSONSchemaObj) ?? schema;
  }
  if (isObjectOrArray(resolved) && resolved.default != undefined) return true;
  // Type tolerance judged with the read side's own matcher (schemaAcceptsType
  // wraps the logic extracted from SchemaObjectTraverser.isValidType,
  // including $ref resolution and allOf/anyOf/oneOf).
  return schemaAcceptsType(schema, "undefined");
}

/**
 * The scope at which a slot's content is stored (the write target scope). It
 * shares its precedence with the read follow-cap (see
 * `ContextualFlowControl.getSchemaScopeCap`) so writes and reads agree on which
 * scoped instance a slot addresses. `any`/no constraint yields `undefined` —
 * i.e. no narrowing. Distinct from the link's own base scope.
 */
function declaredCellScope(
  schema: JSONSchema | undefined,
): CellScope | undefined {
  const cap = ContextualFlowControl.getSchemaScopeCap(schema);
  return isCellScope(cap) ? cap : undefined;
}

const recordScopedInstanceRootPolicy = (
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  schemaRole?: "output",
): void => {
  const confidentiality = spaceRootConfidentiality(
    runtime.cfcEnforcementMode,
    runtime.cfcFlowLabels,
    link.space,
  );
  if (confidentiality === undefined) return;
  recordRelevantSchemaWritePolicyInput(
    tx,
    { ...link, path: [] },
    { ifc: { confidentiality: [...confidentiality] } },
    schemaRole,
  );
};

export type DiffAndUpdateOptions = IReadOptions & {
  /**
   * Marks every schema-bearing document produced by this traversal as a
   * generated output. This must propagate through collection entries anchored
   * as entity documents: they are separate storage targets, so an output
   * marker on the containing document cannot cover them.
   */
  schemaRole?: "output";
};

/**
 * Mutable state threaded through a single `normalizeAndDiff()` walk.
 */
export interface DiffWalkState {
  /** Shared-reference / cycle tracking: source value → normalized link. */
  seen: Map<any, NormalizedFullLink>;
  /**
   * When present, a plain object sitting in an array that is not already a
   * link gets anchored into an entity document of its own, its id drawn from
   * this source. Writers running under a builder frame supply the frame's id
   * counter; frameless writes leave it unset, and such elements store inline.
   */
  nextAnchorId?: () => string | number;
}

/**
 * Traverses newValue and updates `current` and any relevant linked documents.
 *
 * Returns true if any changes were made.
 *
 * A plain object sitting in an array becomes an entity document of its own
 * when `anchorIds` is supplied, its id drawn from that source. The entity id
 * also derives from the object's relative location and the passed context,
 * and the changes are written to that entity.
 *
 * @param current - A doc link to the current value to compare against.
 * @param newValue - The new value to traverse.
 * @param log - The log to write to.
 * @param context - The context of the change.
 * @param anchorIds - The id source for anchoring array-element objects
 * (typically a builder frame's counter, see `frameAnchorIds()`).
 * @returns Whether any changes were made.
 */
export function diffAndUpdate(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  newValue: unknown,
  context?: unknown,
  options?: DiffAndUpdateOptions,
  anchorIds?: () => string | number,
): boolean {
  if (options?.schemaRole === "output") {
    recordGeneratedWritePolicyForLink(
      tx,
      link,
      link.schema ?? {},
      "output",
    );
  }
  const readOptions: DiffAndUpdateOptions = {
    ...options,
    meta: {
      ...options?.meta,
      ...markReadAsAttemptedWrite,
      ...allowMutableTransactionRead,
    },
  };
  // A builder artifact -- a module, a handler, a pattern, the factory carrying
  // a module's members -- has no fabric representation, so the runtime replaces
  // it with its encodable form before the value reaches the data model. This is
  // the raw write path, reached by `Cell.set()` and the collection operations;
  // the pattern-driven paths (a run's result, its argument) do the same at
  // their own boundaries.
  //
  // A query result is a leaf to that walk, because it is one to the diff
  // below: `normalizeAndDiff()` replaces such a value with the sigil link it
  // names without reading a member of it. Each member read on one resolves
  // through this transaction and is recorded on it as a dependency the commit
  // has to check.
  const changes = normalizeAndDiff(
    runtime,
    tx,
    link,
    flattenBuilderArtifacts(newValue, {
      isLeaf: isCellResultForDereferencing,
    }),
    context,
    readOptions,
    { seen: new Map(), nextAnchorId: anchorIds },
  );
  diffLogger.debug(
    "diff",
    () => `[diffAndUpdate] changes: ${toCompactDebugString(changes)}`,
  );
  applyChangeSet(tx, changes);
  return changes.length > 0;
}

export type ChangeSet = {
  location: NormalizedFullLink;
  value: FabricValue;
  /**
   * When true, the change removes the slot at `location` (object key
   * removal or array hole) instead of writing a value; `value` is
   * `undefined`. Without this flag, a change whose `value` is `undefined`
   * stores `undefined` as a real value — present-but-undefined is distinct
   * from absent.
   */
  delete?: boolean;
}[];

/**
 * Turns `content` into an entity document of its own: the slot at `link` gets
 * a link to a (possibly new) document whose id derives from `idSeed`, the
 * slot's location, and the passed context, and `content` is diffed into that
 * document. When the slot is an element of a STORED array, the id derives
 * from the nearest non-array ancestor location, so the element's identity
 * does not depend on its position. Array ancestry is read from transaction
 * pre-state, so on a fresh array's first write the indices remain in the
 * derivation and identity IS position-bearing there -- a long-standing
 * limitation.
 *
 * `registerKey` is the caller's original value, and `content` a distinct
 * shallow copy of it; `registerKey` is registered in `state.seen` so shared
 * references to it resolve to the same document.
 */
function anchorValueAsEntity(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  content: FabricPlainObject,
  registerKey: unknown,
  idSeed: string | number,
  context: unknown,
  options: DiffAndUpdateOptions | undefined,
  state: DiffWalkState,
): ChangeSet {
  let path = link.path;

  // If we're setting an array element, make the array the context for the
  // derived id, not the array index. If it's a nested array, take the parent
  // array as context, recursively.
  while (
    path.length > 0 &&
    Array.isArray(
      tx.readValueOrThrow({ ...link, path: path.slice(0, -1) }, options),
    )
  ) {
    path = path.slice(0, -1);
  }

  const entityId = createRef({ id: idSeed }, {
    parent: { id: link.id, space: link.space },
    path,
    context,
  });

  const newEntryLink: NormalizedFullLink = {
    id: toURI(entityId),
    space: link.space,
    scope: link.scope,
    path: [],
    schema: resolveSchemaForValue(link.schema, content),
  };

  state.seen.set(registerKey, newEntryLink);

  // This helper handles both creation and later writes to an anchored entity.
  // Carry the child schema on every visit so CFC can merge the candidate
  // envelope — including generated-output provenance — against an existing
  // long-lived document.
  if (options?.schemaRole === "output") {
    recordGeneratedWritePolicyForLink(
      tx,
      newEntryLink,
      newEntryLink.schema ?? {},
      "output",
    );
  } else {
    const cfcState = tx.getCfcState();
    const rootConfidentiality = schemaHasIfc(link.schema)
      ? spaceRootConfidentiality(
        cfcState.enforcementMode,
        cfcState.flowLabelsMode,
        newEntryLink.space,
      )
      : undefined;
    recordRelevantSchemaWritePolicyInput(
      tx,
      newEntryLink,
      rootConfidentiality === undefined
        ? newEntryLink.schema
        : addRootConfidentiality(
          newEntryLink.schema,
          rootConfidentiality,
        ),
    );
  }

  return [
    // If it wasn't already, set the current value to be a doc link to this doc
    ...normalizeAndDiff(
      runtime,
      tx,
      link,
      createSigilLinkFromParsedLink(newEntryLink, { base: link }),
      context,
      options,
      state,
    ),
    // And see whether the value of the document itself changed
    ...normalizeAndDiff(
      runtime,
      tx,
      newEntryLink,
      content,
      context,
      options,
      state,
    ),
  ];
}

/**
 * Traverses objects and returns an array of changes that should be written. An
 * empty array means no changes.
 *
 * A plain object sitting in an array becomes an entity document of its own
 * when the walk state carries an id source (`nextAnchorId`, supplied by
 * writers running under a builder frame). The changes are queued to be
 * written to that entity, and the slot holds a link to it.
 *
 * Otherwise, when traversing and if the new value is a regular JSON value, but
 * the old value is an alias, follow the alias before writing. However document
 * references get overwritten (except as per above, the object gets converted to
 * a document itself).
 *
 * Any proxy is unwrapped, and docs and cells mapped to doc links.
 *
 * @param current - A doc link to the current value to compare against.
 * @param newValue - The new value to traverse.
 * @param log - The log to write to.
 * @param context - The context of the change.
 * @returns An array of changes that should be written.
 */
export function normalizeAndDiff(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  newValue: unknown,
  context?: unknown,
  options?: DiffAndUpdateOptions,
  state: DiffWalkState = { seen: new Map() },
  precomputedCurrent: unknown = NO_PRECOMPUTED,
  // Whether the PARENT object's schema lists this slot in `required`
  // (threaded one hop by the object branch below; undefined = unknown).
  // Consumed by the scope-isolation warn: a missing cell only voids the
  // read when the parent requires the property, so optional slots stay
  // quiet (ubik2's criterion on #4561).
  slotRequiredByParent?: boolean,
  // Whether this call's `newValue` arrived as an element of an array in the
  // WRITTEN tree (threaded one hop by the array branch below, and forwarded
  // by re-entries that keep the value while changing the target link). The
  // written tree's structure is what decides anchoring eligibility -- the
  // stored parent may not exist yet on a fresh array's first write.
  isArrayElement: boolean = false,
): ChangeSet {
  const changes: ChangeSet = [];

  // Log entry with value type and symbol presence
  const valueType = Array.isArray(newValue) ? "array" : typeof newValue;
  const pathStr = link.path.join(".");
  diffLogger.debug(
    "diff",
    () =>
      `[DIFF_ENTER] path=${pathStr} type=${valueType} newValue=${
        toCompactDebugString(newValue)
      }`,
  );

  // When detecting a circular reference on JS objects, turn it into a cell,
  // which below will be turned into a relative link.
  if (state.seen.has(newValue)) {
    const seenLink = state.seen.get(newValue)!;
    // An anchor-eligible array occurrence must not become a link into a
    // document's mutable INTERIOR (a non-root `seen` location, i.e. an
    // earlier inline occurrence): removing that inline property later would
    // leave the array element dangling. Instead, PROMOTE the shared object
    // into an entity document of its own and repoint the earlier inline
    // location at it too -- all occurrences stay aliased to one stable
    // document. A root `seen` location (an already-anchored occurrence)
    // needs no promotion; the plain link below is stable.
    if (
      state.nextAnchorId !== undefined &&
      isArrayElement &&
      isObjectNotArray(newValue) &&
      !(newValue instanceof FabricSpecialObject) &&
      !isCellLink(newValue) &&
      seenLink.path.length > 0
    ) {
      // An element carried through untouched from the stored array must stay
      // untouched (see the anchoring branch below for why this is
      // load-bearing): emit nothing rather than promote it.
      if (
        precomputedCurrent !== NO_PRECOMPUTED &&
        Object.is(precomputedCurrent, newValue)
      ) {
        return [];
      }
      diffLogger.debug(
        "diff",
        () =>
          `[SEEN_PROMOTE] Promoting inline-aliased array element at path=${pathStr}`,
      );
      // The promoted document's content must not link back through the
      // inline location that is about to be repointed: descendants of the
      // shared object were registered UNDER that location, and a document
      // whose content links into `/first/...` while `/first` links to the
      // document is a read-time cycle. Drop those entries so the content
      // recursion re-derives them under the document root.
      for (const [registeredKey, registered] of state.seen) {
        if (
          registered.id === seenLink.id &&
          registered.path.length > seenLink.path.length &&
          seenLink.path.every((seg, i) => registered.path[i] === seg)
        ) {
          state.seen.delete(registeredKey);
        }
      }
      // Anchoring re-registers the object in `state.seen` under the new
      // document's root, so later occurrences (and the content recursion's
      // own cycle hits) link there.
      const anchorChanges = anchorValueAsEntity(
        runtime,
        tx,
        link,
        { ...(newValue as FabricPlainObject) },
        newValue,
        state.nextAnchorId(),
        context,
        options,
        state,
      );
      const promotedLink = state.seen.get(newValue)!;
      return [
        ...anchorChanges,
        // Repoint the earlier inline occurrence at the promoted document.
        ...normalizeAndDiff(
          runtime,
          tx,
          seenLink,
          createSigilLinkFromParsedLink(promotedLink, { base: seenLink }),
          context,
          options,
          state,
        ),
      ];
    }
    diffLogger.debug(
      "diff",
      () =>
        `[SEEN_CHECK] Already seen object at path=${pathStr}, converting to cell`,
    );
    newValue = new CellImpl(runtime, tx, seenLink);
  }

  // Scope narrowing: if this slot's schema declares a scope narrower than the
  // link's base scope, the content belongs in the narrower-scope instance and
  // the broader-scope slot holds a link to it, so readers at the broader scope
  // follow it to the narrower instance. A reference value (link/cell) is exempt:
  // it already carries its own target scope. Both writes recurse back through
  // normalizeAndDiff so they get the usual diffing, no-op detection, and CFC
  // label/policy handling. Applying this at the top of normalizeAndDiff makes it
  // compose to arbitrary depth (every nested descent re-enters here): narrowing
  // fires at whatever slot declares it. Element-level scope (an array's `items`
  // schema) therefore yields one redirect per element, while array-level scope
  // (the array slot's own schema) redirects the whole array.
  const declaredScope = declaredCellScope(link.schema);
  if (
    declaredScope !== undefined &&
    scopeRank(declaredScope) > scopeRank(link.scope) &&
    !isCellLink(newValue) &&
    !isCell(newValue)
  ) {
    const scopedLink: NormalizedFullLink = { ...link, scope: declaredScope };
    recordRelevantSchemaWritePolicyInput(
      tx,
      scopedLink,
      scopedLink.schema,
      options?.schemaRole,
    );
    recordScopedInstanceRootPolicy(
      runtime,
      tx,
      scopedLink,
      options?.schemaRole,
    );
    return [
      // Content goes into the narrower-scope instance (its missing container
      // structure is created by the storage write, which builds parents for the
      // path). Diffed against the narrower instance's own current value.
      ...normalizeAndDiff(
        runtime,
        tx,
        scopedLink,
        newValue,
        context,
        options,
        state,
        NO_PRECOMPUTED,
        undefined,
        isArrayElement,
      ),
      // The broader-scope slot points to that instance.
      ...normalizeAndDiff(
        runtime,
        tx,
        link,
        createSigilLinkFromParsedLink(scopedLink, { base: link }) as unknown,
        context,
        options,
        state,
      ),
    ];
  }

  // Unwrap proxies and handle special types
  if (isCellResultForDereferencing(newValue)) {
    const carriedCfcLabelView = getCarriedCfcLabelView(
      getCellOrThrow(newValue),
    );
    const parsedLink = parseLink(newValue);
    const sigilLink = attachCfcLabelViewToSigilLink(
      createSigilLinkFromParsedLink(parsedLink),
      carriedCfcLabelView,
    );
    diffLogger.debug(
      "diff",
      () =>
        `[BRANCH_QUERY_RESULT] Converted query result to sigil link at path=${pathStr} link=${sigilLink} parsedLink=${parsedLink}`,
    );
    newValue = sigilLink;
  }

  // Track whether this link originates from a Cell value (either a cycle we
  // wrapped into a CellImpl above, or a user-supplied Cell). For Cell-origin
  // links we preserve the link (do NOT collapse). For links created via
  // query-result dereferencing (non-Cell), we may collapse immediate-parent
  // self-links.
  let linkOriginFromCell = false;
  if (isCell(newValue)) {
    diffLogger.debug(
      "diff",
      () => `[BRANCH_CELL] Converting cell to link at path=${pathStr}`,
    );
    linkOriginFromCell = true;
    const carriedCfcLabelView = getCarriedCfcLabelView(newValue);
    // Materialize a runtime-constructed cell's initial value: a
    // `Writable(initialValue)` built inside a lift/handler frame (the CTS
    // wraps derived initials this way) carries its seed only as the link
    // schema's `default` — nothing else ever writes the backing doc, so a
    // fresh session reads the field as undefined (and a `required` field
    // collapses the whole result; the blank-profile-name bug). This is the
    // first point where the cell's identity is settled AND a live tx covers
    // the write, so seed the target doc here, only if it has no value yet —
    // re-derivations serialize the same cell again but find the doc present
    // and leave user edits alone.
    const cellSchema = newValue.schema;
    const seedDefault = isObjectOrArray(cellSchema)
      ? cellSchema.default
      : undefined;
    const seedTarget = seedDefault !== undefined &&
        !(isObjectOrArray(seedDefault) &&
          (seedDefault as Record<string, unknown>).$stream === true)
      ? newValue.getAsNormalizedFullLink()
      : undefined;
    if (
      seedDefault !== undefined &&
      // Only root-linked cells: those are the runtime-constructed
      // `Writable(value)` cells whose doc the default describes in full. A
      // sub-path cell (e.g. via `.key()`) carries a FIELD default — writing
      // that over the doc root would clobber the document.
      seedTarget !== undefined && seedTarget.path.length === 0 &&
      // Each doc needs the absence check at most once per runtime: once
      // found present (or seeded here), later serializations of the same
      // cell skip it — the check would otherwise run on EVERY defaulted-cell
      // serialization, a measurable hot-path cost (the CI perf check caught
      // +22–36% on the CLI integration suites for the unmemoized version).
      !seededDocs(runtime).has(seedMemoKey(seedTarget))
    ) {
      // Don't subscribe the serializing action to the seed doc — mirror
      // materializeDerivedInternalCells' read for the same check.
      const absent = tx.readValueOrThrow(seedTarget, {
        meta: ignoreReadForScheduling,
      }) === undefined;
      if (!absent) {
        seededDocs(runtime).add(seedMemoKey(seedTarget));
      }
      if (absent) {
        try {
          tx.writeValueOrThrow(
            seedTarget,
            fabricFromNativeValue(seedDefault),
          );
          // The marker is what authorizes the write above past an
          // owner-protected schema's `writeAuthorizedBy` (cfc/prepare.ts
          // requires marker AND doc-creation; both are checked at commit,
          // so in-tx ordering is immaterial there). Record it only AFTER
          // the write succeeds: a thrown write must not leave a stray
          // marker that could authorize an unrelated same-doc write later
          // in this transaction. It is recorded only here, by the runtime,
          // never from arbitrary cell.set calls.
          tx.recordCfcWritePolicyInput({
            kind: "structural-provenance",
            target: {
              space: seedTarget.space,
              id: seedTarget.id,
              scope: seedTarget.scope,
              path: [],
            },
            claim: CFC_STRUCTURAL_PROVENANCE_SEED_MATERIALIZATION,
            sources: [{
              space: seedTarget.space,
              id: seedTarget.id,
              scope: seedTarget.scope,
              path: [],
            }],
          });
          // Deliberately NOT memoized here: if this tx aborts, the doc stays
          // absent and the next serialization must seed again. Once the
          // write commits, the next check finds the doc present and settles.
        } catch (error) {
          // Fail open: a seed-materialization failure must not abort the
          // serialization that references the cell — the link (with its
          // schema default) still gets written below.
          diffLogger.warn(
            "diff",
            () => [
              `[BRANCH_CELL] seed materialization failed for`,
              seedTarget.id,
              error,
            ],
          );
        }
      }
    }
    newValue = attachCfcLabelViewToSigilLink(
      createSigilLinkFromParsedLink(newValue.getAsNormalizedFullLink(), {
        base: link,
        includeSchema: true,
      }),
      carriedCfcLabelView,
    );
  }

  // Check for links that are data: URIs and inline them, by calling
  // normalizeAndDiff on the contents of the link. This re-entry REPLACES the
  // value (the link's contents, not the link), so anchoring eligibility
  // deliberately does not carry over: inlined content in an array slot stores
  // inline, exactly as the annotation scheme (which never looked behind
  // links) stored it.
  //
  // The re-entry hands on what `findAndInlineDataUriLinks` produced, so the
  // check accepts exactly the media type that call inlines: this codec's
  // own. A `data:` URI of any other media type stores as an ordinary link.
  const newValueLinkId = isCellLink(newValue)
    ? parseLink(newValue, link).id
    : undefined;
  if (newValueLinkId !== undefined && isFabricDataUri(newValueLinkId)) {
    return normalizeAndDiff(
      runtime,
      tx,
      link,
      findAndInlineDataUriLinks(newValue),
      context,
      options,
      state,
    );
  }

  // If we're about to create a reference to ourselves, no-op
  if (areMaybeLinkAndNormalizedLinkSame(newValue, link, link)) {
    diffLogger.debug(
      "diff",
      () =>
        `[BRANCH_SELF_REF] Self-reference detected, no-op at path=${pathStr}`,
    );
    return [];
  }

  // Get current value to compare against (use precomputed if available)
  let currentValue = precomputedCurrent === NO_PRECOMPUTED
    ? tx.readValueOrThrow(link, options)
    : precomputedCurrent;

  // A new alias can overwrite a previous alias. No-op if the same.
  if (isWriteRedirectLink(newValue)) {
    const carriedCfcLabelView = cfcLabelViewForPrimitiveLink(newValue);
    const parsedLink = parseLink(newValue, link);
    if (
      isWriteRedirectLink(currentValue) &&
      areNormalizedLinksSame(
        parseLink(currentValue, link),
        parsedLink,
      )
    ) {
      diffLogger.debug(
        "diff",
        () => `[BRANCH_WRITE_REDIRECT] Same redirect, no-op at path=${pathStr}`,
      );
      if (cfcLabelViewHasValues(carriedCfcLabelView)) {
        recordLinkWritePolicyInput(tx, link, parsedLink, carriedCfcLabelView);
      }
      return [];
    } else {
      diffLogger.debug(
        "diff",
        () =>
          `[BRANCH_WRITE_REDIRECT] Different redirect, updating at path=${pathStr}`,
      );
      recordLinkWritePolicyInput(tx, link, parsedLink, carriedCfcLabelView);
      changes.push({
        location: link,
        value: stripCfcLabelViewFromPrimitiveLink(newValue) as FabricValue,
      });
      return changes;
    }
  }

  // Handle alias in current value (at this point: if newValue is not an alias)
  if (isWriteRedirectLink(currentValue)) {
    diffLogger.debug(
      "diff",
      () =>
        `[BRANCH_CURRENT_ALIAS] Following current value alias at path=${pathStr}`,
    );
    // Log reads of the alias, so that changing aliases cause refreshes
    const redirectLink = resolveLink(
      runtime,
      tx,
      parseLink(currentValue, link),
      "writeRedirect",
    );
    return normalizeAndDiff(
      runtime,
      tx,
      redirectLink,
      newValue,
      context,
      options,
      state,
      NO_PRECOMPUTED,
      undefined,
      isArrayElement,
    );
  }

  // Scope realization on write: the base-scope slot of a scoped instance
  // holds a regular link with an explicitly narrower scope (materialized at
  // setup; see the narrowing branch above and the eager-redirect pass in the
  // object branch below). A write of *content* arriving at this slot without
  // a scope-declaring schema (e.g. through a serialized binding whose schema
  // is scope-silent, like the renderer's $value cell) must follow that link
  // into the narrower-scope instance — overwriting it would land per-user /
  // per-session state at the shared base scope. Reference values are exempt:
  // writing a link re-binds the slot (and the schema-declared narrowing above
  // already handled scoped re-binds before reaching here).
  if (isPrimitiveCellLink(currentValue) && !isCellLink(newValue)) {
    const storedLink = parseLink(currentValue, link);
    if (scopeRank(storedLink.scope) > scopeRank(link.scope)) {
      diffLogger.debug(
        "diff",
        () =>
          `[BRANCH_SCOPED_REDIRECT] Following narrower-scope stored link at path=${pathStr} (${link.scope} -> ${storedLink.scope})`,
      );
      return normalizeAndDiff(
        runtime,
        tx,
        storedLink.schema === undefined && link.schema !== undefined
          ? { ...storedLink, schema: link.schema }
          : storedLink,
        newValue,
        context,
        options,
        state,
        NO_PRECOMPUTED,
        undefined,
        isArrayElement,
      );
    }
  }

  if (isPrimitiveCellLink(newValue)) {
    diffLogger.debug(
      "diff",
      () =>
        `[BRANCH_CELL_LINK] Processing cell link at path=${pathStr} link=${
          toCompactDebugString(newValue)
        }`,
    );
    const carriedCfcLabelView = cfcLabelViewForPrimitiveLink(newValue);
    const parsedLink = parseLink(newValue, link);

    // Collapse same-document self/parent links created by query-result dereferencing.
    // Example: "internal.__#1.next" -> "internal.__#1". Writing that link would
    // create a tight self-loop, so we instead embed the target's current value
    // (a plain JSON snapshot). Do not collapse when the link came from converting
    // a seen cycle to a Cell, and only collapse when the target is the immediate
    // parent path.
    if (!linkOriginFromCell && isImmediateParent(parsedLink, link)) {
      diffLogger.debug(
        "diff",
        () =>
          `[CELL_LINK_COLLAPSE] Same-doc ancestor/self link detected at path=${pathStr} -> embedding snapshot from ${
            parsedLink.path.join(".")
          }`,
      );
      const snapshot = tx.readValueOrThrow(
        parsedLink,
        options,
      ) as unknown;
      // This re-entry REPLACES the value (the snapshot, not the link), so
      // anchoring eligibility deliberately does not carry over -- matching
      // the annotation scheme, which never looked behind links.
      return normalizeAndDiff(
        runtime,
        tx,
        link,
        snapshot,
        context,
        options,
        state,
      );
    }
    if (
      isPrimitiveCellLink(currentValue) &&
      areLinksSame(newValue, currentValue, link)
    ) {
      diffLogger.debug(
        "diff",
        () => `[BRANCH_CELL_LINK] Same cell link, no-op at path=${pathStr}`,
      );
      if (cfcLabelViewHasValues(carriedCfcLabelView)) {
        recordLinkWritePolicyInput(tx, link, parsedLink, carriedCfcLabelView);
      }
      return [];
    } else {
      // Scope-isolation guard (spec: docs/specs/scoped-cell-instances.md,
      // "the runtime must not read across effective scope keys"; pitfall #6 in
      // docs/development/debugging/gotchas/scoped-cell-pitfalls.md): a link
      // whose scope is NARROWER than the slot it's written into resolves to a
      // DIFFERENT instance for every reader — links deliberately do not encode
      // the principal, so e.g. a `user`-scoped link stored in `space`-scoped
      // shared data hands every other participant a link to their own (empty)
      // instance. When the write meant to SHARE data, it can never propagate;
      // readers see a permanent hole (the B2 reader-blackout investigation,
      // #4457/#4532). The slot's schema declaring the scope (the narrowing
      // branch above and scoped asCell entries) is a scope CAP (seefeld):
      // content may be AT MOST that narrow — a same-or-broader link is
      // correct usage and silent; a narrower-than-cap link still warns. The
      // undeclared case has no cap, so the warn there is a sharing-intent
      // heuristic, not cap enforcement. The warn fires where the slot's shape says the
      // author wanted SHARED data (ubik2's criterion): the slot's schema
      // doesn't match undefined and carries no effective default
      // (schemaToleratesMissing, judged with the read side's own matcher),
      // AND the parent's schema lists the slot in `required`
      // (slotRequiredByParent, threaded one hop by the object branch; direct
      // slot writes — cell.key().set(), bound handler cells — have no parent
      // in view and keep the warn). This approximates but is NOT identical to
      // "the read would reject": the B2 element grace (and its
      // generation-skew extension, #4668) means array-element reads degrade
      // rather than void, and rejection is ultimately judged against each
      // READER's combined schema — the warn is a write-site lint, not a
      // proof. The degrades make this warn MORE load-bearing, not less: a
      // reader cannot distinguish an unresolvable narrower-scoped link from
      // an old-generation absent target (both resolve to undefined), so this
      // write-site diagnostic is where a scope mistake self-identifies. Undefined-tolerant, defaulted, or optional slots
      // degrade harmlessly per reader, which is a legitimate pattern and also
      // what the runtime's own scoped-link writes (.asScope() results,
      // navigateTo result cells, updateArgument setup wiring, cold-resume
      // re-scope walks) flow through. This is a WARN, not a throw, pending
      // review; see #4561. Authors: share the value, or a space-scoped cell
      // with a PerUser pointer to "mine" (pitfall #6 shows the idiom).
      if (scopeRank(parsedLink.scope) > scopeRank(link.scope)) {
        const declared = declaredCellScope(link.schema);
        if (
          (declared === undefined ||
            scopeRank(declared) < scopeRank(parsedLink.scope)) &&
          !schemaToleratesMissing(link.schema) &&
          // Optional slots (parent schema present, key not in `required`)
          // degrade harmlessly when the cell is missing — only a required
          // slot voids the read. Unknown parents (direct slot writes) keep
          // the warn.
          slotRequiredByParent !== false
        ) {
          diffLogger.warn(
            "diff",
            () => [
              `Storing a ${parsedLink.scope}-scoped link in ` +
              `${link.scope}-scoped data at path "${pathStr}": scoped links ` +
              `do not carry a principal, so every reader resolves it to ` +
              `their own ${parsedLink.scope} instance. If this write meant ` +
              `to SHARE data, it cannot propagate — share the value itself, ` +
              `or a space-scoped cell (keep a PerUser pointer to "mine"), ` +
              `or declare the slot's schema with scope ` +
              `"${parsedLink.scope}" if per-reader resolution is intended. ` +
              `See docs/development/debugging/gotchas/` +
              `scoped-cell-pitfalls.md (pitfall 6).`,
            ],
          );
        }
      }
      diffLogger.debug(
        "diff",
        () =>
          `[BRANCH_CELL_LINK] Different cell link, updating at path=${pathStr}`,
      );
      recordLinkWritePolicyInput(tx, link, parsedLink, carriedCfcLabelView);
      return [
        // TODO(seefeld): Normalize the link to a sigil link?
        {
          location: link,
          value: stripCfcLabelViewFromPrimitiveLink(newValue) as FabricValue,
        },
      ];
    }
  }

  // Convert the (top level of) the value to fabric form (a valid `FabricValue`)
  // if it isn't already, or throw if it's neither already valid nor
  // convertible. The pre-conversion value is kept: shared references and
  // cycles arrive under that identity, so it is what anchoring registers in
  // `state.seen`.
  const preConversionValue = newValue;
  const fabricValue = shallowFabricFromNativeValue(newValue);
  if (fabricValue !== newValue) {
    diffLogger.debug(
      "diff",
      () =>
        `[TO_STORABLE_VALUE] Converted ${typeof newValue} at path=${pathStr}`,
    );
    newValue = fabricValue;
  }

  // Anchor a plain object sitting in an array into an entity document of its
  // own, so mutable arrays hold links rather than inline objects. Only a
  // writer that supplied an id source (i.e. one running under a builder
  // frame) anchors, and the source is consumed once per eligible element in
  // traversal order, so the derived ids do not depend on the currently stored
  // state. Cells, links, and query results were consumed by earlier branches,
  // and atomic fabric objects are excluded here; arrays never anchor, only
  // the objects inside them.
  //
  // An element carried through UNTOUCHED from the stored array diffs to
  // NOTHING -- returned here without descending. This is load-bearing for
  // the mergeable collection ops (`push`/`addUnique`) twice over: their
  // array read is excluded from the commit's conflict set (see
  // docs/features/mergeable-collection-writes.md), which is only safe
  // while the op emits no writes below the tail, so (1) the element itself
  // must not be re-anchored or rewritten, and (2) it must not be DESCENDED
  // either -- descending would register its interior objects in
  // `state.seen`, letting a later occurrence in the same write alias (and
  // promotion would then repoint!) content inside the untouched prefix.
  //
  // "Untouched" is exact identity with the stored value, deliberately NOT
  // content equality: the ops build their combined arrays by carrying the
  // stored elements through by reference (the stored tree is frozen, so the
  // reference IS the stored value), while the written value here is only
  // shallowly normalized -- its nested contents (Cells, native objects) are
  // converted later in the recursion, so a deep comparison would inspect
  // values whose canonical form does not exist yet.
  //
  // Atomic fabric objects are excluded from this guard: an untouched
  // special-object prefix element re-emits its identical stored instance
  // from the instance branch below, and the mergeable invariant for those
  // elements rests on the write layer eliding that identical write from the
  // journal rather than on this guard.
  if (
    state.nextAnchorId !== undefined &&
    isArrayElement &&
    isObjectNotArray(newValue) &&
    !(newValue instanceof FabricSpecialObject) &&
    !isCellLink(newValue)
  ) {
    if (Object.is(currentValue, preConversionValue)) {
      diffLogger.debug(
        "diff",
        () => `[BRANCH_ANCHOR] Untouched element, no-op at path=${pathStr}`,
      );
      return [];
    }
    diffLogger.debug(
      "diff",
      () => `[BRANCH_ANCHOR] Anchoring array element at path=${pathStr}`,
    );
    // The content must be a distinct object from the registered one: the
    // recursion that writes it into the entity document would otherwise find
    // the value in `state.seen` and no-op as a self-reference, and the
    // document would never be written. A shallow copy keeps nested shared
    // references intact, so cycles still resolve through `state.seen`.
    return anchorValueAsEntity(
      runtime,
      tx,
      link,
      { ...(newValue as FabricPlainObject) },
      preConversionValue,
      state.nextAnchorId(),
      context,
      options,
      state,
    );
  }

  // Handle arrays
  if (Array.isArray(newValue)) {
    diffLogger.debug(
      "diff",
      () =>
        `[BRANCH_ARRAY] Processing array at path=${pathStr} length=${newValue.length}`,
    );
    // If the current value is not an array, set it to an empty array
    if (!Array.isArray(currentValue)) {
      changes.push({ location: link, value: [] });
    }

    // Have to set this before recursing!
    state.seen.set(newValue, link);
    // Shared references and cycles arrive under the pre-conversion identity;
    // register that too when conversion produced a copy.
    if (preConversionValue !== newValue) {
      state.seen.set(preConversionValue, link);
    }

    // Get current array for precomputing child values (if it was an array)
    const currentArray = Array.isArray(currentValue) ? currentValue : undefined;

    // On GROWTH the length change must precede the element writes: applying
    // a slot write beyond the current end auto-extends the array, turning a
    // later length write into a no-op the write layer elides from the
    // journal — write-detail consumers (flow-label clear/re-stamp of the
    // ["length"] entries) would never see the length change, fossilizing
    // its labels at whatever join first stamped them. The shrink direction
    // is the opposite (deletes first, length last) — see below.
    if (
      Array.isArray(currentValue) && newValue.length > currentValue.length
    ) {
      const lub = (link.schema !== undefined)
        ? ContextualFlowControl.lubSchema(link.schema)
        : undefined;
      const lengthSchema = (lub !== undefined)
        ? { type: "number", ifc: { confidentiality: lub } } as JSONSchema
        : { type: "number" } as JSONSchema;
      changes.push({
        location: {
          ...link,
          path: [...link.path, "length"],
          schema: lengthSchema,
        },
        value: newValue.length,
      });
    }

    for (let i = 0; i < newValue.length; i++) {
      const inNew = i in newValue;
      const inCur = currentArray ? i in currentArray : false;

      if (!inNew && !inCur) continue; // hole→hole: no change

      if (!inNew && inCur) {
        // value→hole: emit an explicit delete (a plain `undefined` write
        // would store `undefined` rather than punching a hole)
        changes.push({
          location: {
            ...link,
            path: [...link.path, i.toString()],
            schema: ContextualFlowControl.getSchemaAtPath(link.schema, [
              i.toString(),
            ]),
          },
          value: undefined,
          delete: true,
        });
        continue;
      }

      // hole→value or value→value: recurse normally
      const childSchema = ContextualFlowControl.getSchemaAtPath(link.schema, [
        i.toString(),
      ]);

      // hole→explicit-undefined: a real change (the slot becomes
      // present-but-undefined) that the value diff below can't see, since
      // both sides read as `undefined`. Emit the write directly.
      if (newValue[i] === undefined && !inCur) {
        changes.push({
          location: {
            ...link,
            path: [...link.path, i.toString()],
            schema: childSchema,
          },
          value: undefined,
        });
        continue;
      }

      const nestedChanges = normalizeAndDiff(
        runtime,
        tx,
        {
          ...link,
          path: [...link.path, i.toString()],
          schema: childSchema,
        },
        newValue[i],
        context,
        options,
        state,
        inCur ? currentArray![i] : undefined,
        undefined,
        true,
      );
      changes.push(...nestedChanges);
    }

    // Handle array SHRINK (growth emitted its length change above, before
    // the element writes)
    if (Array.isArray(currentValue) && currentValue.length > newValue.length) {
      // We need to add the schema here, since the array may be secret, so the length should be too
      const lub = (link.schema !== undefined)
        ? ContextualFlowControl.lubSchema(link.schema)
        : undefined;
      // We have to cast these, since the type could be changed to another value
      const childSchema = (lub !== undefined)
        ? { type: "number", ifc: { confidentiality: lub } } as JSONSchema
        : { type: "number" } as JSONSchema;
      // Slots truncated by a shrink are removed, not merely out of range:
      // emit explicit deletes (the direct `length`-write path's idiom) so
      // write-detail consumers — notably the flow-label carry-forward that
      // must drop the removed slots' stale per-slot link entries — see the
      // removal. Ordered BEFORE the length change: once the length write
      // has truncated the array, a delete at a now-absent slot is a no-op
      // the write layer elides from the journal. Growth needs nothing
      // here — the element loop above already visited every new slot.
      for (let i = newValue.length; i < currentValue.length; i++) {
        if (!(i in currentValue)) continue; // hole: nothing to remove
        changes.push({
          location: {
            ...link,
            path: [...link.path, i.toString()],
            schema: ContextualFlowControl.getSchemaAtPath(link.schema, [
              i.toString(),
            ]),
          },
          value: undefined,
          delete: true,
        });
      }
      changes.push({
        location: {
          ...link,
          path: [...link.path, "length"],
          schema: childSchema,
        },
        value: newValue.length,
      });
    }

    return changes;
  }

  // `FabricSpecialObject` values (`FabricInstance` wrappers and `FabricPrimitive`
  // leaves alike) are atomic from this layer's perspective: their
  // own-enumerable properties are implementation details, not
  // user-visible structure, and iterating them via the generic
  // `isObjectOrArray` branch below would walk wrapper-internal fields (or, for a
  // primitive whose state is private, flatten it to `{}`), which
  // is meaningless at the change-emission level. Emit a single change at
  // this link with the value as-is — the storage layer's JSON encoding handles
  // serialization (via each type's `[CODEC]`). Placed after the write-redirect
  // resolution above so writes through a redirect land on the target,
  // not on the redirect itself.
  if (newValue instanceof FabricSpecialObject) {
    diffLogger.debug(
      "diff",
      () => `[BRANCH_FABRIC_INSTANCE] Atomic FabricInstance at path=${pathStr}`,
    );
    // TODO(danfuzz): Replace this band-aid once the unified walk supports
    // coordinated descent into `FabricInstance` internals (see below); at that
    // point switch this to a shallow conversion.
    //
    // BAND-AID: this *should* be a shallow conversion. This is a unified walk
    // (one walk state for shared-ref/cycle handling, element anchoring, and
    // diffing), and the right design is to shallow-wrap the `FabricInstance`
    // here and let this walk descend into its `FabricValue` internals as part
    // of the same coordinated pass. We don't support that descent yet, so the
    // wrapper's internals could otherwise reach storage improperly converted.
    //
    // As a stopgap we run the deep `fabricFromNativeValue()`, which converts
    // the internals via a *separate, uncoordinated* pass. The cost: any
    // `FabricValue` reachable both inside the wrapper and elsewhere in the
    // outer tree gets de-shared (the outer walk handles one copy; this deep
    // call mints an independent, separately-frozen copy with no shared `seen`
    // / ID bookkeeping). That is invisible for `FabricError` today only
    // because an error's `cause` / custom props aren't, in practice, shared
    // with the rest of the tree -- but `FabricSet` / `FabricMap` (collections
    // of arbitrary, routinely-shared `FabricValue`s) WILL break here once they
    // carry real traffic. Proper fix: coordinated descent into wrapper
    // internals, after which a shallow conversion suffices.
    //
    // The call is class-agnostic (no concrete-subclass special-casing): each
    // subclass governs its own deep conversion and already-proper / deep-frozen
    // instances short-circuit by identity.
    changes.push({
      location: link,
      value: fabricFromNativeValue(newValue),
    });
    return changes;
  }

  // Handle objects
  if (isObjectOrArray(newValue)) {
    diffLogger.debug(
      "diff",
      () => `[BRANCH_OBJECT] Processing object at path=${pathStr}`,
    );
    // If the current value is not a (regular) object, set it to an empty object.
    // Note that the alias case is handled above.
    // We use `isObjectNotArray` (not `isObjectOrArray`) here deliberately: `isObjectOrArray` is true
    // for arrays (`typeof [] === "object"`), whereas `isObjectNotArray` excludes them.
    // Resetting on an array→object transition is required; otherwise per-key
    // writes land in a slot whose stored parent is still an array and storage
    // rejects them with a TypeMismatchError. This mirrors the array branch
    // above, which resets a mismatched container via `value: []`.
    //
    // TODO(danfuzz): `isObjectNotArray` is also true for a `FabricSpecialObject`, so
    // a stored special object (which reaches storage whole via this
    // function's `FabricSpecialObject` branch above) is treated as an
    // existing plain record: no reset is emitted, its zero keys yield no
    // removals, and the per-key child writes land in slots whose stored
    // parent is still the special object. The special-object→object
    // transition wants the same reset the array→object one gets.
    if (!isObjectNotArray(currentValue) || isPrimitiveCellLink(currentValue)) {
      diffLogger.debug(
        "diff",
        () =>
          `[BRANCH_OBJECT] Current value is not a record or cell link, setting to empty object at path=${pathStr}`,
      );
      changes.push({ location: link, value: {} });
      currentValue = {};
    }

    // Have to set this before recursing!
    state.seen.set(newValue, link);
    // Shared references and cycles arrive under the pre-conversion identity;
    // register that too when conversion produced a copy.
    if (preConversionValue !== newValue) {
      state.seen.set(preConversionValue, link);
    }

    // At this point currentValue is guaranteed to be a record
    const currentRecord = currentValue as Record<string, unknown>;

    // Requiredness of each child slot, for the scope-isolation warn: only a
    // parent-`required` property makes a missing cell void the read.
    // A resolved object schema with no top-level `required` array is treated
    // as requiring nothing (known `false` for every key); only an absent /
    // unresolvable parent schema leaves requiredness unknown (undefined).
    // KNOWN GAP (deliberate, false-negative direction): `required` carried
    // inside a compound parent (`allOf` branches, all-branches-require
    // `anyOf`) is not merged here — resolveSchema resolves only a top-level
    // $ref — so such parents read as requiring nothing and the warn stays
    // silent, even though the read side's required-intersection machinery may
    // still reject. A missed warn is acceptable for a lint; asserting
    // requiredness where there is none is not.
    const resolvedParentSchema = resolveSchema(link.schema);
    const requiredProps = isObjectOrArray(resolvedParentSchema)
      ? new Set(
        Array.isArray(resolvedParentSchema.required)
          ? (resolvedParentSchema.required as readonly string[])
          : [],
      )
      : undefined;

    // `Object.keys`, not `for...in`: the latter also walks the prototype chain,
    // and only `newValue`'s own keys are being written.
    for (const key of Object.keys(newValue)) {
      diffLogger.debug("diff", () => {
        const childPath = [...link.path, key].join(".");
        return `[DIFF_RECURSE] Recursing into key='${key}' childPath=${childPath}`;
      });

      const childSchema = ContextualFlowControl.getSchemaAtPath(link.schema, [
        key,
      ]);

      // An explicit `undefined` for a key the current object doesn't have is
      // a real change — the slot becomes present-but-undefined — but the
      // value diff below sees `undefined === undefined` and would emit
      // nothing. `undefined` is a leaf, so emit the write directly.
      //
      // `Object.hasOwn`, not `in`: `key` is a data key and `currentRecord` is
      // data. `in` walks the prototype chain, so setting a key called
      // `toString` to `undefined` looked like it was already present and the
      // write was dropped.
      if (newValue[key] === undefined && !Object.hasOwn(currentRecord, key)) {
        changes.push({
          location: { ...link, path: [...link.path, key], schema: childSchema },
          value: undefined,
        });
        continue;
      }

      const nestedChanges = normalizeAndDiff(
        runtime,
        tx,
        { ...link, path: [...link.path, key], schema: childSchema },
        newValue[key],
        context,
        options,
        state,
        // Indexing alone would fall through to the prototype: for a key named
        // `valueOf`, a record with no such own property yields
        // `Object.prototype.valueOf`, and the diff below then fails with
        // "Cannot compare a function value" — a write refused because of a
        // method the data never had. Absent means absent.
        Object.hasOwn(currentRecord, key) ? currentRecord[key] : undefined,
        requiredProps === undefined ? undefined : requiredProps.has(key),
      );
      changes.push(...nestedChanges);
    }

    // The scope-narrowing branch at the top of normalizeAndDiff only fires for
    // keys present in newValue (e.g. populated from a schema default). A
    // property whose schema declares a narrower scope but arrives with no
    // value would leave the base-scope slot empty, so later schema-less writes
    // (e.g. through a handler's cell reference) would land at the base scope
    // instead of the narrower instance. Eagerly materialize the redirect for
    // those keys, and exempt them from removal below so an object rewrite that
    // omits the key can't strip the redirect either. Only the redirect is
    // written; the narrower-scope instance's content is left untouched.
    // (resolveSchema, not resolveSchemaForValue: the latter recurses through
    // property values and diverges on circular values + recursive $ref
    // schemas; only the top-level property names are needed here.)
    const eagerScopedKeys = new Set<string>();
    const schemaProperties = isObjectOrArray(resolvedParentSchema)
      ? resolvedParentSchema.properties
      : undefined;
    if (isObjectOrArray(schemaProperties)) {
      // `Object.keys`, not `for...in`: the latter walks the prototype chain
      // too, and these are the schema's OWN declared property names.
      for (const key of Object.keys(schemaProperties)) {
        // `Object.hasOwn`, not `in`, for the same reason one line up: `key` is
        // a schema-declared name and `newValue` is data, so a property called
        // `toString` looked present on every object and its eager scoping was
        // skipped.
        if (Object.hasOwn(newValue, key)) continue;
        const childSchema = ContextualFlowControl.getSchemaAtPath(link.schema, [
          key,
        ]);
        const childScope = declaredCellScope(childSchema);
        if (
          childScope === undefined ||
          scopeRank(childScope) <= scopeRank(link.scope)
        ) {
          continue;
        }
        const childLink: NormalizedFullLink = {
          ...link,
          path: [...link.path, key],
          schema: childSchema,
        };
        const scopedLink: NormalizedFullLink = {
          ...childLink,
          scope: childScope,
        };
        recordRelevantSchemaWritePolicyInput(
          tx,
          scopedLink,
          scopedLink.schema,
          options?.schemaRole,
        );
        recordScopedInstanceRootPolicy(
          runtime,
          tx,
          scopedLink,
          options?.schemaRole,
        );
        changes.push(
          ...normalizeAndDiff(
            runtime,
            tx,
            childLink,
            createSigilLinkFromParsedLink(scopedLink, {
              base: childLink,
            }) as unknown,
            context,
            options,
            state,
            currentRecord[key],
          ),
        );
        eagerScopedKeys.add(key);
      }
    }

    // Handle removed keys: explicit deletes, so a key the new value omits is
    // removed rather than left behind as present-but-undefined.
    //
    // `Object.keys` + `Object.hasOwn`, not `for...in` + `in`: both walk the
    // prototype chain. A stored property named `toString` was never removed,
    // because `"toString" in newValue` is true for every object — so setting
    // `{ name }` over `{ name, toString }` left the `toString` behind.
    for (const key of Object.keys(currentRecord)) {
      if (!Object.hasOwn(newValue, key) && !eagerScopedKeys.has(key)) {
        changes.push({
          location: { ...link, path: [...link.path, key] },
          value: undefined,
          delete: true,
        });
      }
    }

    return changes;
  }

  // When setting array length, also update the removed/added elements.
  if (
    link.path.length > 0 && link.path[link.path.length - 1] === "length"
  ) {
    const maybeCurrentArray = tx.readValueOrThrow({
      ...link,
      path: link.path.slice(0, -1),
    }, options);
    if (Array.isArray(maybeCurrentArray)) {
      const currentLength = maybeCurrentArray.length;
      const newLength = newValue as number;
      if (currentLength !== newLength) {
        changes.push({ location: link, value: newLength });
        for (
          let i = Math.min(currentLength, newLength);
          i < Math.max(currentLength, newLength);
          i++
        ) {
          // Slots beyond the shorter length are removed (or, on growth,
          // were never present): explicit deletes, not `undefined` values.
          changes.push({
            location: {
              ...link,
              path: [...link.path.slice(0, -1), i.toString()],
            },
            value: undefined,
            delete: true,
          });
        }
        return changes;
      }
    } // else, i.e. parent is not an array: fall through to the primitive case
  }

  // Handle primitive values and other cases (Object.is handles NaN and -0)
  if (!Object.is(currentValue, newValue)) {
    changes.push({ location: link, value: newValue as FabricValue });
  }

  return changes;
}

/**
 * Checks if a value contains data at a given path.
 * Returns true if the path exists in the value (even if the value at that path is undefined).
 */
function hasPath(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return true;

  if (value === null || value === undefined || typeof value !== "object") {
    return false;
  }

  const [first, ...rest] = path;

  if (Array.isArray(value)) {
    // Special case: "length" is always present on arrays
    if (first === "length" && rest.length === 0) return true;
    // Only valid array index strings can access array elements
    if (!isArrayIndexPropertyName(first)) return false;
    // Use `in` to correctly handle sparse arrays (holes are not present)
    const index = Number(first);
    if (!(index in value)) return false;
    return hasPath(value[index], rest);
  }

  const obj = value as Record<string, unknown>;
  if (!(first in obj)) return false;
  return hasPath(obj[first], rest);
}

/**
 * Compacts a ChangeSet by removing redundant child path changes when a
 * parent path change already includes that data.
 *
 * This optimization reduces the number of writes when setting nested structures.
 * For example, if we set `foo = {a: 1, b: 2}` and also set `foo/a = 1`,
 * the child write is redundant since the parent already contains it.
 *
 * Key rules:
 * - Empty objects `{}` or arrays `[]` do NOT subsume children (children populate them)
 * - Parent deletions (`delete: true`) and parent writes of `undefined` DO
 *   subsume child changes (either way the subtree at the parent is gone)
 * - Parent must actually CONTAIN the child's path for subsumption to occur
 *
 * @param changes - The original change set
 * @returns A compacted change set with redundant child paths removed
 */
export function compactChangeSet(changes: ChangeSet): ChangeSet {
  if (changes.length <= 1) return changes;

  // Group by document using safe separator (JSON.stringify avoids key collisions)
  const byDocument = new Map<string, ChangeSet>();
  for (const change of changes) {
    const key = JSON.stringify([
      change.location.space,
      change.location.id,
    ]);
    if (!byDocument.has(key)) byDocument.set(key, []);
    byDocument.get(key)!.push(change);
  }

  const result: ChangeSet = [];
  for (const docChanges of byDocument.values()) {
    // Sort by path length (shortest first - parents before children)
    const sorted = docChanges.toSorted(
      (a, b) => a.location.path.length - b.location.path.length,
    );

    // Track parent paths that can subsume children
    // Empty {} or [] don't subsume - children populate them!
    const subsumingPaths: Array<
      { path: readonly string[]; value: unknown; delete?: boolean }
    > = [];

    for (const change of sorted) {
      const path = change.location.path;

      // Check if subsumed by a parent with actual content
      const isSubsumed = subsumingPaths.some((parent) => {
        if (parent.path.length >= path.length) return false;
        if (!parent.path.every((seg, i) => seg === path[i])) return false;

        // Parent path is prefix - check if parent VALUE contains this child's path
        const parentVal = parent.value;
        if (parentVal === null || parentVal === undefined) return false;
        if (typeof parentVal !== "object") return false;

        // Calculate the relative path from parent to child
        const relativePath = path.slice(parent.path.length);

        // Only subsume if parent's value actually contains data at the child's relative path
        return hasPath(parentVal, relativePath);
      });

      // Also check: is this child subsumed by a parent whose subtree is gone
      // (explicit delete, or overwritten with `undefined`)?
      const isDeletedByParent = subsumingPaths.some((parent) => {
        if (parent.path.length >= path.length) return false;
        if (!parent.path.every((seg, i) => seg === path[i])) return false;
        return parent.delete === true || parent.value === undefined;
      });

      if (!isSubsumed && !isDeletedByParent) {
        result.push(change);
        // Track this path for potential child subsumption
        subsumingPaths.push({
          path,
          value: change.value,
          delete: change.delete,
        });
      }
    }
  }

  diffLogger.debug(
    "compact",
    () =>
      `[compactChangeSet] Compacted ${changes.length} changes to ${result.length}`,
  );

  return result;
}

/**
 * Apply a change set to all mentioned documents.
 *
 * @param changes - The change set to apply.
 * @param log - The log to write to.
 */
export function applyChangeSet(
  tx: IExtendedStorageTransaction,
  changes: ChangeSet,
) {
  // CT-1123: Removed compactChangeSet - structural sharing makes redundant writes
  // cheap (O(path_depth) with noop detection), while compaction added O(N²) overhead.
  // Benchmarks showed 2.5-4.4x slowdown with compactChangeSet enabled.
  if (tx.writeValuesOrThrow) {
    tx.writeValuesOrThrow(
      changes.map((change) => ({
        address: change.location,
        value: change.value,
        delete: change.delete,
      })),
    );
    return;
  }
  for (const change of changes) {
    // `diffAndUpdate()` establishes attempted-target coverage before we get
    // here, so these direct writes preserve the phase-1 `attemptedWrites` view.
    tx.writeValueOrThrow(
      change.location,
      change.value,
      change.delete ? { delete: true } : undefined,
    );
  }
}

/**
 * Returns true if `target` is the immediate parent of `base` in the same document.
 *
 * Example:
 * - base.path = ["__#1", "next"]
 * - target.path = ["__#1"]
 *
 * This is used to decide when to collapse a self/parent link that would create
 * a tight self-loop (e.g., obj.next -> obj) while allowing references to
 * higher ancestors (like an item's `items` pointing to its containing array).
 */
function isImmediateParent(
  target: NormalizedFullLink,
  base: NormalizedFullLink,
): boolean {
  return (
    target.id === base.id &&
    target.space === base.space &&
    target.path.length === base.path.length - 1 &&
    target.path.every((seg, i) => seg === base.path[i])
  );
}
