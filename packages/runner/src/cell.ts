import {
  type Immutable,
  isFunction,
  isObject,
  isRecord,
} from "@commonfabric/utils/types";
import {
  cloneIfNecessary,
  FabricInstance,
  FabricSpecialObject,
  type FabricValue,
  shallowFabricFromNativeValue,
  valueEqual,
} from "@commonfabric/data-model/fabric-value";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { codecOf } from "@commonfabric/data-model/codec-common";
import {
  type EntityRef,
  entityRefFromString,
  linkRefFrom,
} from "@commonfabric/data-model/cell-rep";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import {
  deepFrozenCloneAndInternSchema,
  internSchema,
  isInternedSchema,
} from "@commonfabric/data-model/schema-hash";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { SqliteParamsWire } from "@commonfabric/memory/v2";
import { isCfLinkColumn } from "@commonfabric/memory/sqlite/columns";
import { encodeCellToSigilString } from "./builtins/sqlite/cf-link-codec.ts";
import { sqliteQueryNodeFactory } from "./builtins/sqlite/query-node.ts";
import { checkSqliteWriteCeiling } from "./builtins/sqlite/write-ceiling.ts";
import { checkSqliteRowLabelWrite } from "./builtins/sqlite/row-label-write.ts";
import { recordSinkRequestPolicyInput } from "./cfc/sink-request.ts";
import { cfcLabelViewForCell } from "./cfc/label-view.ts";
import { cfcConfidentialityForObservationNode } from "./cfc/observation.ts";
import { getTopFrame } from "./builder/pattern.ts";
import { createNodeFactory, lift } from "./builder/module.ts";
import {
  type AnyCell,
  type AnyCellWrapping,
  type Apply,
  type Cell,
  type CellKind,
  type CellScope,
  type CellTypeConstructor,
  type FactoryInput,
  type Frame,
  type HKT,
  type ICell,
  ID,
  ID_FIELD,
  type IDFields,
  isStreamValue,
  type IsThisObject,
  type IStreamable,
  type JSONSchema,
  type Module,
  type NodeFactory,
  type NodeRef,
  type OpaqueCell,
  type OpaqueRef,
  type PatternFactory,
  type Schema,
  SELF,
  type Stream,
  type StripDefaultBrand,
} from "./builder/types.ts";
import { toCell } from "./back-to-cell.ts";
import { isOpaqueRefMarker } from "./builder/types.ts";
import {
  type CellResult,
  createQueryResultProxy,
  getCellOrThrow,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import { diffAndUpdate } from "./data-updating.ts";
import { type LastNode, resolveLink } from "./link-resolution.ts";
import {
  type Action,
  ignoreReadForScheduling,
  txToReactivityLog,
} from "./scheduler.ts";
import {
  internalVerifierRead,
  mergeableOpRead,
} from "./storage/reactivity-log.ts";
import { type Cancel, isCancel, useCancelGroup } from "./cancel.ts";
import {
  type CellViewRef,
  processDefaultValue,
  resolveSchema,
  schemaHasIfc,
  validateAndTransform,
} from "./schema.ts";
import {
  readStoredCfcMetadata,
  storedCfcMetadataAppliesToPath,
} from "./cfc/metadata.ts";
import { toURI } from "./uri-utils.ts";
import { createRef } from "./create-ref.ts";
import {
  type SigilLink,
  type SigilWriteRedirectLink,
  type URI,
} from "./sigil-types.ts";
import type { Runtime } from "./runtime.ts";
import {
  areLinksSame,
  createDataCellURI,
  createSigilLinkFromParsedLink,
  findAndInlineDataURILinks,
  isCellLink,
  KeepAsCell,
  type NormalizedFullLink,
  type NormalizedLink,
  parseLink,
  toMemorySpaceAddress,
} from "./link-utils.ts";
import { isCellScope, normalizeCellScope } from "./scope.ts";
import type {
  ChangeGroup,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IReadOptions,
} from "./storage/interface.ts";
import {
  createChildCellTransaction,
  createNonReactiveTransaction,
} from "./storage/extended-storage-transaction.ts";
import { fromURI } from "./uri-utils.ts";
import { ContextualFlowControl } from "./cfc.ts";
import {
  type CfcLabelView,
  cfcLabelViewForDereferenceTraces,
  cfcLabelViewSymbol,
  cloneCfcLabelView,
  getCarriedCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "./cfc/label-view-state.ts";
import { setLinkCfcLabelView } from "./cfc/link-label-view.ts";
import { listResultSchema } from "./builtins/list-result-schema.ts";
import { propagateRendererTrustedEvent } from "./cfc/ui-contract.ts";
import { getLogger } from "@commonfabric/utils/logger";
import { ensureNotRenderThread } from "@commonfabric/utils/env";
import { MetaField } from "@commonfabric/api";
ensureNotRenderThread();

const logger = getLogger("cell", { level: "warn" });

type SinkOptions = {
  changeGroup?: ChangeGroup;
  /**
   * Read the cell's display CFC label as part of the sink's tracked read set
   * and pass it to the callback as a second argument. Reading it on the sink's
   * transaction makes the cfc-metadata path a reactive dependency, so a
   * label-only write (value unchanged) re-fires the sink — the basis for
   * reactive label delivery over a subscription. Off by default.
   */
  includeCfcLabel?: boolean;
};

export type RawCellReadOptions = IReadOptions & {
  /**
   * Controls whether `getRaw()` follows a final link at the cell's target.
   *
   * Defaults to `"value"`, which preserves the historical raw-read behavior:
   * resolve links on the way to the target, but return a final link as data.
   */
  lastNode?: LastNode;
};

// Shared factory instances for all cells
let mapFactory: NodeFactory<any, any> | undefined;
let filterFactory: NodeFactory<any, any> | undefined;
let flatMapFactory: NodeFactory<any, any> | undefined;

/**
 * Error thrown by the function-form `.map`/`.filter`/`.flatMap` on an
 * OpaqueRef/Cell. These wrapped the callback in an anonymous inline pattern,
 * which has no stable content-addressed `{ identity, symbol }` and so cannot be
 * passed/persisted by identity (CT-1623). Authored pattern code is always
 * lowered by the TS transformer to the `*WithPattern(pattern(...), params)` form
 * (with the pattern hoisted to a module export); direct builder-API callers must
 * use the `*WithPattern` variant explicitly.
 */
function throwOpFunctionFormMessage(
  method: "map" | "filter" | "flatMap",
): string {
  return `OpaqueRef.${method}(fn) is no longer supported: an inline pattern has ` +
    `no stable identity. Authored \`.${method}(...)\` is lowered by the TS ` +
    `transformer to \`.${method}WithPattern(pattern(...), { params })\`; if you ` +
    `are calling the builder API directly, use \`.${method}WithPattern(op, params)\`.`;
}

// WeakMap to store connected nodes for each cell instance
const cellNodes = new WeakMap<OpaqueCell<unknown>, Set<NodeRef>>();

const recordSchemaWritePolicyInput = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  schema: JSONSchema | undefined,
): void => {
  const resolvedSchema = resolveSchema(schema) ??
    storedSchemaForWritePolicyInput(tx, link);
  if (resolvedSchema === undefined) {
    return;
  }
  const schemaAndHash = internSchema(resolvedSchema, true);
  tx.recordCfcWritePolicyInput({
    kind: "schema",
    target: {
      space: link.space,
      id: link.id,
      scope: link.scope,
      path: [...link.path],
    },
    schemaHash: schemaAndHash.taggedHashString,
    schema: schemaAndHash.schema,
  });
};

const storedSchemaForWritePolicyInput = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
): JSONSchema | undefined => {
  const metadata = readStoredCfcMetadata(tx, link);
  if (metadata === undefined) {
    return undefined;
  }
  const stored = tx.readOrThrow({
    space: link.space,
    id: `cid:${metadata.schemaHash}` as URI,
    type: "application/json",
    path: [],
  }, {
    meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
  });
  if (!isRecord(stored) || stored.value === undefined) {
    return undefined;
  }
  return new ContextualFlowControl().getSchemaAtPath(
    stored.value as JSONSchema,
    [...link.path],
  );
};

export const recordRelevantSchemaWritePolicyInput = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  schema: JSONSchema | undefined,
): void => {
  const resolvedSchema = resolveSchema(schema);
  const cfcRelevant = schemaHasIfc(resolvedSchema) ||
    storedCfcMetadataAppliesToPath(tx, link);
  if (!cfcRelevant) {
    return;
  }
  tx.markCfcRelevant(`schema-ifc-write:${link.id}`);
  recordSchemaWritePolicyInput(
    tx,
    link,
    schemaHasIfc(resolvedSchema) ? resolvedSchema : undefined,
  );
};

/**
 * Module augmentation for runtime-specific cell methods.
 * These augmentations add implementation details specific to the runner runtime.
 */

declare module "@commonfabric/api" {
  /**
   * Augment Writable to add runtime-specific write methods with onCommit callbacks
   */
  interface IWritable<T, C extends AnyBrandedCell<any>> {
    set(
      value: AnyCellWrapping<T> | T,
      onCommit?: (tx: IExtendedStorageTransaction) => void,
    ): C;
  }

  /**
   * Augment Streamable to add onCommit callback support.
   * Event is optional only when T is void (matching public API).
   */
  interface IStreamable<T> {
    send(
      ...args: T extends void ? [] | [AnyCellWrapping<T> | T] | [
          AnyCellWrapping<T> | T,
          (tx: IExtendedStorageTransaction) => void,
        ]
        : [AnyCellWrapping<T> | T] | [
          AnyCellWrapping<T> | T,
          (tx: IExtendedStorageTransaction) => void,
        ]
    ): void;
  }

  /**
   * Augment Cell to add all internal/system methods that are available
   * on Cell in the runner runtime.
   */
  interface IAnyCell<out T> {
    asSchema<S extends JSONSchema = JSONSchema>(
      schema: S,
    ): Cell<Schema<S>>;
    asSchema<T>(
      schema?: JSONSchema,
    ): Cell<T>;
    asSchemaFromLinks<T = unknown>(): Cell<T>;
    withTx(tx?: IExtendedStorageTransaction): Cell<T>;
    sink(
      callback: (
        value: Readonly<T>,
        cfcLabel?: CfcLabelView | undefined,
      ) => Cancel | undefined | void,
      options?: SinkOptions,
    ): Cancel;
    sinkMeta(
      metaField: MetaField,
      callback: (value: Immutable<FabricValue>) => Cancel | undefined | void,
      options?: SinkOptions,
    ): Cancel;
    sync(): Promise<Cell<T>>;
    pull(): Promise<Readonly<T>>;
    getAsQueryResult<Path extends PropertyKey[]>(
      path?: Readonly<Path>,
      tx?: IExtendedStorageTransaction,
      writable?: boolean,
    ): CellResult<DeepKeyLookup<T, Path>>;
    getAsNormalizedFullLink(): NormalizedFullLink;
    getAsLink(
      options?: {
        base?: Cell<any>;
        baseSpace?: MemorySpace;
        includeSchema?: boolean;
        keepAsCell?: KeepAsCell;
      },
    ): SigilLink;
    getAsWriteRedirectLink(
      options?: {
        base?: Cell<any>;
        baseSpace?: MemorySpace;
        includeSchema?: boolean;
      },
    ): SigilWriteRedirectLink;
    getRaw(options?: RawCellReadOptions): Immutable<T> | undefined;
    /**
     * Reads the cell's raw fabric value as `FabricValue`, bypassing the
     * cell's type parameter `T`. Use this when the stored data may not
     * conform to `T` (e.g., `SigilLink` references, stream markers).
     *
     * By default (or with `{ frozen: true }`), returns a deep-frozen
     * `Immutable<FabricValue>`. Pass `{ frozen: false }` to get a mutable
     * deep copy instead.
     *
     * Prefer `getRaw()` when the value is expected to match `T`.
     */
    getRawUntyped(
      options?: RawCellReadOptions & { frozen?: true },
    ): Immutable<FabricValue>;
    getRawUntyped(
      options: RawCellReadOptions & { frozen: false },
    ): FabricValue;
    getRawUntyped(options?: RawCellReadOptions): FabricValue;
    setRaw(value: (NoInfer<T> & FabricValue) | undefined): void;
    /**
     * Sets the raw cell value to any `FabricValue`, bypassing the cell's
     * type parameter `T`. Use this when writing pre-formed fabric data
     * (e.g., `SigilLink` references, stream markers) that is valid at the
     * storage layer but does not conform to the cell's schema type.
     *
     * Prefer `setRaw()` when the value matches `T`.
     *
     * When `onlyIfDifferent` is `true`, the current raw value is read first and
     * the write is skipped entirely if it deep-equals the value that would be
     * written. The read is marked `ignoreReadForScheduling`, so it does not
     * register a dependency that could re-trigger the writing computation.
     */
    setRawUntyped(value: FabricValue, onlyIfDifferent?: boolean): void;
    freeze(reason: string): void;
    isFrozen(): boolean;
    setSchema(newSchema: JSONSchema): void;
    connect(node: NodeRef): void;
    export(): {
      cell: OpaqueCell<any>;
      path: readonly PropertyKey[];
      schema?: JSONSchema;
      scope?: CellScope;
      nodes: Set<NodeRef>;
      frame: Frame;
      value?: FactoryInput<T> | T;
      name?: unknown;
      external?: unknown;
    };
    getAsOpaqueRefProxy(
      boundTarget?: (...args: unknown[]) => unknown,
    ): OpaqueRef<T>;
    toJSON(): SigilLink | null;
    runtime: Runtime;
    tx: IExtendedStorageTransaction | undefined;
    schema?: JSONSchema;
    value: T;
    cellLink: SigilLink;
    space: MemorySpace;
    entityId: EntityRef;
    sourceURI: URI;
    path: readonly PropertyKey[];
    copyTrap: boolean;

    /** Set the self-reference for SELF symbol support in patterns */
    setSelfRef(selfRef: OpaqueRef<any>): void;
  }

  interface ICreatable<C extends AnyBrandedCell<any>> {
    for(cause: unknown, allowIfSet?: boolean): C;
  }
}

export type { AnyCell, Cell, Stream } from "@commonfabric/api";

export type { MemorySpace } from "@commonfabric/memory/interface";

const cellMethods = new Set<
  | keyof ICell<unknown>
  | "findIndex"
  | "filter"
  | "filterWithPattern"
  | "flatMap"
  | "flatMapWithPattern"
  | "exec"
  | "query"
>([
  "get",
  "sample",
  "set",
  "send",
  "update",
  "push",
  "addUnique",
  "increment",
  "remove",
  "removeAll",
  "removeByValue",
  "elementById",
  "equals",
  "equalLinks",
  "key",
  "map",
  "mapWithPattern",
  "reduce",
  "findIndex",
  "filter",
  "filterWithPattern",
  "flatMap",
  "flatMapWithPattern",
  "toJSON",
  "for",
  "asSchema",
  "withTx",
  "sink",
  "sync",
  "pull",
  "getAsQueryResult",
  "getAsNormalizedFullLink",
  "getAsLink",
  "getAsWriteRedirectLink",
  "getRaw",
  "getRawUntyped",
  "setRaw",
  "setRawUntyped",
  "getArgumentCell",
  "freeze",
  "isFrozen",
  "setSchema",
  "connect",
  "export",
  "getAsOpaqueRefProxy",
  "setSelfRef",
  "exec",
  "query",
]);

/** Parse the explicit column list from `INSERT INTO t (a, b, c) VALUES ...`,
 *  used to map positional `_cf_link` params. Returns undefined when there is no
 *  explicit column list (columnless `INSERT … VALUES (…)`, `UPDATE`, opaque
 *  SQL). The capture must be immediately followed by `VALUES`, so a columnless
 *  insert's VALUES tuple is NOT mistaken for a column list. */
// The schema for one element of an array schema, suitable for a standalone
// element cell. The array's items schema is often a `$ref` into the array
// schema's `$defs`; carry those `$defs` onto the element schema so the reference
// (and any nested references) still resolve once the element is addressed on its
// own, detached from the array.
function elementSchemaFor(
  arraySchema: JSONSchema | undefined,
): JSONSchema | undefined {
  if (!isRecord(arraySchema)) return undefined;
  const items = arraySchema.items;
  if (!isRecord(items) || Array.isArray(items)) {
    return items as JSONSchema | undefined;
  }
  const defs = arraySchema.$defs;
  if (defs && !("$defs" in items)) {
    return { ...items, $defs: defs } as JSONSchema;
  }
  return items as JSONSchema;
}

function parseSqliteInsertColumns(sql: string): string[] | undefined {
  const m = sql.match(
    /\binsert\b[\s\S]*?\binto\b\s+[^()]+?\(([^)]*)\)\s*values\b/i,
  );
  if (!m) return undefined;
  return m[1].split(",").map((c) => c.trim().replace(/^["'`\[]|["'`\]]$/g, ""));
}

/**
 * Encode SQLite bind params for the wire: a cell bound to a `_cf_link` column is
 * encoded to an absolute sigil-link string; a cell bound to any other column
 * throws; an `undefined` value throws (the pending-value guard — `null` is
 * allowed for SQL NULL). Shared by `db.exec` (CellImpl) and the `sqliteQuery`
 * builtin so the encode rules and the undefined guard cannot drift.
 *
 * Positional params are validated against the statement's explicit `INSERT`
 * column list (cycled across multi-row `VALUES` tuples). When the target column
 * of a positional `?` can't be determined (columnless INSERT, UPDATE, opaque
 * SQL), a Cell binding cannot be verified to land in a `_cf_link` column, so it
 * is REJECTED with an actionable error rather than blindly sigil-encoded (which
 * would corrupt a non-link column). Use an explicit column list or named params
 * (`:col`) to bind a Cell in those statements.
 */
/**
 * Recover a Cell from a value that is a Cell or carries a `toCell` back-pointer
 * (delegating the back-pointer case to query-result-proxy's `getCellOrThrow`).
 * Shared by the write path (`encodeSqliteParams`) and `cf-link.ts`'s
 * `encodeCfLinkValue` so `db.exec` and the `sqliteQuery` builtin agree on what
 * counts as a bound cell. (Lives here because it needs `isCell` /
 * `instanceof CellImpl`; cf-link.ts already imports from cell.ts.)
 */
export function asBoundCell(value: unknown): Cell<unknown> | undefined {
  if (isCell(value)) return value as Cell<unknown>;
  if (isCellResultForDereferencing(value)) return getCellOrThrow(value);
  return undefined;
}

export function encodeSqliteParams(
  sql: string,
  params?: ReadonlyArray<unknown> | Record<string, unknown>,
): SqliteParamsWire | undefined {
  if (params === undefined) return undefined;
  const assertDefined = (value: unknown): void => {
    if (value === undefined) {
      throw new TypeError(
        "sqlite: param is undefined (it may be a value that isn't ready yet); " +
          "pass a resolved value, or null for SQL NULL",
      );
    }
  };
  const encodeOne = (value: unknown, isLinkCol: boolean): unknown => {
    assertDefined(value);
    const cell = asBoundCell(value);
    if (cell) {
      if (!isLinkCol) {
        throw new TypeError("cells may only be bound to _cf_link columns");
      }
      return encodeCellToSigilString(cell);
    }
    return value;
  };
  if (Array.isArray(params)) {
    const cols = parseSqliteInsertColumns(sql);
    return params.map((v, i) => {
      if (cols) {
        // Cycle the column list across multi-row `VALUES (?),(?)` tuples.
        return encodeOne(v, isCfLinkColumn(cols[i % cols.length] ?? ""));
      }
      assertDefined(v);
      if (asBoundCell(v)) {
        throw new TypeError(
          "sqlite: a Cell parameter must bind to a _cf_link column, but the " +
            "target column can't be determined from this statement. Use an " +
            "explicit column list (INSERT INTO t (col) VALUES (?)) or named " +
            "params (:col) so the binding can be verified.",
        );
      }
      return v;
    }) as SqliteParamsWire;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = encodeOne(v, isCfLinkColumn(k));
  }
  return out as SqliteParamsWire;
}

export function createCell<T>(
  runtime: Runtime,
  link?: NormalizedLink,
  tx?: IExtendedStorageTransaction,
  synced = false,
  kind?: CellKind,
  cfcLabelView?: CfcLabelView,
): Cell<T> {
  return new CellImpl(
    runtime,
    tx,
    link, // Pass the link directly (or undefined)
    synced,
    undefined, // No shared causeContainer
    kind,
    cfcLabelView,
  ) as unknown as Cell<T>; // Cast to set brand
}

/**
 * Shared container for entity ID and cause information across sibling cells.
 * When cells are created via .asSchema(), .withTx(), they share the same
 * logical identity (same entity id) but may have different paths or schemas.
 * The container stores only the entity reference parts that need to be synchronized.
 */
interface CauseContainer {
  // Root cell that created this cause container
  cell: OpaqueCell<unknown>;
  // Entity reference - shared across all siblings
  id: URI | undefined;
  space: MemorySpace | undefined;
  // Cause for creating the entity ID
  cause: unknown | undefined;
}

/**
 * CellImpl - Unified cell implementation that handles both regular cells and
 * streams.
 */
export class CellImpl<T extends FabricValue>
  implements ICell<T>, IStreamable<T> {
  private readOnlyReason: string | undefined;

  // Stream-specific fields
  private listeners = new Set<
    (event: AnyCellWrapping<T>) => Cancel | undefined
  >();
  private cleanup: Cancel | undefined;

  // Each cell has its own link (space, path, schema)
  private _link: NormalizedLink;

  // Shared container for entity ID and cause - siblings share the same instance
  private _causeContainer: CauseContainer;

  private _frame: Frame | undefined;

  private _kind: CellKind;

  // Self-reference for pattern SELF symbol support
  private _selfRef?: OpaqueRef<any>;
  private viewRefHashCache?: {
    link: NormalizedFullLink;
    cfcLabelView: CfcLabelView | undefined;
    hash: string;
  };

  constructor(
    public readonly runtime: Runtime,
    public readonly tx: IExtendedStorageTransaction | undefined,
    link?: NormalizedLink,
    private synced: boolean = false,
    causeContainer?: CauseContainer,
    kind?: CellKind,
    private _cfcLabelView?: CfcLabelView,
  ) {
    this._frame = getTopFrame();

    // Store this cell's own link
    this._link = {
      ...(link ?? { path: [] }),
      scope: isCellScope(link?.scope) ? link.scope : normalizeCellScope(
        undefined,
      ),
    };

    // Use provided container or create one
    // If link has an id, extract it to the container
    this._causeContainer = causeContainer ?? {
      cell: this as unknown as OpaqueCell<unknown>,
      id: this._link.id,
      space: this._link.space,
      cause: undefined,
    };

    this._kind = kind ?? "cell";
    this._cfcLabelView = cloneCfcLabelView(_cfcLabelView);
  }

  [cfcLabelViewSymbol](): CfcLabelView | undefined {
    return cloneCfcLabelView(this._cfcLabelView);
  }

  /**
   * Get the full link for this cell, ensuring it has id and space.
   * This will attempt to create a full link if one doesn't exist and we're in a valid context.
   */
  private get link(): NormalizedFullLink {
    // Check if we have a full entity ID and space
    if (!this.hasFullLink()) {
      // Try to ensure we have a full link
      this.ensureLink();

      // If still no full link after ensureLink, throw
      if (!this.hasFullLink()) {
        throw new Error(
          "Cell link creation failed - no cause or context\n" +
            "help: use .for(uniqueId) to set explicit identity, or create cells within handler/pattern contexts",
        );
      }
    }

    // Combine causeContainer id with link's space/path/schema
    return this._link as NormalizedFullLink;
  }

  private get viewRef(): CellViewRef {
    return {
      link: this.link,
      cfcLabelView: this._cfcLabelView,
    };
  }

  private viewRefHash(): string {
    const link = this.link;
    const cfcLabelView = this._cfcLabelView;
    const cached = this.viewRefHashCache;
    if (cached?.link === link && cached.cfcLabelView === cfcLabelView) {
      return cached.hash;
    }
    const hash = hashStringOf({ link, cfcLabelView } satisfies CellViewRef);
    this.viewRefHashCache = { link, cfcLabelView, hash };
    return hash;
  }

  /**
   * Check if this cell has a full link (with id and space)
   */
  private hasFullLink(): boolean {
    return this._link.id !== undefined && this._link.space !== undefined;
  }

  /**
   * Set a cause for this cell. This is used to create a link when the cell doesn't have one yet.
   * This affects all sibling cells (created via .key(), .asSchema(), .withTx()) since they
   * share the same container.
   * @param cause - The cause to associate with this cell
   * @param allowIfSet - If true, treat as suggestion and silently ignore if cause already set. If false (default), throw error if cause already set.
   * @returns This cell for method chaining
   */
  for(cause: unknown, allowIfSet?: boolean): Cell<T> {
    // If cause or id already exists, either fail or silently ignore based on allowIfSet
    if (this._causeContainer.id || this._causeContainer.cause) {
      if (allowIfSet) {
        // Treat as suggestion - silently ignore
        return this as unknown as Cell<T>;
      } else {
        // Fail by default
        throw new Error(
          "Cannot set cause: cell already has a cause or link.",
        );
      }
    }

    // Store the cause in the shared container - all siblings will see this
    this._causeContainer.cause = cause;

    return this as unknown as Cell<T>;
  }

  /**
   * Pins this (not-yet-linked) cell to a space before its id exists, and routes
   * any pattern nodes attached to it into that target space. Used by the pattern
   * builder to implement `PatternFactory.inSpace(...)`. Throws if the cell has
   * already been linked.
   */
  setUnlinkedSpace(space: MemorySpace): void {
    if (this._causeContainer.id || this._link.id) {
      throw new Error(
        "Cannot set space: cell already has a link.",
      );
    }
    this._causeContainer.space = space;
    this._link = { ...this._link, space };
    for (const node of cellNodes.get(this._causeContainer.cell) ?? []) {
      (node.module as Module).targetSpace = space;
    }
  }

  /**
   * Force creation of a full link for this cell from the stored cause.
   * This method populates id if it doesn't exist, using information from:
   * - The stored cause (from .for())
   * - The current handler context
   * - Derived information from the graph (for deriving nodes)
   *
   * Updates the shared causeContainer, so all siblings will see the new id.
   *
   * @throws Error if not in a handler context and no cause was provided
   */
  private ensureLink(): void {
    // If we already have a full link (id and space) in the container, just copy
    // it over to our link.
    if (this._causeContainer.id && this._causeContainer.space) {
      this._link = {
        ...this._link,
        id: this._causeContainer.id,
        space: this._causeContainer.space,
      };
      return;
    }

    // Otherwise, let's attempt to derive the id:

    // We must be in a frame context to derive the id.
    if (!this._frame) {
      throw new Error(
        "Cannot create cell link - no frame context\n" +
          "help: create cells inside pattern/handler/lift, or use .for(cause) for explicit identity",
      );
    }

    const space = this._link.space ?? this._causeContainer.space ??
      this._frame?.space;

    // We need a space to create a link
    if (!space) {
      throw new Error(
        "Cannot create cell link - space required\n" +
          "help: use computed() to handle closures automatically, or pass cells as explicit parameters",
      );
    }

    // Used passed in cause (via .for()), for events fall back to per-frame
    // counter.
    const cause = this._causeContainer.cause ??
      (this._frame.inHandler
        ? { count: this._frame.generatedIdCounter++ }
        : undefined);

    if (!cause) {
      throw new Error(
        "Cannot create cell link - not in handler context and no cause provided\n" +
          "help: use .for(cause) for explicit identity, or create cells within handlers where identity is automatic",
      );
    }

    // Create an entity ID from the cause, including the frame's
    const id = toURI(createRef({ frame: cause }, this._frame.cause));

    // Populate the id in the shared causeContainer
    // All siblings will see this update
    this._causeContainer.id = id;
    this._causeContainer.space = space;

    // Update this cell's link
    this._link = { ...this._link, id, space };
  }

  get space(): MemorySpace {
    return this._link.space ?? this._causeContainer.space ??
      this._frame?.space!;
  }

  get path(): readonly PropertyKey[] {
    return this._link.path;
  }

  get schema(): JSONSchema | undefined {
    if (this._link.schema !== undefined) return this._link.schema;

    // If no schema is defined, resolve link and get schema from there (which is
    // what .get() would do).
    if (this.hasFullLink()) {
      const resolvedLink = resolveLink(
        this.runtime,
        this.runtime.readTx(this.tx),
        this.link,
        "writeRedirect",
      );
      return resolvedLink.schema;
    }

    return undefined;
  }

  /**
   * Check if this cell contains a stream value
   */
  private isStream(resolvedToValueLink?: NormalizedFullLink): boolean {
    if (this._kind === "stream") return true;

    const tx = this.runtime.readTx(this.tx);

    if (!resolvedToValueLink) {
      resolvedToValueLink = resolveLink(this.runtime, tx, this.link);
    }

    if (
      ContextualFlowControl.getAsCellValues(resolvedToValueLink.schema).at(
        0,
      ) ===
        "stream"
    ) {
      return true;
    }

    const value = tx.readValueOrThrow(resolvedToValueLink, {
      meta: ignoreReadForScheduling,
    });
    return isStreamValue(value);
  }

  get(options?: { traverseCells?: boolean }): Readonly<StripDefaultBrand<T>> {
    if (!this.synced) this.sync(); // No await, just kicking this off

    // Per-transaction read cache: within one ready transaction, repeatedly
    // reading the same cell with no intervening write recomputes an identical
    // result -- same value, the same reactive reads already registered on the
    // tx, and the same CFC state. Reuse the prior result when the tx supports
    // caching (the non-reactive sample() wrapper does not) and is still open.
    // The tx clears this cache on any write, so a hit only happens when nothing
    // has changed since the last read. Key by the stable value of the view ref
    // (link + CFC label view), not link object identity, so equivalent CellImpl
    // wrappers in the same tx can share the cached traversal result. `variant`
    // separates reads that differ in options or synced state.
    const tx = this.tx;
    const cacheable = tx !== undefined &&
      tx.getCachedReadResult !== undefined &&
      tx.status().status === "ready" &&
      // Once CFC is prepared, the real read path's `read-after-prepare`
      // invalidation is load-bearing: bypass the cache so a post-prepare read
      // still goes through readOrThrow() and invalidates the prepared digest.
      tx.getCfcState().prepare.status !== "prepared";
    const variant = `${options?.traverseCells ?? false}|${this.synced}`;
    const cacheKey = cacheable ? this.viewRefHash() : undefined;
    if (cacheable) {
      const cached = tx.getCachedReadResult!(cacheKey!, variant);
      if (cached !== undefined) {
        return cached.value as Readonly<StripDefaultBrand<T>>;
      }
    }

    logger.timeStart("cell", "get");
    const value = validateAndTransform(
      this.runtime,
      this.tx,
      this.viewRef,
      [],
      { ...options, synced: this.synced },
    );
    const elapsed = logger.timeEnd("cell", "get")!;
    if (elapsed > 50) {
      logger.warn(
        `get >${Math.floor(elapsed - (elapsed % 10))}ms`,
        `get() took ${Math.floor(elapsed)}ms`,
        this.link,
      );
    }
    if (cacheable) {
      // Re-read this._link: validateAndTransform (via viewRef -> link) may have
      // run ensureLink() and replaced it with the completed link object, which
      // is the identity subsequent get()s will hash.
      tx.setCachedReadResult!(this.viewRefHash(), variant, value);
    }
    return value;
  }

  /**
   * Read the cell's current value without creating a reactive dependency.
   * Unlike `get()`, calling `sample()` inside a handler won't cause the handler
   * to re-run when this cell's value changes.
   *
   * Use this when you need to read a value but don't want changes to that value
   * to trigger re-execution of the current reactive context.
   */
  sample(): Readonly<StripDefaultBrand<T>> {
    if (!this.synced) this.sync(); // No await, just kicking this off

    // Wrap the transaction to make all reads non-reactive. Child cells created
    // during validateAndTransform will use the original transaction (via
    // getTransactionForChildCells).
    const readTx = this.runtime.readTx(this.tx);
    const nonReactiveTx = createNonReactiveTransaction(readTx);

    return validateAndTransform(this.runtime, nonReactiveTx, this.viewRef);
  }

  /**
   * Pull the cell's value, ensuring all dependencies are computed first.
   *
   * In pull-based scheduling mode, computations don't run automatically when
   * their inputs change - they only run when pulled by an effect. This method
   * registers a temporary effect that reads the cell's value, triggering the
   * scheduler to compute all transitive dependencies first.
   *
   * In push-based mode (the default), this is equivalent to `await idle()`
   * followed by `get()`, but ensures consistent behavior across both modes.
   *
   * Use this in tests or when you need to ensure a computed value is up-to-date
   * before reading it:
   *
   * ```ts
   * // Instead of:
   * await runtime.scheduler.idle();
   * const value = cell.get();
   *
   * // Use:
   * const value = await cell.pull();
   * ```
   *
   * @returns A promise that resolves to the cell's current value after all
   *          dependencies have been computed.
   */
  pull(): Promise<Readonly<T>> {
    if (!this.synced) this.sync(); // No await, just kicking this off

    // Check if we need to traverse the result to register all dependencies.
    // This is needed when there's no schema or when the schema is TrueSchema ("any"),
    // because without schema constraints we need to read all nested values.
    const schema = this._link.schema;
    const needsTraversal = schema === undefined ||
      ContextualFlowControl.isTrueSchema(schema);

    return new Promise((resolve) => {
      let result: Readonly<T>;

      const action: Action = (tx) => {
        // Read the value inside the effect - this ensures dependencies are pulled
        result = validateAndTransform(this.runtime, tx, this.viewRef);

        // If no schema or TrueSchema, traverse the result to register all
        // nested values as read dependencies.
        if (needsTraversal && result !== undefined && result !== null) {
          deepTraverse(result);
        }
      };
      // Name the action for debugging
      Object.defineProperty(action, "name", {
        value: `pull:${this.sourceURI}`,
        configurable: true,
      });
      // Also set .src as backup (name can be finicky)
      (action as Action & { src?: string }).src = `pull:${this.sourceURI}`;

      // Subscribe as an effect so it runs in the next cycle.
      const cancel = this.runtime.scheduler.subscribe(action, action, {
        isEffect: true,
        noDebounce: true,
      });

      // Wait for the scheduler to process all pending work, then resolve.
      // If the read kicked async loads of cross-space link targets, await
      // them and re-idle — each arrival re-runs the read and can reveal the
      // next hop — bounded. Pulls that kicked nothing take the
      // zero-iteration path and keep their previous timing.
      this.runtime.scheduler.idle().then(async () => {
        const storage = this.runtime.storageManager;
        // The pending pool is manager-global (same semantics as `synced()`):
        // this pull may also wait on loads kicked by concurrent readers.
        let round = 0;
        for (; round < 10; round++) {
          if ((storage.pendingCrossSpacePromiseCount?.() ?? 0) === 0) break;
          await (storage.crossSpaceSettled?.() ?? Promise.resolve());
          await this.runtime.scheduler.idle();
        }
        if (
          round === 10 && (storage.pendingCrossSpacePromiseCount?.() ?? 0) > 0
        ) {
          logger.warn("pull", () => [
            "pull() convergence bound exhausted with cross-space loads still",
            `pending: ${this.sourceURI}`,
          ]);
        }
        cancel?.();
        resolve(result);
      });
    });
  }

  /**
   * SqliteDb write (`db.exec`): records a SQLite write op onto THIS cell's
   * transaction so it commits ATOMICALLY with surrounding cell writes (one
   * commit = cell ops + a `sqlite` op). On SQL failure the whole commit aborts.
   * Only valid on a `"sqlite"`-kind cell and inside a transaction (e.g. a
   * handler). Throws on an `undefined` param (it may be a value that isn't ready
   * yet — pass a resolved value, or `null` for SQL NULL). See
   * docs/specs/sqlite-builtin/plans/sqlitedb-cell-type-exploration.md.
   */
  exec(
    sql: string,
    params?: ReadonlyArray<unknown> | Record<string, unknown>,
  ): void {
    if (!this.tx) {
      throw new Error(
        ".exec() must be called within a transaction (e.g. inside a handler)",
      );
    }
    if (!this.tx.recordSqliteWrite) {
      throw new Error("storage transaction does not support sqlite writes");
    }
    // `"sqlite"` is a type-level kind (the public `SqliteDb` type restricts who
    // can call `.exec`); at runtime we validate the actual handle value rather
    // than `_kind`, since handler-input materialization doesn't always stamp the
    // kind onto the delivered cell. Read the handle with `getRaw()` (NOT `get()`):
    // the delivered cell's schema is the `SqliteDatabase` shape (no declared
    // properties), so `get()` would shape the handle down to `{}` and drop the
    // `id`/`tables` fields. Use `lastNode: "value"` so the FINAL link is still
    // resolved (a handler-delivered handle may sit behind a link at its target) —
    // getRaw's default `"top"` would stop at the link object and miss `id`.
    const handle = this.getRaw({ lastNode: "value" }) as
      | { id?: unknown; tables?: unknown; scope?: unknown }
      | undefined;
    if (!handle || typeof handle.id !== "string") {
      throw new TypeError(
        ".exec() is only available on a SqliteDb cell (invalid database handle)",
      );
    }
    // Materialize `tables` through a RESOLVING read: a rowLabel rule's term
    // lists (arrays of objects) split into per-element entity docs when the
    // handle value is stored, so `getRaw` sees doc LINKS where the rule's AST
    // nodes should be. The permissive schema bypasses the SqliteDb shape (no
    // declared properties) that would shape `get()` down to `{}`.
    const materialized = this.asSchema(
      { type: "object", additionalProperties: true } as JSONSchema,
    ).withTx(this.tx).get() as { tables?: unknown } | undefined;
    const tables = materialized?.tables !== undefined
      ? cloneIfNecessary(
        materialized.tables as Parameters<typeof cloneIfNecessary>[0],
        { frozen: false },
      ) as Record<string, unknown>
      : handle.tables as Record<string, unknown> | undefined;
    // CFC write-ceiling (Phase 2): a value bound to a labeled column must fit the
    // column's `ifc.maxConfidentiality`. The label rides the bound value (a Cell
    // or any carried-label value); fail closed when a labeled value's target
    // column can't be determined. No-op until a column declares `ifc`.
    const confidentialityOf = (value: unknown): readonly unknown[] => {
      const view = cfcLabelViewForCell(value);
      return view
        ? cfcConfidentialityForObservationNode({ labelView: view })
        : [];
    };
    const ceilingViolation = checkSqliteWriteCeiling(
      sql,
      params,
      tables as Parameters<typeof checkSqliteWriteCeiling>[2],
      confidentialityOf,
    );
    if (ceilingViolation) throw new TypeError(ceilingViolation);

    // CFC per-row rule gate (Phase 3): an attributable INSERT into a
    // rule-bearing table computes the prospective row label from its bound
    // values; labeled inputs must be captured by it (no-laundering), and the
    // computed per-row labels are recorded as this write's CFC policy input
    // (sink-request) before the commit. Unattributable shapes fail closed.
    // No-op (zero cost) until a table declares a rule.
    const rowGate = checkSqliteRowLabelWrite({
      sql,
      params,
      tables,
      owner: typeof (handle as { owner?: unknown }).owner === "string"
        ? (handle as { owner: string }).owner
        : undefined,
      confidentialityOf,
    });
    if ("error" in rowGate) throw new TypeError(rowGate.error);
    if (rowGate.policies !== undefined && rowGate.policies.length > 0) {
      this.tx.markCfcRelevant(`sqlite-row-label:${handle.id}`);
      recordSinkRequestPolicyInput(
        this.tx,
        `sqlite:${handle.id}`,
        `sqlite-exec:${handle.id}:${sql}:${
          JSON.stringify(encodeSqliteParams(sql, params) ?? null)
        }`,
        {
          table: rowGate.policies[0].table,
          rows: rowGate.policies.map((p) => p.label),
        } as Parameters<typeof recordSinkRequestPolicyInput>[3],
      );
    }

    this.tx.recordSqliteWrite(this.space, {
      op: "sqlite",
      db: {
        id: handle.id,
        // Materialized (link-free) — the server's write path must see the
        // same plain schema JSON the read path's provenance gate keys off.
        tables,
        // Carry the db's declared scope so the write lands in the same per-user
        // / per-session on-disk file the read path resolves (stamped by
        // sqliteDatabase onto the handle value).
        scope: isCellScope(handle.scope) ? handle.scope : undefined,
      },
      sql,
      params: encodeSqliteParams(sql, params),
    });
    // Bump a write counter on the DB handle cell in THIS SAME commit. Two
    // effects, both intended:
    //  - `reactOn: db` queries re-run after a write (the handle value changed).
    //  - it serializes concurrent writers: each does a read-modify-write of
    //    `rev`, so two in-flight `db.exec` commits conflict on this cell's
    //    revision (optimistic-concurrency mutex) and one retries.
    const rev = ((handle as { rev?: unknown }).rev as number | undefined) ?? 0;
    this.withTx(this.tx).set(
      { ...(handle as Record<string, unknown>), rev: rev + 1 } as unknown as T,
    );
  }

  set(
    newValue: AnyCellWrapping<T> | T,
    /**
     * Internal-only commit callback. This runs after this transaction's final
     * commit result, including failure, so it must remain non-effectful. Use
     * the post-commit outbox for external side effects that must happen only
     * after success.
     */
    onCommit?: (tx: IExtendedStorageTransaction) => void,
  ): Cell<T> {
    const resolvedToValueLink = resolveLink(
      this.runtime,
      this.runtime.readTx(this.tx),
      this.link,
    );

    // Check if we're dealing with a stream
    if (this.isStream(resolvedToValueLink)) {
      // Stream behavior
      const event = convertCellsToLinks(newValue) as AnyCellWrapping<T>;
      propagateRendererTrustedEvent(newValue, event);

      // Trigger on fully resolved link
      this.runtime.scheduler.queueEvent(
        resolvedToValueLink,
        event,
        undefined,
        onCommit,
        false,
        { originTx: this.tx ?? undefined },
      );

      this.cleanup?.();
      const [cancel, addCancel] = useCancelGroup();
      this.cleanup = cancel;

      this.listeners.forEach((callback) => addCancel(callback(event)));
    } else {
      // Regular cell behavior
      if (!this.tx) {
        throw new Error(
          "Transaction required for .set() - mutations only work in handlers\n" +
            "help: use handler() to create transaction context, or computed() for read-only transformations",
        );
      }

      // No await for the sync, just kicking this off, so we have the data to
      // retry on conflict.
      if (!this.synced) this.sync();

      // Looks for arrays and makes sure each object gets its own doc.
      const transformedValue = recursivelyAddIDIfNeeded(newValue, this._frame);
      recordRelevantSchemaWritePolicyInput(
        this.tx,
        resolvedToValueLink,
        resolvedToValueLink.schema ?? this.schema,
      );

      // TODO(@ubik2) investigate whether i need to check confidential as i walk down my own obj
      diffAndUpdate(
        this.runtime,
        this.tx,
        resolveLink(this.runtime, this.tx, this.link, "writeRedirect"),
        transformedValue,
        this._frame?.cause,
      );

      // Register commit callback if provided.
      if (onCommit) {
        this.tx.addCommitCallback((committedTx) => {
          try {
            onCommit(committedTx);
          } catch (error) {
            console.error("Error in cell onCommit callback:", error);
          }
        });
      }
    }

    return this as unknown as Cell<T>;
  }

  send(
    ...args: T extends void ? [] | [AnyCellWrapping<T>] | [
        AnyCellWrapping<T>,
        /**
         * Internal-only commit callback. This runs after the final commit
         * result, including failure, so it must remain non-effectful. Use the
         * post-commit outbox for external side effects that must happen only
         * after success.
         */
        (tx: IExtendedStorageTransaction) => void,
      ]
      : [AnyCellWrapping<T>] | [
        AnyCellWrapping<T>,
        /**
         * Internal-only commit callback. This runs after the final commit
         * result, including failure, so it must remain non-effectful. Use the
         * post-commit outbox for external side effects that must happen only
         * after success.
         */
        (tx: IExtendedStorageTransaction) => void,
      ]
  ): void {
    const [event, onCommit] = args;
    this.set(event as AnyCellWrapping<T>, onCommit);
  }

  update<V extends (Partial<T> | AnyCellWrapping<Partial<T>>)>(
    values: V extends object ? AnyCellWrapping<V> : never,
  ): Cell<T> {
    if (!this.tx) {
      throw new Error(
        "Cell.update() requires transaction and object value\n" +
          "help: use in handlers for partial updates, or .set() for non-object values",
      );
    }
    if (!isRecord(values)) {
      throw new Error(
        "Cell.update() requires transaction and object value\n" +
          "help: use in handlers for partial updates, or .set() for non-object values",
      );
    }

    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.synced) this.sync();

    // Get current value, following aliases and references
    const resolvedLink = resolveLink(this.runtime, this.tx, this.link);
    recordRelevantSchemaWritePolicyInput(
      this.tx,
      resolvedLink,
      resolvedLink.schema ?? this.schema,
    );
    const currentValue = this.tx.readValueOrThrow(resolvedLink);

    // If there's no current value, initialize based on schema, even if there is
    // no default value.
    if (currentValue === undefined) {
      const resolvedSchema = resolveSchema(this.schema);

      // TODO(seefeld,ubik2): This should all be moved to schema helpers. This
      // just wants to know whether the value could be an object.
      const allowsObject = resolvedSchema === undefined ||
        ContextualFlowControl.isTrueSchema(resolvedSchema) ||
        (isRecord(resolvedSchema) &&
          (resolvedSchema.type === "object" ||
            (Array.isArray(resolvedSchema.type) &&
              resolvedSchema.type.includes("object")) ||
            (resolvedSchema.anyOf &&
              resolvedSchema.anyOf.some((s) =>
                typeof s === "object" && s.type === "object"
              ))));

      if (!allowsObject) {
        throw new Error(
          "Cannot update with object value - schema does not allow objects",
        );
      }

      // This initialization write only occurs after the read above proved the
      // value is absent, so no-op attempted-target coverage is not relevant.
      this.tx.writeValueOrThrow(resolvedLink, {});
    }

    // Now update each property
    for (const [key, value] of Object.entries(values)) {
      (this as unknown as Cell<any>).key(key).set(value);
    }

    return this as unknown as Cell<T>;
  }

  push(
    ...value: T extends (infer U)[] ? (U | AnyCellWrapping<U>)[] : never
  ): void {
    if (!this.tx) {
      throw new Error(
        "Cell.push() requires transaction and array value\n" +
          "help: use in handlers only, ensure cell is typed as array",
      );
    }

    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.synced) this.sync();

    // Follow aliases and references, since we want to get to an assumed
    // existing array.
    const resolvedLink = resolveLink(this.runtime, this.tx, this.link);
    recordRelevantSchemaWritePolicyInput(
      this.tx,
      resolvedLink,
      resolvedLink.schema ?? this.schema,
    );
    // Read marked as the op's own incidental read: dropped from the commit's
    // conflict set so the append merges, while a handler's explicit read is not.
    const currentValue = this.tx.readValueOrThrow(resolvedLink, {
      meta: mergeableOpRead,
    });
    const cause = this._frame?.cause;

    let array = currentValue as unknown[];
    if (array !== undefined && !Array.isArray(array)) {
      throw new Error(
        "Cell.push() requires transaction and array value\n" +
          "help: use in handlers only, ensure cell is typed as array",
      );
    }

    // If there is no array yet, create it first. We have to do this as a
    // separate operation, so that in the next steps [ID] is properly anchored
    // in the array.
    if (array === undefined) {
      diffAndUpdate(
        this.runtime,
        this.tx,
        resolvedLink,
        [],
        cause,
      );
      const resolvedSchema = resolveSchema(this.schema);
      array = isRecord(resolvedSchema) && Array.isArray(resolvedSchema.default)
        ? processDefaultValue(
          this.runtime,
          this.tx,
          this.link,
          resolvedSchema.default,
        )
        : [];
    }

    // Append the new values to the array, preserving sparse holes in the original.
    const combined = new Array(array.length + value.length);
    array.forEach((v, i) => {
      combined[i] = v;
    });
    for (let i = 0; i < value.length; i++) {
      combined[array.length + i] = value[i];
    }
    diffAndUpdate(
      this.runtime,
      this.tx,
      resolvedLink,
      recursivelyAddIDIfNeeded(combined, this._frame),
      cause,
    );

    // Record the append intent so the commit emits a tail-relative, mergeable
    // operation instead of a position diffed against a possibly-stale base.
    this.tx.recordArrayAppend?.(resolvedLink, value.length);
  }

  addUnique(
    ...value: T extends (infer U)[] ? (U | AnyCellWrapping<U>)[] : never
  ): void {
    if (!this.tx) {
      throw new Error(
        "Cell.addUnique() requires transaction and array value\n" +
          "help: use in handlers only, ensure cell is typed as array",
      );
    }
    if (!this.synced) this.sync();

    const resolvedLink = resolveLink(this.runtime, this.tx, this.link);
    recordRelevantSchemaWritePolicyInput(
      this.tx,
      resolvedLink,
      resolvedLink.schema ?? this.schema,
    );
    const currentValue = this.tx.readValueOrThrow(resolvedLink, {
      meta: mergeableOpRead,
    });
    const cause = this._frame?.cause;

    let array = currentValue as unknown[];
    if (array !== undefined && !Array.isArray(array)) {
      throw new Error(
        "Cell.addUnique() requires transaction and array value\n" +
          "help: use in handlers only, ensure cell is typed as array",
      );
    }
    if (array === undefined) {
      diffAndUpdate(this.runtime, this.tx, resolvedLink, [], cause);
      const resolvedSchema = resolveSchema(this.schema);
      array = isRecord(resolvedSchema) && Array.isArray(resolvedSchema.default)
        ? processDefaultValue(
          this.runtime,
          this.tx,
          this.link,
          resolvedSchema.default,
        )
        : [];
    }

    // Anchor ids on the new values, then keep only those not already present
    // (by stored-value equality, matching the server's add-unique dedup). The
    // server re-dedups against durable state, catching elements the local
    // replica had not loaded.
    const anchored = recursivelyAddIDIfNeeded(
      value as unknown[],
      this._frame,
    ) as unknown[];
    const existing = array;
    // A cell candidate matches an existing element by its (deterministic) link,
    // so re-adding the same keyed entity is a local no-op; a plain value matches
    // by stored-value equality, mirroring the server's keyless dedup.
    const alreadyPresent = (candidate: unknown) =>
      existing.some((element) =>
        isCell(candidate)
          ? areLinksSame(
            element,
            candidate,
            this as unknown as Cell<any>,
            true,
            this.tx!,
            this.runtime,
          )
          : deepEqual(element, candidate)
      );
    const toAdd = anchored.filter((candidate) => !alreadyPresent(candidate));
    if (toAdd.length === 0) {
      return;
    }
    diffAndUpdate(
      this.runtime,
      this.tx,
      resolvedLink,
      [...existing, ...toAdd],
      cause,
    );
    this.tx.recordAddUnique?.(resolvedLink, toAdd.length);
  }

  increment(by: number = 1): void {
    if (!this.tx) {
      throw new Error(
        "Cell.increment() requires transaction and number value\n" +
          "help: use in handlers only, ensure cell is typed as number",
      );
    }
    if (by === 0) {
      throw new Error(
        "Cell.increment() requires a non-zero amount\n" +
          "help: a zero increment is a no-op; drop the call",
      );
    }
    if (!this.synced) this.sync();

    const resolvedLink = resolveLink(this.runtime, this.tx, this.link);
    recordRelevantSchemaWritePolicyInput(
      this.tx,
      resolvedLink,
      resolvedLink.schema ?? this.schema,
    );
    const currentValue = this.tx.readValueOrThrow(resolvedLink, {
      meta: mergeableOpRead,
    });
    if (currentValue !== undefined && typeof currentValue !== "number") {
      throw new Error(
        "Cell.increment() requires transaction and number value\n" +
          "help: use in handlers only, ensure cell is typed as number",
      );
    }
    const cause = this._frame?.cause;
    const next = (typeof currentValue === "number" ? currentValue : 0) + by;
    diffAndUpdate(this.runtime, this.tx, resolvedLink, next, cause);

    // Record the increment intent so the commit emits a mergeable increment the
    // server resolves against durable state instead of a value diffed against a
    // possibly-stale read.
    this.tx.recordIncrement?.(resolvedLink, by);
  }

  // Remove every element of this array equal to `ref` by stored value. A cell
  // ref matches by its (deterministic) link, so the membership entry is removed
  // without depending on the list's prior contents — concurrent removes of
  // distinct entries merge. The optimistic local filter and the committed op
  // both match by the stored value.
  removeByValue(
    ref: T extends (infer U)[] ? (U | AnyCell<U>) : never,
  ): void {
    if (!this.tx) {
      throw new Error(
        "Cell.removeByValue() requires transaction and array value\n" +
          "help: use in handlers only, ensure cell is typed as array",
      );
    }
    if (!this.synced) this.sync();

    const resolvedLink = resolveLink(this.runtime, this.tx, this.link);
    recordRelevantSchemaWritePolicyInput(
      this.tx,
      resolvedLink,
      resolvedLink.schema ?? this.schema,
    );
    const currentValue = this.tx.readValueOrThrow(resolvedLink, {
      meta: mergeableOpRead,
    });
    const array = currentValue as unknown[];
    if (array === undefined) {
      return;
    }
    if (!Array.isArray(array)) {
      throw new Error(
        "Cell.removeByValue() requires transaction and array value\n" +
          "help: use in handlers only, ensure cell is typed as array",
      );
    }
    // A cell ref matches an element by its (deterministic) link; a plain value
    // matches by stored-value equality. The removed elements are the array's
    // stored representations (links stay as their sigil), so recording each one
    // as the op's value lets the server match the durable element exactly.
    const matches = (element: unknown) =>
      isCell(ref)
        ? areLinksSame(
          element,
          ref,
          this as unknown as Cell<any>,
          true,
          this.tx!,
          this.runtime,
        )
        : deepEqual(element, ref);
    const removed = array.filter(matches);
    if (removed.length === 0) {
      return;
    }
    const filtered = array.filter((element) => !matches(element));
    diffAndUpdate(
      this.runtime,
      this.tx,
      resolvedLink,
      filtered,
      this._frame?.cause,
    );
    for (const element of removed) {
      this.tx.recordRemoveByValue?.(resolvedLink, element as FabricValue);
    }
  }

  // Returns a cell for the entity deterministically derived from this array and
  // `idKey` — the entity a keyed element of this array is identified by. The
  // derivation is content-only (no per-event cause), so the same `idKey` always
  // resolves to the same entity. This lets a handler read/edit one keyed element
  // (e.g. "my vote for this option") and add or remove its membership via
  // addUnique / removeByValue, without ever reading the whole array.
  elementById(idKey: string, schema?: JSONSchema): Cell<any> {
    const tx = this.runtime.readTx(this.tx);
    const resolvedLink = resolveLink(this.runtime, tx, this.link);
    const entityId = createRef(
      { id: idKey },
      {
        parent: { id: resolvedLink.id, space: resolvedLink.space },
        path: resolvedLink.path,
      },
    );
    const arraySchema = resolveSchema(resolvedLink.schema ?? this.schema);
    const elementSchema = schema ?? elementSchemaFor(arraySchema);
    return this.runtime.getCellFromEntityId(
      resolvedLink.space,
      entityId,
      [],
      elementSchema,
      this.tx,
      resolvedLink.scope,
    );
  }

  remove(
    ref: T extends (infer U)[] ? (U | AnyCell<U>) : never,
  ): void {
    type ElemT = T extends (infer U)[] ? U : never;
    const got = this.get();
    if (!Array.isArray(got)) {
      throw new Error("Can't remove from non-array value");
    }
    const array = got as ElemT[];
    const index = typeof ref === "object"
      ? array.findIndex((item) =>
        areLinksSame(
          item,
          ref,
          this as unknown as Cell<any>,
          true, // resolveBeforeComparing
          this.tx,
          this.runtime,
        )
      )
      : array.indexOf(ref as ElemT);
    if (index === -1) {
      return;
    }
    // Cast needed: TS can't prove ElemT[] reconstitutes to T
    const newArray = [
      ...array.slice(0, index),
      ...array.slice(index + 1),
    ] as unknown as T;
    this.set(newArray);
  }

  removeAll(
    ref: T extends (infer U)[] ? (U | AnyCell<U>) : never,
  ): void {
    type ElemT = T extends (infer U)[] ? U : never;
    const got = this.get();
    if (!Array.isArray(got)) {
      throw new Error("Can't remove from non-array value");
    }
    const array = got as ElemT[];
    // Cast needed: TS can't prove ElemT[] reconstitutes to T
    const newArray = array.filter((item) =>
      typeof ref === "object"
        ? !areLinksSame(
          item,
          ref,
          this as unknown as Cell<any>,
          true, // resolveBeforeComparing
          this.tx,
          this.runtime,
        )
        : item !== ref
    ) as unknown as T;
    this.set(newArray);
  }

  equals(other: any): boolean {
    return areLinksSame(
      this,
      other,
      undefined,
      true,
      this.runtime.readTx(this.tx),
      this.runtime,
    );
  }

  equalLinks(other: any): boolean {
    return areLinksSame(this, other);
  }

  /**
   * Navigate to nested properties by one or more keys.
   *
   * @example
   * cell.key("user")                      // Cell<User>
   * cell.key("user", "profile")           // Cell<Profile>
   * cell.key("user", "profile", "name")   // Cell<string>
   */
  key(...keys: PropertyKey[]): Cell<any> {
    let currentLink = this._link;
    let childSchema: JSONSchema | undefined;
    const childPath = keys.map((key) => key.toString());

    for (const key of keys) {
      // Get child schema if we have one
      childSchema = currentLink.schema
        ? this.runtime.cfc.getSchemaAtPath(currentLink.schema, [key.toString()])
        : undefined;

      // Create a child link with extended path
      // When we have a childSchema, we need to preserve the schema that contains $defs
      // for resolving $ref references. If schema wasn't set, fall back to the parent schema.
      //
      // key() only extends the path and walks the schema. It must NOT change the
      // link's scope: scope lives in the schema (top-level and asCell entries)
      // and is resolved later as a follow cap during reads and as the target
      // scope during writes. Stamping schema scope onto this link here would
      // re-address the value to the wrong scoped instance of the container doc
      // (see CT-1623).
      currentLink = {
        ...currentLink,
        path: [...currentLink.path, key.toString()] as string[],
        schema: childSchema,
      };
    }

    // Determine the kind based on schema flags
    let kind: CellKind = this._kind;
    if (isRecord(childSchema)) {
      const asCellValues = ContextualFlowControl.getAsCellValues(childSchema);
      // we can override the kind of cell we use for a key
      if (asCellValues.length > 0) {
        const asCellEntry = asCellValues[0];
        const asCellKind = ContextualFlowControl.getAsCellKind(asCellEntry);
        if (asCellKind !== undefined) {
          kind = asCellKind;
        }
      }
    }

    return new CellImpl(
      this.runtime,
      this.tx,
      currentLink,
      this.synced,
      this._causeContainer,
      kind,
      rebaseCfcLabelView(this._cfcLabelView, childPath),
    ) as unknown as Cell<any>;
  }

  asSchema<S extends JSONSchema = JSONSchema>(
    schema: S,
  ): Cell<Schema<S>>;
  asSchema<T>(
    schema?: JSONSchema,
  ): Cell<T>;
  asSchema(schema?: JSONSchema): Cell<any> {
    // asSchema creates a sibling with same identity but different schema.
    // Create a new link with the modified schema, interned so downstream
    // identity-keyed schema caches hit (see `internCellLinkSchema`).
    const siblingLink: NormalizedLink = {
      ...this._link,
      schema: internCellLinkSchema(schema),
    };

    return new CellImpl(
      this.runtime,
      this.tx,
      siblingLink,
      false, // Reset synced flag, since schema is changing
      this._causeContainer, // Share the causeContainer with siblings
      this._kind,
      this._cfcLabelView,
    ) as unknown as Cell<any>;
  }

  /**
   * Follow all links, even beyond write redirects, and adopt the schema
   * embedded in the resolved link chain, projected along the remaining path.
   *
   * The link stays the same, i.e. it does not advance to the resolved link.
   *
   * Note: That means that the schema might change if the link behind it change.
   * The reads are logged though, so should trigger reactive flows.
   *
   * @returns Cell with schema from links
   */
  asSchemaFromLinks<T = unknown>(): Cell<T> {
    if (!this.synced) this.sync(); // Auto-sync like .get() - matches framework pattern

    const { schema } = resolveLink(
      this.runtime,
      this.runtime.readTx(this.tx),
      this.link,
    );

    return new CellImpl(
      this.runtime,
      this.tx,
      {
        ...this._link,
        ...(schema !== undefined && { schema }),
      },
      false, // Reset synced flag, since schema is changing
      this._causeContainer, // Share the causeContainer with siblings
      this._kind,
      this._cfcLabelView,
    ) as unknown as Cell<T>;
  }

  withTx(newTx?: IExtendedStorageTransaction): Cell<T> {
    // withTx creates a sibling with same identity but different transaction
    // Share the causeContainer so .for() calls propagate
    return new CellImpl(
      this.runtime,
      newTx,
      this._link, // Use the same link
      this.synced,
      this._causeContainer, // Share the causeContainer with siblings
      this._kind,
      this._cfcLabelView,
    ) as unknown as Cell<T>;
  }

  sink(
    callback: (
      value: Readonly<T>,
      cfcLabel?: CfcLabelView | undefined,
    ) => Cancel | undefined | void,
    options: SinkOptions = {},
  ): Cancel {
    // Check if this is a stream
    if (this.isStream()) {
      // Stream behavior: add listener
      this.listeners.add(
        callback as (event: AnyCellWrapping<T>) => Cancel | undefined,
      );
      return () =>
        this.listeners.delete(
          callback as (event: AnyCellWrapping<T>) => Cancel | undefined,
        );
    } else {
      // Regular cell behavior: subscribe to changes
      if (!this.synced) this.sync(); // No await, just kicking this off
      return subscribeToReferencedDocs(
        callback,
        this.runtime,
        this.viewRef,
        options,
      );
    }
  }

  sync(): Promise<Cell<T>> {
    this.synced = true;
    logger.info("sync", this.link);
    return this.runtime.storageManager.syncCell<T>(this as unknown as Cell<T>);
  }

  sinkMeta(
    metaField: MetaField,
    callback: (value: Immutable<FabricValue>) => Cancel | undefined | void,
    options: SinkOptions = {},
  ): Cancel {
    if (!this.synced) this.sync();

    const sink: SinkAction = {
      cleanup: undefined,
      action: (tx) => {
        if (isCancel(sink.cleanup)) sink.cleanup();

        const value = this.withTx(tx).getMetaRaw(metaField);
        sink.cleanup = callback(value);
      },
    };

    return sinkHelper(sink, this.runtime, {
      ...this.link,
      path: [String(metaField)],
    }, options);
  }

  resolveAsCell(): Cell<T> {
    const readTx = this.runtime.readTx(this.tx);
    const tracesBefore = readTx.getCfcState().dereferenceTraces.length;
    let link: NormalizedFullLink = resolveLink(
      this.runtime,
      readTx,
      this.link,
    );
    const dereferenceView = cfcLabelViewForDereferenceTraces(
      readTx,
      readTx.getCfcState().dereferenceTraces.slice(tracesBefore),
    );
    const nonReactiveTx = createNonReactiveTransaction(readTx);
    link = maybeConvertArrayPathToDataURILink(nonReactiveTx, link);
    return createCell(
      this.runtime,
      link,
      this.tx,
      this.synced,
      undefined,
      mergeCfcLabelViews([this._cfcLabelView, dereferenceView]),
    );
  }

  getAsQueryResult<Path extends PropertyKey[]>(
    path?: Readonly<Path>,
    tx?: IExtendedStorageTransaction,
    writable?: boolean,
  ): CellResult<DeepKeyLookup<T, Path>> {
    if (!this.synced) this.sync(); // No await, just kicking this off
    const subPath = path || [];
    return createQueryResultProxy(
      this.runtime,
      tx ?? this.tx ?? this.runtime.edit(),
      {
        ...this.link,
        path: [...this.path, ...subPath.map((p) => p.toString())] as string[],
      },
      0,
      writable,
      rebaseCfcLabelView(
        this._cfcLabelView,
        subPath.map((p) => p.toString()),
      ),
    );
  }

  getAsNormalizedFullLink(): NormalizedFullLink {
    return this.link;
  }

  getAsLink(
    options?: {
      base?: Cell<any>;
      baseSpace?: MemorySpace;
      includeSchema?: boolean;
      keepAsCell?: KeepAsCell;
    },
  ): SigilLink {
    return createSigilLinkFromParsedLink(this.link, {
      ...options,
      overwrite: "this",
    });
  }

  getAsWriteRedirectLink(
    options?: {
      base?: Cell<any>;
      baseSpace?: MemorySpace;
      includeSchema?: boolean;
    },
  ): SigilWriteRedirectLink {
    return createSigilLinkFromParsedLink(this.link, {
      ...options,
      overwrite: "redirect",
    }) as SigilWriteRedirectLink;
  }

  /**
   * Read the cell's value at the fabric layer (no native unwrapping, no
   * Proxy wrapping). By default returns a deep-frozen `FabricValue`
   * snapshot; pass `{ frozen: false }` for a mutable deep copy.
   *
   * **Frozenness contract:** Defaults to `{ frozen: true }`, returning a
   * deep-frozen `FabricValue` snapshot via `cloneIfNecessary()`. The underlying
   * storage already holds a deep-frozen tree, so the clone is typically a
   * no-op. The `{ frozen: false }` variant returns a fresh mutable deep copy
   * and never aliases storage state.
   */
  getRaw(options?: RawCellReadOptions): Immutable<T> | undefined {
    return this.getRawUntyped(options) as Immutable<T> | undefined;
  }

  /**
   * Untyped variant of `getRaw()`; same frozenness contract.
   */
  getRawUntyped(
    options?: RawCellReadOptions & { frozen?: true },
  ): Immutable<FabricValue>;
  getRawUntyped(
    options: RawCellReadOptions & { frozen: false },
  ): FabricValue;
  getRawUntyped(
    options?: RawCellReadOptions & { frozen?: boolean },
  ): FabricValue {
    const { frozen = true, lastNode = "top", ...readOptions } = options ?? {};
    if (!this.synced) this.sync(); // No await, just kicking this off
    const tx = this.runtime.readTx(this.tx);
    // Resolve all links ON THE WAY to the target, but don't resolve the final
    // link.
    const value = tx.readValueOrThrow(
      resolveLink(this.runtime, tx, this.link, lastNode),
      readOptions,
    );
    // Deep-copy with desired frozenness, without native unwrapping — getRaw()
    // and getRawUntyped() return fabric-layer values, not native ("wild
    // west") values.
    return cloneIfNecessary(value, { frozen });
  }

  setRaw(value: (NoInfer<T> & FabricValue) | undefined): void {
    this.setRawUntyped(value);
  }

  setRawUntyped(value: FabricValue, onlyIfDifferent = false): void {
    if (!this.tx) throw new Error("Transaction required for setRaw");

    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.synced) this.sync();

    const inlined = findAndInlineDataURILinks(value);

    // When asked to write only on change, read the current raw value and bail
    // out if it already equals what we'd write. `readValueOrThrow` mirrors the
    // `writeValueOrThrow` below (same transaction and address, no link
    // resolution). The read is purely an internal write-elision decision, so it
    // is marked `ignoreReadForScheduling` (it must not register a
    // self-dependency that would re-trigger the writer) and
    // `internalVerifierRead` (it must not taint the transaction's CFC labels
    // with this cell's own value). Comparison uses `valueEqual`, the
    // `Fabric`-aware content equality the storage no-op gates rely on:
    // `deepEqual` walks enumerable own-props and so conflates distinct
    // same-class `FabricSpecialObject`s (e.g. `FabricBytes`/`FabricHash`),
    // which would drop a real change.
    if (onlyIfDifferent) {
      const current = this.tx.readValueOrThrow(this.link, {
        meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
      });
      if (valueEqual(current, inlined)) return;
    }

    // Raw writes bypass diff-based attempted-target capture. Same-value direct
    // writes through this internal path are therefore outside phase-1 CFC
    // attempted-target coverage unless a caller establishes it separately.
    recordRelevantSchemaWritePolicyInput(
      this.tx,
      this.link,
      this.link.schema ?? this.schema,
    );
    this.tx.writeValueOrThrow(this.link, inlined);
  }

  getArgumentCell<U>(schema?: JSONSchema): Cell<U> | undefined {
    const metaReadOptions = {
      meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
    };
    const linkObj = this.getMetaRaw("argument", metaReadOptions);
    if (linkObj === undefined) return undefined;
    const link = parseLink(linkObj, this._link);
    if (link === undefined) return undefined;
    return this.runtime.getCellFromLink(link).asSchema<U>(schema);
  }

  freeze(reason: string): void {
    this.readOnlyReason = reason;
  }

  isFrozen(): boolean {
    return !!this.readOnlyReason;
  }

  getMetaRaw(
    metaField: MetaField,
    options?: IReadOptions,
  ): FabricValue | undefined {
    if (!this.synced) this.sync(); // No await, just kicking this off
    const metaAddr = {
      space: this.link.space,
      id: this.link.id,
      path: [metaField],
      ...(this.link.scope !== undefined && { scope: this.link.scope }),
    };
    return this.runtime.readTx(this.tx).readOrThrow(metaAddr, options);
  }

  setMetaRaw(metaField: MetaField, value: FabricValue): void {
    if (!this.tx) throw new Error("Transaction required for setMetaRaw");
    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.synced) this.sync();
    const metaAddr = {
      space: this.link.space,
      id: this.link.id,
      path: [metaField],
      ...(this.link.scope !== undefined && { scope: this.link.scope }),
    };
    this.tx.writeOrThrow(metaAddr, value as FabricValue);
  }

  /**
   * Set the schema for this cell. Only works if the cause isn't set yet.
   * Prefer using .asSchema() instead.
   */
  setSchema(newSchema: JSONSchema): void {
    if (this._causeContainer.cause || this._causeContainer.id) {
      throw new Error(
        "Cannot setSchema: cell already has a cause or link. Use .asSchema() instead.",
      );
    }
    // Since we don't have a cause yet, we can modify the link's schema
    this._link = { ...this._link, schema: newSchema };
  }

  /**
   * Connect this cell to a node reference.
   * This stores the node in a set of connected nodes, which is used during pattern construction.
   * @param node - The node to connect to
   */
  connect(node: NodeRef): void {
    // For cells created during pattern construction, we need to track which nodes
    // they're connected to. Since Cell doesn't have a nodes set like OpaqueRef's store,
    // we'll store this in a WeakMap keyed by the cell instance.
    const top = this._causeContainer.cell;
    if (!cellNodes.has(top)) {
      cellNodes.set(top, new Set());
    }
    cellNodes.get(top)!.add(node);
  }

  /**
   * Export cell metadata for introspection, similar to OpaqueRef's export method.
   * If the cell has a link, it's included as 'external'.
   */
  export(): {
    cell: OpaqueCell<unknown>;
    path: readonly PropertyKey[];
    schema?: JSONSchema;
    scope?: CellScope;
    nodes: Set<NodeRef>;
    frame: Frame;
    value?: FactoryInput<T> | T;
    name?: unknown;
    external?: unknown;
  } {
    if (!this._frame) {
      throw new Error("Cannot export cell: no frame context.");
    }
    return {
      cell: this._causeContainer.cell,
      path: this.path,
      schema: this.schema,
      scope: isCellScope(this._link.scope) ? this._link.scope : undefined,
      nodes: cellNodes.get(this._causeContainer.cell) ?? new Set(),
      frame: this._frame,
      // Cast needed: stream sentinel marker isn't actually of type T
      value: this._kind === "stream"
        ? { $stream: true } as unknown as T
        : undefined,
      name: this._causeContainer.cause,
      external: this._link.id
        ? this.getAsWriteRedirectLink({
          baseSpace: this._frame.space,
          includeSchema: true,
        })
        : undefined,
    };
  }

  /**
   * Set the self-reference for pattern SELF symbol support.
   * This allows patterns to access their own output via the SELF symbol.
   */
  setSelfRef(selfRef: OpaqueRef<any>): void {
    this._selfRef = selfRef;
  }

  /**
   * Wrap this cell in a proxy that provides OpaqueRef behavior.
   * The proxy adds Symbol.iterator, Symbol.toPrimitive, and toCell support,
   * and recursively wraps child cells accessed via property access.
   *
   * @returns A proxied version of this cell with OpaqueRef behavior
   */
  getAsOpaqueRefProxy(
    boundTarget?: (...args: unknown[]) => unknown,
  ): OpaqueRef<T> {
    const self = this as unknown as Cell<T>;
    // `query`/`exec` are SqliteDb-only methods whose names are also common data
    // fields (e.g. wish's `query`). Only forward them as methods on a
    // `"sqlite"`-kind cell; otherwise treat `.query`/`.exec` as data navigation.
    const cellKind = this._kind;
    const proxy = new Proxy(boundTarget ?? this, {
      get(target, prop) {
        if (prop === Symbol.iterator) {
          // Iterator support for array destructuring
          return function* () {
            let index = 0;
            while (index < 50) { // Limit to 50 items like original
              const itemCell = self.key(index) as Cell<unknown>;
              yield itemCell.getAsOpaqueRefProxy();
              index++;
            }
          };
        } else if (prop === Symbol.toPrimitive) {
          return () => {
            throw new Error(
              "Tried to access a reactive reference outside a reactive context. Use `computed()` to perform operations on reactive values - it handles closures automatically.",
            );
          };
        } else if (prop === toCell) {
          // Return a function that returns the unproxied cell
          return () => self;
        } else if (prop === isOpaqueRefMarker) {
          return true;
        } else if (prop === SELF) {
          // Return the self-reference if set (for pattern SELF symbol support)
          return (self as unknown as CellImpl<T>)._selfRef;
        } else if (typeof prop === "string" || typeof prop === "number") {
          // Recursive property access - wrap the child cell
          const nestedCell = self.key(prop) as Cell<T>;

          // Check if this is a method on the cell. `query`/`exec` are gated to
          // SqliteDb cells so they don't shadow same-named data fields.
          const isSqliteOnlyMethod = prop === "query" || prop === "exec";
          if (
            cellMethods.has(prop as keyof ICell<T>) &&
            (!isSqliteOnlyMethod || cellKind === "sqlite")
          ) {
            return nestedCell.getAsOpaqueRefProxy(
              (self as unknown as Record<
                string,
                (...args: unknown[]) => unknown
              >)[prop]!
                .bind(self),
            );
          } else {
            return nestedCell.getAsOpaqueRefProxy();
          }
        }
        // Delegate everything else to orignal target
        return (target as any)[prop];
      },
    });
    return proxy as unknown as OpaqueRef<T>;
  }

  /**
   * Map over an array cell, creating a new derived array.
   * Similar to Array.prototype.map but works with OpaqueRefs.
   */
  /**
   * SqliteDb reactive read (`db.query<Row>`): builds a `sqliteQuery` node with
   * this DB handle as the `db` input (sugar over the `sqliteQuery` factory,
   * mirroring how `.map` threads `this` as `list`). The `<Row>` result schema is
   * injected by the transformer (method-call lowering), not set here. Like
   * `.map`, this is a build-time node constructor with no `_kind` guard: at
   * pattern-build time `this` is an opaque builder ref (the `"sqlite"` kind only
   * materializes at runtime via the asCell schema), and the public `SqliteDb`
   * type already restricts who can call it. A wrong handle fails at runtime in
   * `readDbRef`.
   */
  query<Row = Record<string, unknown>>(
    sql: string,
    options?: {
      params?: ReadonlyArray<unknown> | Record<string, unknown>;
      reactOn?: unknown;
      maxConfidentiality?: ReadonlyArray<unknown>;
      onExceed?: "fail" | "skip";
    },
  ): OpaqueRef<{ pending: boolean; result?: Row[]; error?: unknown }> {
    return sqliteQueryNodeFactory({
      db: this,
      sql,
      params: options?.params,
      reactOn: options?.reactOn,
      // CFC Phase 3 read surface: the declared output ceiling + exceed mode.
      maxConfidentiality: options?.maxConfidentiality,
      onExceed: options?.onExceed,
      // Forward the transformer-injected `<Row>` schema (lowered into the
      // options object) to the node so the builtin can decode `_cf_link`
      // columns. Read loosely — it is not part of the public options type.
      rowSchema: (options as { rowSchema?: unknown } | undefined)?.rowSchema,
    }) as OpaqueRef<{ pending: boolean; result?: Row[]; error?: unknown }>;
  }

  map<S>(
    _fn: (
      element: T extends Array<infer U> ? OpaqueRef<U> : OpaqueRef<T>,
      index: OpaqueRef<number>,
      array: OpaqueRef<T>,
    ) => FactoryInput<S>,
  ): OpaqueRef<S[]> {
    throw new Error(throwOpFunctionFormMessage("map"));
  }

  /**
   * Map over an array cell using a pattern/pattern.
   * Similar to map but accepts a pre-defined pattern instead of a function.
   */
  mapWithPattern<S>(
    this: IsThisObject,
    op: PatternFactory<T extends Array<infer U> ? U : T, S>,
    params: Record<string, any>,
  ): OpaqueRef<S[]> {
    // Create the factory if it doesn't exist
    if (!mapFactory) {
      mapFactory = createNodeFactory({
        type: "ref",
        implementation: "map",
      });
    }

    const result = mapFactory({
      list: this as unknown as OpaqueRef<T>,
      op: op,
      params: params,
    });
    result.setSchema(listResultSchema(op.resultSchema));
    return result;
  }

  /**
   * Reduce an array cell to a single accumulated value.
   * Similar to Array.prototype.reduce but reactive — re-runs the full
   * reduction when any element changes.
   */
  reduce<S>(
    this: IsThisObject,
    fn: (
      accumulator: S,
      element: T extends Array<infer U> ? U : T,
      index: number,
      array: (T extends Array<infer U> ? U : T)[],
    ) => S,
    initialValue: S,
  ): OpaqueRef<S> {
    return lift((list: any[]) => {
      if (!Array.isArray(list)) return initialValue;
      return list.reduce(fn, initialValue);
    })(this as unknown as OpaqueRef<any>);
  }

  /**
   * Find the index of the first matching element in an array cell.
   * Similar to Array.prototype.findIndex but reactive — re-runs when any
   * element changes. Returns -1 if no match is found. Throws TypeError
   * if the value is not an array, which surfaces as a scheduler error
   * and leaves the result undefined.
   */
  findIndex(
    this: IsThisObject,
    fn: (
      element: T extends Array<infer U> ? U : T,
      index: number,
      array: (T extends Array<infer U> ? U : T)[],
    ) => boolean,
  ): OpaqueRef<number> {
    // Uses lift rather than a per-element-pattern builtin (like filter/map)
    // because findIndex returns a plain number, not an element reference —
    // there's no benefit to per-element reactive tracking. The lift approach
    // short-circuits naturally and the predicate receives unwrapped values,
    // so normal JS comparisons work. Tradeoff: reruns the full search on any
    // array change. For per-element reactivity, use filter(pred)[0] instead.
    return lift((list: any[]) => {
      if (!Array.isArray(list)) {
        throw new TypeError("findIndex called on non-array value");
      }
      return list.findIndex(fn);
    })(this as unknown as OpaqueRef<any>);
  }

  /**
   * Filter an array cell, creating a new array with only matching elements.
   * Similar to Array.prototype.filter but works with OpaqueRefs.
   * Output contains cell references to the original elements.
   */
  filter(
    _fn: (
      element: T extends Array<infer U> ? OpaqueRef<U> : OpaqueRef<T>,
      index: OpaqueRef<number>,
      array: OpaqueRef<T>,
    ) => FactoryInput<boolean>,
  ): OpaqueRef<(T extends Array<infer U> ? U : T)[]> {
    throw new Error(throwOpFunctionFormMessage("filter"));
  }

  /**
   * Filter an array cell using a pre-defined pattern.
   * Similar to filter but accepts a pre-defined pattern instead of a function.
   */
  filterWithPattern<S>(
    this: IsThisObject,
    op: PatternFactory<T extends Array<infer U> ? U : T, S>,
    params: Record<string, any>,
  ): OpaqueRef<(T extends Array<infer U> ? U : T)[]> {
    if (!filterFactory) {
      filterFactory = createNodeFactory({
        type: "ref",
        implementation: "filter",
      });
    }

    const result = filterFactory({
      list: this as unknown as OpaqueRef<T>,
      op: op,
      params: params,
    });
    result.setSchema(listResultSchema());
    return result;
  }

  /**
   * FlatMap over an array cell, creating a flattened array from per-element arrays.
   * Similar to Array.prototype.flatMap but works with OpaqueRefs.
   * Each callback should return an array; results are concatenated one level deep.
   */
  flatMap<S>(
    _fn: (
      element: T extends Array<infer U> ? OpaqueRef<U> : OpaqueRef<T>,
      index: OpaqueRef<number>,
      array: OpaqueRef<T>,
    ) => FactoryInput<S[]>,
  ): OpaqueRef<S[]> {
    throw new Error(throwOpFunctionFormMessage("flatMap"));
  }

  /**
   * FlatMap over an array cell using a pre-defined pattern.
   * Similar to flatMap but accepts a pre-defined pattern instead of a function.
   */
  flatMapWithPattern<S>(
    this: IsThisObject,
    op: PatternFactory<T extends Array<infer U> ? U : T, S[]>,
    params: Record<string, any>,
  ): OpaqueRef<S[]> {
    if (!flatMapFactory) {
      flatMapFactory = createNodeFactory({
        type: "ref",
        implementation: "flatMap",
      });
    }

    const result = flatMapFactory({
      list: this as unknown as OpaqueRef<T>,
      op: op,
      params: params,
    });
    result.setSchema(listResultSchema());
    return result;
  }

  toJSON(): SigilLink | null {
    // Return null when no link exists (cell hasn't been created yet)
    if (!this.hasFullLink()) {
      return null;
    }

    // Use sigil link format which includes space for cross-space references
    return createSigilLinkFromParsedLink(this.link);
  }

  get value(): T {
    return this.get();
  }

  get cellLink(): SigilLink {
    return createSigilLinkFromParsedLink(this.link);
  }

  get entityId(): EntityRef {
    return entityRefFromString(fromURI(this.link.id));
  }

  get sourceURI(): URI {
    return this.link.id;
  }

  get copyTrap(): boolean {
    throw new Error(
      "Copy trap: Something is trying to traverse a cell.",
    );
  }
}

export function setCellUnlinkedSpace(
  cell: unknown,
  space: MemorySpace,
): void {
  asCellImpl(cell)?.setUnlinkedSpace(space);
}

function asCellImpl(cell: unknown): CellImpl<FabricValue> | undefined {
  if (cell === null || cell === undefined) return undefined;
  const maybeToCell = (cell as { [toCell]?: () => Cell<unknown> })[toCell];
  const unproxied = typeof maybeToCell === "function"
    ? maybeToCell.call(cell)
    : cell;
  if (!isCell(unproxied)) return undefined;
  return unproxied as unknown as CellImpl<FabricValue>;
}

function subscribeToReferencedDocs<T>(
  callback: (
    value: T,
    cfcLabel?: CfcLabelView | undefined,
  ) => Cancel | undefined | void,
  runtime: Runtime,
  ref: CellViewRef,
  options: SinkOptions = {},
): Cancel {
  const link = ref.link;
  const sink: SinkAction = {
    cleanup: undefined,
    action: (tx) => {
      if (isCancel(sink.cleanup)) sink.cleanup();

      // Using a new transaction for child cells, as we're only interested in
      // dependencies for the initial get, not further cells the callback might
      // read. The callback is responsible for calling sink on those cells if it
      // wants to stay updated.
      const extraTx = runtime.edit();
      const wrappedTx = createChildCellTransaction(tx, extraTx);
      const schema = link.schema;
      const needsTraversal = schema === undefined ||
        ContextualFlowControl.isTrueSchema(schema);
      const newValue = validateAndTransform(runtime, wrappedTx, ref);
      if (needsTraversal && newValue !== undefined && newValue !== null) {
        deepTraverse(newValue);
      }
      // Read the label on the SINK's transaction (`tx`), not the child `extraTx`,
      // so the cfc-metadata read joins this sink's reactive dependency set: a
      // later label-only write re-fires the sink. `cfcLabelViewForCell` is a
      // pure store read (no sync); `internalVerifierRead` keeps it reactive but
      // out of CFC taint. Raw here — the worker redacts before it leaves.
      const cfcLabel = options.includeCfcLabel
        ? cfcLabelViewForCell(createCell(runtime, link, tx))
        : undefined;
      sink.cleanup = callback(newValue, cfcLabel);

      // no async await here, but that also means no retry. TODO(seefeld): Should
      // we add a retry? So far all sinks are read-only, so they get re-triggered
      // on changes already.
      runtime.prepareTxForCommit(extraTx);
      extraTx.commit();
    },
  };
  return sinkHelper(
    sink,
    runtime,
    toMemorySpaceAddress(link),
    options,
  );
}

type SinkAction = {
  action: Action;
  cleanup: Cancel | undefined | void;
};

function sinkHelper(
  sink: SinkAction,
  runtime: Runtime,
  address: IMemorySpaceAddress,
  options: SinkOptions = {},
) {
  // Attach a name to the sink action
  const sinkName = `sink:${address.space}/${address.id}/${
    address.path.join("/")
  }`;
  Object.defineProperty(sink.action, "name", {
    value: sinkName,
    configurable: true,
  });
  (sink.action as Action & { src?: string }).src = sinkName;

  // Call action once immediately, which also defines what docs need to be
  // subscribed to. Wrap with withExecutingAction so that any child sinks
  // created during the callback see this action as their parent.
  const tx = runtime.edit();
  runtime.scheduler.withExecutingAction(sink.action, () => sink.action(tx));
  const log = txToReactivityLog(tx);

  // Technically unnecessary since we don't expect/allow callbacks to sink to
  // write to other cells, and we retry by design anyway below when read data
  // changed. But ideally we enforce read-only as well.
  runtime.prepareTxForCommit(tx);
  tx.commit();

  // Mark as effect since sink() is a side-effectful consumer (FRP effect/sink)
  // Use resubscribe because we've already run it once above
  const resubscribeOptions = {
    isEffect: true,
    ...(options.changeGroup !== undefined && {
      changeGroup: options.changeGroup,
    }),
  };
  runtime.scheduler.resubscribe(sink.action, log, resubscribeOptions);

  return () => {
    runtime.scheduler.unsubscribe(sink.action);
    if (isCancel(sink.cleanup)) sink.cleanup();
    sink.cleanup = undefined;
  };
}

/**
 * Deeply traverse a value to access all properties.
 * This is used by pull() to ensure all nested values are read,
 * which registers them as dependencies for pull-based scheduling.
 * Works with query result proxies which trigger reads on property access.
 */
function deepTraverse(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "object") return;

  // Avoid infinite loops with circular references
  if (seen.has(value)) return;
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      for (const item of value) {
        deepTraverse(item, seen);
      }
    } else {
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          try {
            deepTraverse((value as Record<string, unknown>)[key], seen);
          } catch {
            // Ignore errors from accessing individual properties (e.g., link cycles)
          }
        }
      }
    }
  } catch {
    // Ignore errors from traversal (e.g., link cycles)
    // We've already registered the dependencies we can access
  }
}

function maybeConvertArrayPathToDataURILink(
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
): NormalizedFullLink {
  if (link.path.length === 0) {
    return link;
  }

  let rootValue: unknown;
  try {
    rootValue = tx.readValueOrThrow({ ...link, path: [] }, {
      meta: ignoreReadForScheduling,
    });
  } catch {
    return link;
  }

  let current: unknown = rootValue;
  const prefix: string[] = [];
  let candidate:
    | {
      value: unknown;
      path: string[];
      remainingPath: string[];
    }
    | undefined;

  for (let i = 0; i < link.path.length; i++) {
    if (!isRecord(current)) {
      break;
    }

    const segment = link.path[i];
    let next: unknown;

    if (Array.isArray(current)) {
      if (!isArrayIndexPropertyName(segment)) {
        break;
      }
      next = (current as unknown as Record<string, unknown>)[segment];
      if (isRecord(next) && !isCellLink(next)) {
        candidate = {
          value: next,
          path: [...prefix, segment],
          remainingPath: link.path.slice(i + 1),
        };
      }
    } else {
      next = (current as Record<string, unknown>)[segment];
    }

    prefix.push(segment);
    current = next;
  }

  if (candidate === undefined) {
    return link;
  }

  const baseLink: NormalizedFullLink = {
    ...link,
    path: candidate.path,
  };

  return {
    ...link,
    id: createDataCellURI(candidate.value, baseLink),
    path: candidate.remainingPath,
  };
}

/**
 * Validates that a value contains only static data (no cells or cell-like objects)
 * and has no circular references. Used by Cell.of() to ensure only serializable
 * static data is passed.
 *
 * Note: Shared references (same object at multiple paths) are allowed.
 * Only true cycles (object referencing an ancestor) are rejected.
 *
 * @param value - The value to validate
 * @throws Error if value contains cells or has circular references
 */
function validateStaticData(value: unknown): void {
  // Track ancestors in current path (for cycle detection)
  // Shared references are fine - only cycles back to ancestors are errors
  const ancestors = new Set<object>();

  function traverse(val: unknown, path: string[]): void {
    // Primitives are always fine
    if (val === null || val === undefined) return;
    if (typeof val !== "object" && typeof val !== "function") return;

    const obj = val as object;

    // Check for cells and cell-like objects first (before cycle check)
    if (isCell(obj)) {
      throw new Error(
        `Cell.of() only accepts static data, but found a reactive value (Cell) at path '${
          path.join(".")
        }'.\n` +
          "help: use Cell references as handler parameters or in computed() closures instead of embedding them in Cell.of() values",
      );
    }

    if (isCellResultForDereferencing(obj)) {
      throw new Error(
        `Cell.of() only accepts static data, but found a reactive value (CellResult) at path '${
          path.join(".")
        }'.\n` +
          "help: use .get() to extract the value first, or pass Cell references as handler parameters",
      );
    }

    // Check for cycles - only ancestors in current path, not all seen objects
    if (ancestors.has(obj)) {
      throw new Error(
        `Cell.of() does not accept circular references. Cycle detected at path '${
          path.join(".")
        }'.\n` +
          "help: restructure your data to avoid circular references",
      );
    }

    ancestors.add(obj);

    // TODO(danfuzz): This walk has no `FabricSpecialObject` guard, so a
    // `FabricPrimitive`/`FabricInstance` in `Cell.of()` static data is walked by
    // enumerable props instead of treated as a leaf / descended by codec
    // contents.
    //
    // Traverse arrays and objects
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        traverse(obj[i], [...path, String(i)]);
      }
    } else {
      for (const key of Object.keys(obj)) {
        traverse((obj as Record<string, unknown>)[key], [...path, key]);
      }
    }

    // Remove from ancestors when backtracking (shared refs at other paths are ok)
    ancestors.delete(obj);
  }

  traverse(value, []);
}

/**
 * Recursively adds IDs elements in arrays, unless they are already a link.
 *
 * This ensures that mutable arrays only consist of links to documents, at least
 * when written to only via .set, .update and .push above.
 *
 * **Frozenness contract:** This function sits at the write boundary into
 * runner/memory storage. The returned tree is always a valid deep-frozen
 * `FabricValue`: the shallow fabric conversion freezes the sub-trees it visits,
 * and the function freezes the freshly-built top-level container before
 * returning. If the input is already a deep-frozen valid `FabricValue`, the
 * shallow conversion returns it as-is and reference identity is preserved
 * end-to-end.
 *
 * TODO(seefeld): When an array has default entries and is rewritten as [...old,
 * new], this will still break, because the previous entries will point back to
 * the array itself instead of being new entries.
 *
 * @param value - The value to add IDs to.
 * @returns The value with IDs added.
 */
export function recursivelyAddIDIfNeeded<T>(
  value: T,
  frame: Frame | undefined,
  seen: Map<unknown, unknown> = new Map(),
): T {
  // Can't add IDs without frame.
  if (!frame) return value;

  // Already seen, return previously annotated result. Check this before
  // shallowFabricFromNativeValue() to handle circular references properly.
  if (seen.has(value)) return seen.get(value) as T;

  // Cell links pass through unchanged.
  if (isCellLink(value)) {
    return value;
  }

  // `FabricInstance`s are opaque with respect to plain-object-like property
  // access; they have class-defined identity. Iterating their own-enumerable
  // properties via the generic walker would descend into wrapper internals
  // meaninglessly. Instead, walk the observable internal structure via the
  // class's `[CODEC]` `encode()` (the same mechanism the serialization system
  // uses) for side effects only — tracking shared references in `seen` and
  // populating `frame.generatedIdCounter` for any objects-in-arrays nested
  // inside — then return the original instance unchanged.
  if (value instanceof FabricInstance) {
    seen.set(value, value);

    const state = codecOf(value).encode(value);
    if (isRecord(state) || Array.isArray(state)) {
      recursivelyAddIDIfNeeded(state, frame, seen);
    }
    return value;
  }

  // Convert value to fabric form. This handles:
  // - Primitives (e.g., pass -0/NaN/Infinity/bigint through, reject unique
  //   symbols)
  // - Instances (e.g., Error → FabricError, Date → FabricEpochNsec)
  // - Objects/arrays with toJSON() methods
  // - Sparse arrays (holes preserved)
  const converted = shallowFabricFromNativeValue(value);

  // A `FabricSpecialObject` returned by the conversion step (e.g. `FabricError`
  // wrapping a native `Error`, or `FabricEpochNsec` wrapping a native `Date`).
  // These are atomic fabric values and must be returned unchanged rather than
  // walked as records (their state is private, so the record branch below would
  // flatten them to `{}`). Only `FabricInstance`s carry nested `FabricValue`s
  // that need `[ID]` assignment via the codec's `encode()`; `FabricPrimitive`s
  // are leaves.
  if (converted instanceof FabricSpecialObject) {
    seen.set(value, converted);

    if (converted instanceof FabricInstance) {
      const state = codecOf(converted).encode(converted);
      if (isRecord(state) || Array.isArray(state)) {
        recursivelyAddIDIfNeeded(state, frame, seen);
      }
    }
    return converted as T;
  }

  // Primitives need no further processing. Cache the conversion when it
  // produced a different value (e.g. an object whose `toJSON()` returns a
  // primitive) so callers see consistent results.
  if (!isRecord(converted)) {
    if (converted !== value) seen.set(value, converted);
    return converted as T;
  }

  // From here `converted` is an array or record. The result container is
  // pre-registered in `seen` against the original `value` BEFORE descending
  // into entries, so circular back-references to `value` resolve correctly.
  // Without this, a cycle would re-enter `shallowFabricFromNativeValue(value)`
  // on every pass and recurse forever.
  const convertedDiffers = converted !== value;

  if (Array.isArray(converted)) {
    // Typed as `any[]` (not `unknown[]`) to preserve the original code's
    // looser inference inside the iteration body, where `{...v}` and
    // `ID in v` operate post-narrowing without explicit casts.
    const sourceArray = converted as any[];
    const result = new Array<unknown>(sourceArray.length);
    let changed = convertedDiffers;

    seen.set(value, result);
    if (convertedDiffers) seen.set(converted, result);

    sourceArray.forEach((el, i) => {
      const v = recursivelyAddIDIfNeeded(el, frame, seen);
      // For objects on arrays only: Add ID if not already present. A
      // `FabricSpecialObject` is an atomic fabric leaf, not a plain container —
      // `{ [ID]: …, ...v }` would spread away its private state (flattening e.g.
      // a `FabricEpochNsec` to `{[ID]: …}`), so it must be left intact.
      if (
        isObject(v) && !isCellLink(v) && !(ID in v) &&
        !(v instanceof FabricSpecialObject)
      ) {
        changed = true;
        const withId = { [ID]: frame.generatedIdCounter++, ...v };
        // The ID-wrapped object is a freshly-built container that must also be
        // deep-frozen.
        Object.freeze(withId);
        result[i] = withId;
      } else {
        if (!Object.is(v, el)) {
          changed = true;
        }
        result[i] = v;
      }
    });

    if (!changed) {
      seen.set(value, value);
      return value;
    }

    // The value enters a write-boundary that expects deep-frozen `FabricValue`
    // trees. Children are already frozen by `shallowFabricFromNativeValue()`
    // above; freeze the freshly-built top-level container so the returned tree
    // is deep-frozen as a whole.
    return Object.freeze(result) as T;
  } else {
    const sourceRecord = converted as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    let changed = convertedDiffers;

    seen.set(value, result);
    if (convertedDiffers) seen.set(converted, result);

    Object.entries(sourceRecord).forEach(([key, v]) => {
      const next = recursivelyAddIDIfNeeded(v, frame, seen);
      if (!Object.is(next, v)) {
        changed = true;
      }
      result[key] = next;
    });

    // Copy supported symbols from the original value. Symbols are not
    // enumerable via `Object.entries()` and are not preserved by the
    // shallow fabric conversion.
    if (isRecord(value)) {
      const valueRecord = value as Record<string, unknown>;
      [ID, ID_FIELD].forEach((symbol) => {
        if (symbol in valueRecord) {
          (result as IDFields)[symbol as keyof IDFields] =
            (valueRecord as IDFields)[symbol as keyof IDFields];
        }
      });
    }

    if (!changed) {
      seen.set(value, value);
      return value;
    }

    return Object.freeze(result) as T;
  }
}

/**
 * Converts cells and objects that can be turned to cells to links.
 *
 * @param value - The value to convert.
 * @returns The converted value.
 */
export function convertCellsToLinks(
  value: readonly any[] | Record<string, any> | any,
  options: {
    includeSchema?: boolean;
    doNotConvertCellResults?: boolean;
    includeCfcLabelView?: boolean;
    keepAsCell?: KeepAsCell;
  } = {},
  path: string[] = [],
  seen: Map<any, string[]> = new Map(),
): any {
  if (seen.has(value)) {
    return linkRefFrom({ path: seen.get(value) });
  }

  // Early-return cases
  if (!options.doNotConvertCellResults && isCellResultForDereferencing(value)) {
    const cell = getCellOrThrow(value);
    const link = cell.getAsLink(options);
    if (options.includeCfcLabelView) {
      const cfcLabelView = getCarriedCfcLabelView(cell);
      if (cfcLabelView) {
        setLinkCfcLabelView(link, cfcLabelView);
      }
    }
    return link;
  } else if (isCell(value)) {
    const link = value.getAsLink(options);
    if (options.includeCfcLabelView) {
      const cfcLabelView = getCarriedCfcLabelView(value);
      if (cfcLabelView) {
        setLinkCfcLabelView(link, cfcLabelView);
      }
    }
    return link;
  } else if (!(isRecord(value) || isFunction(value))) {
    return value;
  }

  // At this point `value` is a non-`null` object(ish) thing.

  seen.set(value, path); // ...which needs to be tracked for circularity.

  // Convert the (top level of) the value to fabric form (a valid `FabricValue`)
  // if it isn't already, or throw if it's neither already valid nor
  // convertible.
  value = shallowFabricFromNativeValue(value);

  // Recursively process arrays and objects, if we ended up with one of those.
  if (!isRecord(value)) {
    // `shallowFabricFromNativeValue()` converted this into a primitive value of some sort.
    return value;
  } else if (Array.isArray(value)) {
    return value.map((value, index) =>
      convertCellsToLinks(value, options, [...path, String(index)], seen)
    );
  } else {
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [
        key,
        convertCellsToLinks(value, options, [...path, String(key)], seen),
      ]),
    );
  }
}

/**
 * Check if value is a simple cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isCell(value: any): value is Cell<any> {
  return value instanceof CellImpl;
}

/**
 * Check if value is any kind of cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isAnyCell(value: any): value is AnyCell<any> {
  return value instanceof CellImpl;
}

/**
 * Type guard to check if a value is a Stream.
 * @param value - The value to check
 * @returns True if the value is a Stream
 */
export function isStream<T = any>(value: any): value is Stream<T> {
  return (value instanceof CellImpl && (value as any).isStream?.());
}

export type DeepKeyLookup<T, Path extends PropertyKey[]> = Path extends [] ? T
  : Path extends [infer First, ...infer Rest]
    ? First extends keyof T
      ? Rest extends PropertyKey[] ? DeepKeyLookup<T[First], Rest>
      : any
    : any
  : any;

const scopedConstructorNames = {
  space: "perSpace",
  user: "perUser",
  session: "perSession",
} as const satisfies Record<CellScope, string>;

type ConstructableCellFactory<Wrap extends HKT> = {
  new <T>(value?: T, providedSchema?: JSONSchema): Apply<Wrap, T>;
  of<T>(value?: T, providedSchema?: JSONSchema): Apply<Wrap, T>;
  for<T>(cause: unknown): Apply<Wrap, T>;
};

function mergeSchemaScope(
  providedSchema: JSONSchema | undefined,
  scope: CellScope | undefined,
): JSONSchema | undefined {
  if (!scope) return providedSchema;

  const schema = ContextualFlowControl.toSchemaObj(providedSchema);
  if (schema.scope !== undefined && schema.scope !== scope) {
    throw new Error(
      `Cannot use ${
        scopedConstructorNames[scope]
      } with schema scope "${schema.scope}".`,
    );
  }
  return { ...schema, scope };
}

function schemaWithDefaultAndScope<T>(
  value: T | undefined,
  providedSchema: JSONSchema | undefined,
  scope: CellScope | undefined,
): JSONSchema | undefined {
  const scopedSchema = mergeSchemaScope(providedSchema, scope);
  if (value !== undefined && !isCell(value)) {
    return {
      ...ContextualFlowControl.toSchemaObj(scopedSchema),
      default: value as any,
    };
  }
  return scopedSchema;
}

export function schemaCellScope(
  schema: JSONSchema | undefined,
): CellScope | undefined {
  return isRecord(schema) && isCellScope(schema.scope)
    ? schema.scope
    : undefined;
}

/**
 * Returns `true` if the value is, or transitively contains, a query-result
 * proxy. Schemas are plain JSON, so the walk is acyclic; visiting plain
 * objects is trap-free, and a proxy is detected before recursing into it.
 */
function containsCellResult(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (isCellResultForDereferencing(value)) return true;
  for (const v of Object.values(value)) {
    if (containsCellResult(v)) return true;
  }
  return false;
}

/**
 * Interns a schema for attachment to a cell link, so the link carries the
 * canonical deep-frozen instance and the downstream identity-keyed schema
 * caches (cfc.schemaAtPath, schema-ref memos, selector standardization,
 * value-hash) hit instead of staying cold for mutable schema literals.
 *
 * Interning deep-freezes the caller's schema object in place — the same
 * contract `resolveSchema()` already applies to cell schemas on every
 * read/write-policy path.
 *
 * Exception: a schema that (transitively) contains a query-result proxy —
 * e.g. the wish builtin's `schema` argument — must NOT be frozen in place,
 * as that would push structural mutation through the proxy onto the live
 * backing value (and trip the proxy's structural-mutation guard). Such schemas
 * are interned via `deepFrozenCloneAndInternSchema()`, which deep-freezes a
 * clone — de-proxying the containers and preserving `FabricValue` leaves —
 * instead of freezing the argument in place.
 */
export function internCellLinkSchema(schema: JSONSchema): JSONSchema;
export function internCellLinkSchema(
  schema?: JSONSchema,
): JSONSchema | undefined;
export function internCellLinkSchema(
  schema?: JSONSchema,
): JSONSchema | undefined {
  // Already canonical (covers `undefined` and boolean schemas): skip the proxy
  // scan and return as-is.
  if (isInternedSchema(schema)) return schema;
  if (containsCellResult(schema)) {
    return deepFrozenCloneAndInternSchema(schema);
  }
  return internSchema(schema);
}

/**
 * Factory function to create Cell constructor with static methods for a specific cell kind
 */
export function cellConstructorFactory<Wrap extends HKT>(kind: CellKind) {
  const createCellConstructor = (scope?: CellScope) => {
    const createWithDefault = <T>(
      value?: T,
      providedSchema?: JSONSchema,
    ): Apply<Wrap, T> => {
      const frame = getTopFrame();
      if (!frame || !frame.runtime) {
        throw new Error(
          "Can't invoke Cell.of() outside of a pattern/handler/lift context",
        );
      }

      // Validate that value contains only static data (no cells or cycles)
      if (value !== undefined) {
        validateStaticData(value);
      }

      // TODO(danfuzz): native values in a `Cell.of(...)` initial value are NOT
      // normalized to their fabric form (e.g. a `Date` stays a raw `Date`
      // instead of becoming a `FabricEpochNsec`), unlike the `set()` write path
      // (which runs `recursivelyAddIDIfNeeded`). The raw value flows both into
      // `setInitialValue()` and into the schema `default` via
      // `schemaWithDefaultAndScope()` above, and reaches storage/encode from
      // there -- so a `Cell.of(new Date())` throws under the strict codec.
      // (Normalizing only the `setInitialValue()` arg is insufficient; the
      // schema-`default` copy still leaks the raw value, and embedding a
      // `FabricSpecialObject` in a hashed schema `default` is its own hazard.)
      // Fixing this cleanly is entangled with the initial-value / schema-default
      // materialization path; left for that follow-up.

      // Convert schema to object form and merge default value if value is defined
      // BUT: Don't embed Cell objects in the schema's default property, as this
      // causes infinite recursion when the schema is serialized
      const schema = schemaWithDefaultAndScope(value, providedSchema, scope);
      const linkScope = scope ?? schemaCellScope(schema);

      // Create a cell without a link - it will be created on demand via .for()
      const cell = createCell<T>(
        frame.runtime,
        {
          path: [],
          ...(schema !== undefined && { schema }),
          ...(frame.space && { space: frame.space }),
          ...(linkScope !== undefined && { scope: linkScope }),
        },
        frame.tx,
        false,
        kind,
      );

      return cell;
    };

    const createWithCause = <T>(cause: unknown): Apply<Wrap, T> => {
      const frame = getTopFrame();
      if (!frame || !frame.runtime) {
        throw new Error(
          "Can't invoke Cell.for() outside of a pattern/handler/lift context",
        );
      }

      const schema = mergeSchemaScope(undefined, scope);
      const linkScope = scope ?? schemaCellScope(schema);

      // Create a cell without a link
      const cell = createCell<T>(
        frame.runtime,
        {
          path: [],
          ...(schema !== undefined && { schema }),
          ...(frame.space && { space: frame.space }),
          ...(linkScope !== undefined && { scope: linkScope }),
        },
        frame.tx,
        false,
        kind,
      );

      // Associate it with the cause
      cell.for(cause);

      return cell;
    };

    const constructor = function <T>(
      this: unknown,
      value?: T,
      providedSchema?: JSONSchema,
    ): Apply<Wrap, T> {
      return createWithDefault(value, providedSchema);
    };

    return Object.assign(constructor, {
      of: createWithDefault,
      for: createWithCause,
    }) as unknown as ConstructableCellFactory<Wrap>;
  };

  const baseConstructor = createCellConstructor();
  return Object.assign(baseConstructor, {
    perSpace: createCellConstructor("space") as unknown as CellTypeConstructor<
      Wrap
    >["perSpace"],
    perUser: createCellConstructor("user") as unknown as CellTypeConstructor<
      Wrap
    >["perUser"],
    perSession: createCellConstructor(
      "session",
    ) as unknown as CellTypeConstructor<
      Wrap
    >["perSession"],

    /**
     * Compare two cells or values for equality, after resolving them.
     * @param a - First cell or value to compare
     * @param b - Second cell or value to compare
     * @returns true if the values are equal
     */
    equals(
      a: AnyCell<any> | object | undefined,
      b: AnyCell<any> | object | undefined,
    ): boolean {
      const frame = getTopFrame();
      return areLinksSame(
        a,
        b,
        undefined,
        !!frame?.tx,
        frame?.tx,
        frame?.runtime,
      );
    },

    /**
     * Compare two cells or values for equality.
     * @param a - First cell or value to compare
     * @param b - Second cell or value to compare
     * @returns true if the values are equal
     */
    equalLinks(
      a: AnyCell<any> | object | undefined,
      b: AnyCell<any> | object | undefined,
    ): boolean {
      return areLinksSame(a, b);
    },
  }) as unknown as CellTypeConstructor<Wrap>;
}
