import { isObject, isRecord } from "@commonfabric/utils/types";
import {
  fabricFromNativeValue,
  type FabricPlainObject,
  FabricSpecialObject,
  type FabricValue,
  shallowFabricFromNativeValue,
} from "@commonfabric/data-model/fabric-value";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import { getLogger } from "@commonfabric/utils/logger";
import {
  type CellScope,
  ID,
  ID_FIELD,
  type JSONSchema,
} from "./builder/types.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { isCellScope, scopeRank } from "./scope.ts";
import { createRef } from "./create-ref.ts";
import {
  CellImpl,
  isCell,
  recordRelevantSchemaWritePolicyInput,
} from "./cell.ts";
import { resolveLink } from "./link-resolution.ts";
import {
  areLinksSame,
  areMaybeLinkAndNormalizedLinkSame,
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  findAndInlineDataURILinks,
  isCellLink,
  isPrimitiveCellLink,
  isSigilLink,
  isWriteRedirectLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import {
  type CfcCellLinkRefPayload,
  linkCfcLabelView,
} from "./cfc/link-label-view.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import { resolveSchema, resolveSchemaForValue } from "./schema.ts";
import type {
  IExtendedStorageTransaction,
  IReadOptions,
} from "./storage/interface.ts";
import { type Runtime } from "./runtime.ts";
import { toURI } from "./uri-utils.ts";
import {
  allowMutableTransactionRead,
  markReadAsAttemptedWrite,
} from "./scheduler.ts";
import { ignoreReadForScheduling } from "./storage/reactivity-log.ts";
import {
  readStoredCfcMetadata,
  storedCfcMetadataAppliesToPath,
} from "./cfc/metadata.ts";
import { canonicalizeLogicalPath } from "./cfc/canonical.ts";
import {
  type CfcLabelView,
  cloneCfcLabelView,
  getCarriedCfcLabelView,
} from "./cfc/label-view-state.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_SEED_MATERIALIZATION,
  type CfcAddress,
} from "./cfc/types.ts";
import { linkRefFrom, linkRefPayload } from "@commonfabric/data-model/cell-rep";

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
    confidentiality?: readonly unknown[];
    integrity?: readonly unknown[];
  },
): boolean =>
  (label.confidentiality?.length ?? 0) > 0 ||
  (label.integrity?.length ?? 0) > 0;

const cfcLabelViewHasValues = (view: CfcLabelView | undefined): boolean =>
  view?.entries.some((entry) => labelHasValues(entry.label)) ?? false;

const schemaIfcOverlapsPath = (
  schema: JSONSchema | undefined,
  basePath: readonly string[],
  sourcePath: readonly string[],
): boolean => {
  if (schema === undefined || typeof schema === "boolean") {
    return false;
  }
  const visit = (
    current: JSONSchema,
    path: readonly string[],
  ): boolean => {
    if (typeof current === "boolean") {
      return false;
    }
    if (
      isRecord(current.ifc) &&
      labelHasValues(current.ifc) &&
      schemaPathsOverlap(path, sourcePath)
    ) {
      return true;
    }
    if (current.type === "object" && isRecord(current.properties)) {
      for (const [key, child] of Object.entries(current.properties)) {
        if (visit(child as JSONSchema, [...path, key])) {
          return true;
        }
      }
    }
    if (current.type === "array" && current.items !== undefined) {
      return visit(current.items, [...path, "*"]);
    }
    return false;
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
  const targetRelevant = storedCfcMetadataAppliesToPath(tx, target) ||
    hasPendingSchemaPolicyInput(tx, target);
  if (!sourceRelevant && !targetRelevant) {
    return;
  }

  tx.markCfcRelevant(`link-write:${target.id}`);
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

/**
 * Traverses newValue and updates `current` and any relevant linked documents.
 *
 * Returns true if any changes were made.
 *
 * When encountering an object with a `[ID]` property, it'll be used to compute
 * an entity id based on it's relative location and the passed context, and the
 * changes will be written to that entity.
 *
 * @param current - A doc link to the current value to compare against.
 * @param newValue - The new value to traverse.
 * @param log - The log to write to.
 * @param context - The context of the change.
 * @returns Whether any changes were made.
 */
export function diffAndUpdate(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  newValue: unknown,
  context?: unknown,
  options?: IReadOptions,
): boolean {
  const readOptions: IReadOptions = {
    ...options,
    meta: {
      ...options?.meta,
      ...markReadAsAttemptedWrite,
      ...allowMutableTransactionRead,
    },
  };
  const changes = normalizeAndDiff(
    runtime,
    tx,
    link,
    newValue,
    context,
    readOptions,
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
 * Traverses objects and returns an array of changes that should be written. An
 * empty array means no changes.
 *
 * When encountering an object with a `[ID]` property, it'll be used to compute
 * an entity id based on it's relative location and the passed context, and the
 * changes will be queued to be written to that entity.
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
  options?: IReadOptions,
  seen: Map<any, NormalizedFullLink> = new Map(),
  precomputedCurrent: unknown = NO_PRECOMPUTED,
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
  if (seen.has(newValue)) {
    diffLogger.debug(
      "diff",
      () =>
        `[SEEN_CHECK] Already seen object at path=${pathStr}, converting to cell`,
    );
    newValue = new CellImpl(runtime, tx, seen.get(newValue)!);
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
        seen,
      ),
      // The broader-scope slot points to that instance.
      ...normalizeAndDiff(
        runtime,
        tx,
        link,
        createSigilLinkFromParsedLink(scopedLink, { base: link }) as unknown,
        context,
        options,
        seen,
      ),
    ];
  }

  // ID_FIELD redirects to an existing field and we do something like DOM
  // diffing with it: We look at sibling entries and their value for that field,
  // and if we find a match, we reuse that document. Otherwise we create a new
  // one, but with a random id. It's random as opposed to causal like ID below,
  // because we don't want to recycle a document that was removed and added
  // back, we want to assume removing and adding with the same id is
  // semantically a new item (in fact we otherwise run into compare-and-swap
  // transaction errors).
  if (
    isRecord(newValue) &&
    newValue[ID_FIELD] !== undefined
  ) {
    diffLogger.debug(
      "diff",
      () => `[BRANCH_ID_FIELD] Processing ID_FIELD redirect at path=${pathStr}`,
    );
    const { [ID_FIELD]: fieldName, ...rest } = newValue as
      & { [ID_FIELD]: string }
      & FabricPlainObject;
    const id = newValue[fieldName as PropertyKey];
    if (link.path.length > 1) {
      const parent = tx.readValueOrThrow({
        ...link,
        path: link.path.slice(0, -1),
      }, options);
      if (Array.isArray(parent)) {
        const base = runtime.getCellFromLink(link, undefined, tx);
        for (const v of parent) {
          if (isCellLink(v)) {
            const sibling = parseLink(v, base);
            const siblingId = tx.readValueOrThrow({
              ...sibling,
              path: [...sibling.path, fieldName as string],
            }, options);
            if (siblingId === id) {
              // We found a sibling with the same id, so ...
              return [
                // ... reuse the existing document
                ...normalizeAndDiff(
                  runtime,
                  tx,
                  link,
                  v,
                  context,
                  options,
                  seen,
                ),
                // ... and update it to the new value
                ...normalizeAndDiff(
                  runtime,
                  tx,
                  sibling,
                  rest,
                  context,
                  options,
                  seen,
                ),
              ];
            }
          }
        }
      }
    }
    // Fallback: A random id. Below this will create a new entity.
    newValue = { [ID]: crypto.randomUUID(), ...rest };
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
    const seedDefault = isRecord(cellSchema) ? cellSchema.default : undefined;
    const seedTarget = seedDefault !== undefined &&
        !(isRecord(seedDefault) &&
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
            fabricFromNativeValue(seedDefault) as FabricValue,
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
      newValue.getAsLink({ includeSchema: true }),
      carriedCfcLabelView,
    );
  }

  // Check for links that are data: URIs and inline them, by calling
  // normalizeAndDiff on the contents of the link.
  if (
    isCellLink(newValue) && parseLink(newValue, link).id?.startsWith("data:")
  ) {
    return normalizeAndDiff(
      runtime,
      tx,
      link,
      findAndInlineDataURILinks(newValue),
      context,
      options,
      seen,
    );
  }

  // If we're about to create a reference to ourselves, no-op
  if (areMaybeLinkAndNormalizedLinkSame(newValue, link)) {
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
      seen,
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
        seen,
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
      return normalizeAndDiff(
        runtime,
        tx,
        link,
        snapshot,
        context,
        options,
        seen,
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
      // instance. The data can never propagate; readers see a permanent hole
      // (the B2 reader-blackout investigation, #4457/#4532). Writing narrow
      // data into a broader slot is legitimate ONLY when the slot's schema
      // declares that scope (the narrowing branch above and scoped asCell
      // entries — the author opted into per-reader semantics). Otherwise the
      // write is a silent footgun: fail loudly at the write site, where the
      // author can fix it, instead of as a permanent silent hole for every
      // other reader. Share the value, or a space-scoped cell with a PerUser
      // pointer to "mine" (pitfall #6 shows the idiom).
      if (scopeRank(parsedLink.scope) > scopeRank(link.scope)) {
        const declared = declaredCellScope(link.schema);
        if (
          declared === undefined ||
          scopeRank(declared) < scopeRank(parsedLink.scope)
        ) {
          throw new Error(
            `Cannot store a ${parsedLink.scope}-scoped link in ` +
              `${link.scope}-scoped data at path "${pathStr}": scoped links ` +
              `do not carry a principal, so every reader would resolve it ` +
              `to their own ${parsedLink.scope} instance and the data can ` +
              `never propagate. Share the value itself, or a space-scoped ` +
              `cell (keep a PerUser pointer to "mine"), or declare the ` +
              `slot's schema with scope "${parsedLink.scope}" if per-reader ` +
              `resolution is intended. See docs/development/debugging/` +
              `gotchas/scoped-cell-pitfalls.md (pitfall 6).`,
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

  // Handle ID-based object (convert to entity)
  if (isRecord(newValue) && newValue[ID] !== undefined) {
    diffLogger.debug(
      "diff",
      () => `[BRANCH_ID_OBJECT] Processing ID-based object at path=${pathStr}`,
    );
    const { [ID]: id, ...rest } = newValue as
      & { [ID]: string }
      & FabricPlainObject;
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

    const entityId = createRef({ id }, {
      parent: { id: link.id, space: link.space },
      path,
      context,
    });

    const newEntryLink: NormalizedFullLink = {
      id: toURI(entityId),
      space: link.space,
      scope: link.scope,
      path: [],
      schema: resolveSchemaForValue(link.schema, rest),
    };

    seen.set(newValue, newEntryLink);

    // When a child value becomes its own entity document, carry the child
    // schema over so CFC metadata can be prepared for that new document too.
    recordRelevantSchemaWritePolicyInput(tx, newEntryLink, newEntryLink.schema);

    return [
      // If it wasn't already, set the current value to be a doc link to this doc
      ...normalizeAndDiff(
        runtime,
        tx,
        link,
        createSigilLinkFromParsedLink(newEntryLink, { base: link }),
        context,
        options,
        seen,
      ),
      // And see whether the value of the document itself changed
      ...normalizeAndDiff(
        runtime,
        tx,
        newEntryLink,
        rest,
        context,
        options,
        seen,
      ),
    ];
  }

  // Convert the (top level of) the value to fabric form (a valid `FabricValue`)
  // if it isn't already, or throw if it's neither already valid nor
  // convertible.
  const fabricValue = shallowFabricFromNativeValue(newValue);
  if (fabricValue !== newValue) {
    diffLogger.debug(
      "diff",
      () =>
        `[TO_STORABLE_VALUE] Converted ${typeof newValue} at path=${pathStr}`,
    );
    newValue = fabricValue;
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
    seen.set(newValue, link);

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
        ? runtime.cfc.lubSchema(link.schema)
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
            schema: runtime.cfc.getSchemaAtPath(link.schema, [i.toString()]),
          },
          value: undefined,
          delete: true,
        });
        continue;
      }

      // hole→value or value→value: recurse normally
      const childSchema = runtime.cfc.getSchemaAtPath(link.schema, [
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
        seen,
        inCur ? currentArray![i] : undefined,
      );
      changes.push(...nestedChanges);
    }

    // Handle array SHRINK (growth emitted its length change above, before
    // the element writes)
    if (Array.isArray(currentValue) && currentValue.length > newValue.length) {
      // We need to add the schema here, since the array may be secret, so the length should be too
      const lub = (link.schema !== undefined)
        ? runtime.cfc.lubSchema(link.schema)
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
            schema: runtime.cfc.getSchemaAtPath(link.schema, [i.toString()]),
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
  // `isRecord` branch below would walk wrapper-internal fields (or, for a
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
    // (one `seen` map for shared-ref/cycle handling, `[ID]` assignment, and
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
      value: fabricFromNativeValue(newValue) as FabricValue,
    });
    return changes;
  }

  // Handle objects
  if (isRecord(newValue)) {
    diffLogger.debug(
      "diff",
      () => `[BRANCH_OBJECT] Processing object at path=${pathStr}`,
    );
    // If the current value is not a (regular) object, set it to an empty object.
    // Note that the alias case is handled above.
    // We use `isObject` (not `isRecord`) here deliberately: `isRecord` is true
    // for arrays (`typeof [] === "object"`), whereas `isObject` excludes them.
    // Resetting on an array→object transition is required; otherwise per-key
    // writes land in a slot whose stored parent is still an array and storage
    // rejects them with a TypeMismatchError. This mirrors the array branch
    // above, which resets a mismatched container via `value: []`.
    if (!isObject(currentValue) || isPrimitiveCellLink(currentValue)) {
      diffLogger.debug(
        "diff",
        () =>
          `[BRANCH_OBJECT] Current value is not a record or cell link, setting to empty object at path=${pathStr}`,
      );
      changes.push({ location: link, value: {} });
      currentValue = {};
    }

    // Have to set this before recursing!
    seen.set(newValue, link);

    // At this point currentValue is guaranteed to be a record
    const currentRecord = currentValue as Record<string, unknown>;

    for (const key in newValue) {
      diffLogger.debug("diff", () => {
        const childPath = [...link.path, key].join(".");
        return `[DIFF_RECURSE] Recursing into key='${key}' childPath=${childPath}`;
      });

      const childSchema = runtime.cfc.getSchemaAtPath(link.schema, [key]);

      // An explicit `undefined` for a key the current object doesn't have is
      // a real change — the slot becomes present-but-undefined — but the
      // value diff below sees `undefined === undefined` and would emit
      // nothing. `undefined` is a leaf, so emit the write directly.
      if (newValue[key] === undefined && !(key in currentRecord)) {
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
        seen,
        currentRecord[key],
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
    const resolvedSchema = resolveSchema(link.schema);
    const schemaProperties = isRecord(resolvedSchema)
      ? resolvedSchema.properties
      : undefined;
    if (isRecord(schemaProperties)) {
      for (const key in schemaProperties) {
        if (key in newValue) continue;
        const childSchema = runtime.cfc.getSchemaAtPath(link.schema, [key]);
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
            seen,
            currentRecord[key],
          ),
        );
        eagerScopedKeys.add(key);
      }
    }

    // Handle removed keys: explicit deletes, so a key the new value omits is
    // removed rather than left behind as present-but-undefined.
    for (const key in currentRecord) {
      if (!(key in newValue) && !eagerScopedKeys.has(key)) {
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
 * Translates `id` that React likes to create to our `ID` property, making sure
 * in any given object it is never used twice.
 *
 * This mostly makes sense in a context where we ship entire JSON documents back
 * and forth and can't express graphs, i.e. two places referring to the same
 * underlying entity.
 *
 * We'll want to revisit once iframes become more sophisticated in what they can
 * express, e.g. we could have the inner shim do some of this work instead.
 */
export function addCommonIDfromObjectID(
  obj: unknown,
  fieldName: string = "id",
): void {
  function traverse(obj: unknown): void {
    if (isRecord(obj) && fieldName in obj) {
      obj[ID_FIELD] = fieldName;
    }

    // TODO(danfuzz): Latent — this is a public entry point (re-exported,
    // "entire JSON documents" from iframes) walking `obj: unknown` with no
    // `FabricSpecialObject` guard (only `isCell`/`isPrimitiveCellLink`). A
    // caller can't be proven to pass only plain JSON, so if a `FabricPrimitive`/
    // `FabricInstance` ever reaches here it is mishandled (primitive decomposed,
    // instance walked by internal slots). Mark against that.
    if (isRecord(obj) && !isCell(obj) && !isPrimitiveCellLink(obj)) {
      Object.values(obj).forEach((v) => traverse(v));
    }
  }

  traverse(obj);
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
