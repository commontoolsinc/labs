import {
  Cell,
  type CellPath,
  ContextualFlowControl,
  extractDefaultValues,
  getMetaLink,
  getPatternIdentityRef,
  getValueAtPath,
  isCell,
  isLink,
  isStream,
  type JSONSchema,
  KeepAsCell,
  mergeSchemaDefaults,
  NAME,
  parseLinkOrThrow,
  type Pattern,
  resolveCellPath,
  resolveLink,
  type RuntimeProgram,
  sanitizeSchemaForLinks,
  schemaAcceptsOpaqueCellValue,
} from "@commonfabric/runner";
import type { CellKind } from "@commonfabric/api";
import {
  cfcSchemaChildRoot,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
  validateSchemaValue,
} from "@commonfabric/runner/cfc";
import { pieceId, PieceManager } from "../manager.ts";
import { nameSchema } from "@commonfabric/runner/schemas";
import { compileProgram } from "./utils.ts";
import {
  assertPatternSchemasBackwardCompatible,
  assertSchemaSubset,
} from "../schema-compatibility.ts";

interface PieceCellIo {
  get(path?: CellPath): Promise<unknown>;
  set(value: unknown, path?: CellPath): Promise<void>;
  getCell(): Promise<Cell<unknown>>;
}

type PiecePropIoType = "result" | "input";

/** Copy only a materialized value's path spine and replace its leaf. */
function replaceMaterializedValueAtPath(
  current: unknown,
  path: readonly (string | number)[],
  value: unknown,
): unknown {
  if (path.length === 0) return value;

  const [segment, ...remaining] = path;
  const prototype = current !== null && typeof current === "object"
    ? Object.getPrototypeOf(current)
    : undefined;
  const clone: Record<PropertyKey, unknown> | unknown[] = Array.isArray(current)
    ? current.slice()
    : prototype === Object.prototype || prototype === null
    ? Object.assign(Object.create(prototype), current)
    : typeof segment === "number"
    ? []
    : {};
  const child = current !== null && typeof current === "object"
    ? (current as Record<PropertyKey, unknown>)[segment]
    : undefined;
  Object.defineProperty(clone, segment, {
    value: replaceMaterializedValueAtPath(child, remaining, value),
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return clone;
}

interface SuppliedLink {
  path: (string | number)[];
  value: unknown;
}

interface OuterCellContract {
  kind: NonNullable<ReturnType<typeof ContextualFlowControl.getAsCellKind>>;
  payloadSchema: JSONSchema;
}

interface PathSchemaContract {
  schema: JSONSchema;
  root: JSONSchema;
  /** A valid producer value can omit an ancestor on the localized path. */
  mayBeMissing?: boolean;
}

interface DurableSchemaPath {
  root: JSONSchema;
  path: (string | number)[];
  /** Producer-document path corresponding to `path[schemaBaseDepth]`. */
  rawBasePath: (string | number)[];
  /** Projection ancestors in `path` that do not exist in the producer doc. */
  schemaBaseDepth: number;
  /** Materialized schema root used to validate the complete staged value. */
  validationCell: Cell<unknown>;
  /** Path within `validationCell` changed by the producer write. */
  validationPath: (string | number)[];
}

interface DurableSourceContract {
  schemas: DurableSchemaPath[];
}

interface StreamEventLocalization {
  contract: PathSchemaContract;
  consumedStream: boolean;
  issue?: string;
}

interface OuterCellShape {
  kind: CellKind;
  scope: ReturnType<typeof ContextualFlowControl.getAsCellScope>;
}

interface OuterCellLocalization {
  contract: PathSchemaContract;
  outer?: OuterCellShape;
  issue?: string;
}

interface StoredCellTopology {
  value: unknown;
  opaqueHandle: boolean;
}

function storedCellTopology(
  value: unknown,
  cell: Cell<unknown>,
): StoredCellTopology {
  if (!isLink(value)) return { value, opaqueHandle: false };
  try {
    return {
      value,
      // A write redirect is an ordinary projection alias. A non-redirecting
      // link is a first-class Cell handle whose wrapper capability applies.
      opaqueHandle: parseLinkOrThrow(value, cell).overwrite !== "redirect",
    };
  } catch {
    // Malformed links fail later during normal resolution/validation; do not
    // grant them an ordinary-value branch for capability checks.
    return { value, opaqueHandle: true };
  }
}

const LINK_PATH_SAFE_ANCESTOR_KEYS = new Set([
  "$comment",
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "asCell",
  "default",
  "definitions",
  "description",
  "examples",
  "ifc",
  "items",
  "maxItems",
  "minItems",
  "patternProperties",
  "prefixItems",
  "properties",
  "readOnly",
  "required",
  "scope",
  "tags",
  "title",
  "type",
  "writeOnly",
]);

const SCHEMA_ANNOTATION_KEYS = new Set([
  "$comment",
  "$defs",
  "$id",
  "$schema",
  "description",
  "examples",
  "title",
]);

function asCellShapesMatch(left: JSONSchema | undefined, right: JSONSchema) {
  const leftEntries = ContextualFlowControl.getAsCellValues(left);
  const rightEntries = ContextualFlowControl.getAsCellValues(right);
  return leftEntries.length === rightEntries.length &&
    leftEntries.every((entry, index) =>
      ContextualFlowControl.getAsCellKind(entry) ===
        ContextualFlowControl.getAsCellKind(rightEntries[index]) &&
      ContextualFlowControl.getAsCellScope(entry) ===
        ContextualFlowControl.getAsCellScope(rightEntries[index])
    );
}

function resolvePathSchemaContract(
  contract: PathSchemaContract,
): PathSchemaContract {
  const schema = contract.schema;
  const schemaRoot = cfcSchemaChildRoot(schema, contract.root);
  if (
    typeof schema !== "object" || schema === null ||
    typeof schema.$ref !== "string"
  ) {
    return { ...contract, schema, root: schemaRoot };
  }
  const resolved = resolveCfcSchemaRefs(schema, schemaRoot);
  if (resolved === undefined) {
    throw new Error("cannot resolve a local schema reference on a link path");
  }
  const owningRoot = resolveCfcSchemaRefRoot(schema, schemaRoot);
  return {
    ...contract,
    schema: resolved,
    root: cfcSchemaChildRoot(resolved, owningRoot),
  };
}

function isUnconditionallyType(
  schema: Exclude<JSONSchema, boolean>,
  type: string,
): boolean {
  return schema.type === type ||
    Array.isArray(schema.type) && schema.type.length > 0 &&
      schema.type.every((entry) => entry === type);
}

function linkPathAncestorIssue(
  schema: Exclude<JSONSchema, boolean>,
): string | undefined {
  const key = Object.keys(schema).find((candidate) =>
    !LINK_PATH_SAFE_ANCESTOR_KEYS.has(candidate)
  );
  return key === undefined
    ? undefined
    : `${key} correlates the linked field with its parent value`;
}

/**
 * Derive every schema conjunct that applies at a durable link target.
 *
 * `schemaAtPath()` intentionally returns a convenient approximation and loses
 * pattern-property intersections and parent/field correlations. A future-value
 * link proof needs the actual conjuncts, and must fail closed when an ancestor
 * constraint cannot be localized to the linked slot.
 *
 * @internal Exported for focused contract tests; not part of the Piece API.
 */
export function linkPathContracts(
  initial: readonly PathSchemaContract[],
  path: readonly (string | number)[],
  options: {
    trackSourcePresence?: boolean;
    preserveMissingFlag?: boolean;
  } = {},
): PathSchemaContract[] {
  let contracts = [...initial];
  for (const segment of path) {
    const part = String(segment);
    const next: PathSchemaContract[] = [];
    for (const unresolved of contracts) {
      const contract = resolvePathSchemaContract(unresolved);
      const { schema, root } = contract;
      if (schema === false) {
        next.push(contract);
        continue;
      }
      if (schema === true) {
        next.push(contract);
        continue;
      }
      const ancestorIssue = linkPathAncestorIssue(schema);
      if (ancestorIssue !== undefined) throw new Error(ancestorIssue);

      const objectShaped = schema.type === "object" ||
        schema.properties !== undefined ||
        schema.patternProperties !== undefined ||
        schema.additionalProperties !== undefined;
      const arrayShaped = schema.type === "array" ||
        schema.items !== undefined ||
        schema.prefixItems !== undefined;
      if (objectShaped && arrayShaped) {
        throw new Error(
          "an ambiguous object/array ancestor cannot prove a link path",
        );
      }
      if (objectShaped) {
        const mayBeMissing = contract.mayBeMissing === true ||
          options.trackSourcePresence === true &&
            (!isUnconditionallyType(schema, "object") ||
              !schema.required?.includes(part));
        const applicable: JSONSchema[] = [];
        if (
          schema.properties !== undefined &&
          Object.hasOwn(schema.properties, part)
        ) {
          applicable.push(schema.properties[part]!);
        }
        for (
          const [source, patternSchema] of Object.entries(
            schema.patternProperties ?? {},
          )
        ) {
          if (new RegExp(source).test(part)) applicable.push(patternSchema);
        }
        if (applicable.length === 0) {
          applicable.push(schema.additionalProperties ?? true);
        }
        next.push(...applicable.map((child) => ({
          schema: child,
          root: cfcSchemaChildRoot(child, root),
          mayBeMissing,
        })));
        continue;
      }
      if (arrayShaped) {
        if (!/^(0|[1-9][0-9]*)$/.test(part)) {
          throw new Error(`array link path contains non-index segment ${part}`);
        }
        const index = Number(part);
        // Fabric arrays preserve sparse holes. `minItems` constrains length,
        // not own-property presence, so every indexed source path can still
        // yield Fabric `undefined` even for an unconditionally shaped array.
        const mayBeMissing = contract.mayBeMissing === true ||
          options.trackSourcePresence === true;
        const child = Array.isArray(schema.prefixItems) &&
            index < schema.prefixItems.length
          ? schema.prefixItems[index]!
          : schema.items ?? true;
        next.push({
          schema: child,
          root: cfcSchemaChildRoot(child, root),
          mayBeMissing,
        });
        continue;
      }
      // An unconstrained schema object is the object form of `true`.
      if (Object.keys(schema).every((key) => key === "$defs")) {
        next.push({ schema: true, root });
        continue;
      }
      throw new Error(`schema does not describe a container at ${part}`);
    }
    contracts = next;
  }
  return contracts.map(resolvePathSchemaContract).map((contract) =>
    options.trackSourcePresence === true && contract.mayBeMissing === true &&
      options.preserveMissingFlag !== true
      ? {
        schema: {
          anyOf: [contract.schema, { type: "undefined" }],
        },
        root: contract.root,
      }
      : contract
  );
}

function withoutTopLevelScope(schema: JSONSchema): JSONSchema {
  if (
    typeof schema !== "object" || schema === null || schema.scope === undefined
  ) {
    return schema;
  }
  const { scope: _scope, ...payload } = schema;
  return payload;
}

/**
 * Consume exactly one wrapper, retaining any nested Cell contract.
 *
 * @internal Exported for focused contract tests; not part of the Piece API.
 */
export function consumeOuterCellContract(
  schema: JSONSchema,
): OuterCellContract {
  const entries = ContextualFlowControl.getAsCellValues(schema);
  if (entries.length === 0 || typeof schema !== "object" || schema === null) {
    return { kind: "cell", payloadSchema: schema };
  }
  const kind = ContextualFlowControl.getAsCellKind(entries[0]);
  if (kind === undefined) throw new Error("invalid outer Cell kind");
  const { asCell: _asCell, ...payloadSchema } = schema;
  return {
    kind,
    payloadSchema: entries.length === 1
      ? payloadSchema
      : { ...payloadSchema, asCell: entries.slice(1) },
  };
}

function outerCellShapesMatch(
  left: OuterCellShape,
  right: OuterCellShape,
): boolean {
  return left.kind === right.kind && left.scope === right.scope;
}

/** Consume a uniform outer Cell wrapper through refs and compositions. */
function localizeOuterCellContract(
  unresolved: PathSchemaContract,
  stored: StoredCellTopology | undefined = undefined,
  active = new WeakSet<object>(),
): OuterCellLocalization {
  const contract = resolvePathSchemaContract(unresolved);
  const { schema, root } = contract;
  if (typeof schema !== "object" || schema === null) return { contract };
  if (active.has(schema)) {
    return { contract, issue: "recursive Cell schema cannot be localized" };
  }
  active.add(schema);
  try {
    const entries = ContextualFlowControl.getAsCellValues(schema);
    if (entries.length > 0) {
      const consumed = consumeOuterCellContract(schema);
      return {
        contract: { ...contract, schema: consumed.payloadSchema, root },
        outer: {
          kind: consumed.kind,
          scope: ContextualFlowControl.getAsCellScope(entries[0]),
        },
      };
    }

    let changed = false;
    let outer: OuterCellShape | undefined;
    const result = { ...schema };
    const mergeOuter = (
      candidate: OuterCellShape,
    ): string | undefined => {
      if (outer !== undefined && !outerCellShapesMatch(outer, candidate)) {
        return "Cell alternatives expose incompatible outer capabilities";
      }
      outer = candidate;
      return undefined;
    };

    for (const key of ["anyOf", "oneOf"] as const) {
      const alternatives = schema[key];
      if (!Array.isArray(alternatives)) continue;
      const localized = alternatives.map((alternative) =>
        localizeOuterCellContract(
          {
            schema: alternative,
            root: cfcSchemaChildRoot(alternative, root),
          },
          stored,
          active,
        )
      );
      const invalid = localized.find((entry) => entry.issue !== undefined);
      if (invalid !== undefined) return invalid;
      const wrapped = localized.filter((entry) => entry.outer !== undefined);
      if (wrapped.length === 0) continue;
      if (wrapped.length !== localized.length) {
        if (stored !== undefined && !stored.opaqueHandle) {
          const unwrapped = localized.filter((entry) =>
            entry.outer === undefined
          );
          if (
            unwrapped.length === 1 &&
            Object.keys(schema).every((schemaKey) =>
              schemaKey === key || SCHEMA_ANNOTATION_KEYS.has(schemaKey)
            )
          ) {
            // Once raw topology selects the sole ordinary alternative, a
            // singleton union with annotations is exactly that branch. Return
            // it directly so descendant localization does not mistake the
            // already-resolved union for a parent/child correlation.
            return unwrapped[0];
          }
          result[key] = unwrapped.map((entry) => entry.contract.schema);
          changed = true;
          continue;
        }
        const opaqueProbe = Symbol("opaque Cell schema probe");
        const ambiguous = localized.some((entry) =>
          entry.outer === undefined &&
          validateSchemaValue(
              entry.contract.schema,
              opaqueProbe,
              entry.contract.root,
              {
                acceptOpaqueValue: (_value, candidateSchema) =>
                  ContextualFlowControl.getAsCellValues(candidateSchema)
                    .length > 0,
              },
            ) === undefined
        );
        if (ambiguous) {
          const onlyStreams = wrapped.every((entry) =>
            entry.outer?.kind === "stream"
          );
          return {
            contract,
            issue: onlyStreams
              ? `stream event schema has mixed stream and non-stream ${key} alternatives`
              : `Cell schema has ambiguous wrapped and unwrapped ${key} alternatives`,
          };
        }
      }
      for (const entry of wrapped) {
        const issue = mergeOuter(entry.outer!);
        if (issue !== undefined) return { contract, issue };
      }
      // The concrete value is an opaque Cell handle, so unwrapped alternatives
      // that cannot accept that handle were not selected. Source-path absence
      // is tracked separately on the contract and restored after localization.
      result[key] = wrapped.map((entry) => entry.contract.schema);
      changed = true;
    }

    if (Array.isArray(schema.allOf)) {
      const localized = schema.allOf.map((alternative) =>
        localizeOuterCellContract(
          {
            schema: alternative,
            root: cfcSchemaChildRoot(alternative, root),
          },
          stored,
          active,
        )
      );
      const invalid = localized.find((entry) => entry.issue !== undefined);
      if (invalid !== undefined) return invalid;
      const wrapped = localized.filter((entry) => entry.outer !== undefined);
      for (const entry of wrapped) {
        const issue = mergeOuter(entry.outer!);
        if (issue !== undefined) return { contract, issue };
      }
      if (wrapped.length > 0) {
        result.allOf = localized.map((entry, index) =>
          entry.outer === undefined
            ? schema.allOf![index]
            : entry.contract.schema
        );
        changed = true;
      }
    }
    return {
      contract: { ...contract, schema: changed ? result : schema, root },
      outer,
    };
  } finally {
    active.delete(schema);
  }
}

/** @internal Exported for exhaustive authority-lattice tests. */
export function cellCapabilityCanNarrow(
  source: CellKind,
  target: CellKind,
): boolean {
  if (source === target) return true;
  if (source === "cell") {
    return target === "readonly" || target === "writeonly" ||
      target === "opaque" || target === "comparable";
  }
  if (source === "readonly") {
    return target === "comparable" || target === "opaque";
  }
  return false;
}

const cellKindCanWrite = (kind: CellKind): boolean =>
  kind === "cell" || kind === "writeonly" || kind === "stream";

function assertWritablePiecePath(
  schema: JSONSchema,
  path: readonly (string | number)[],
  bindingAtTerminal: boolean,
  writesThroughTerminal: boolean,
  baseCell: Cell<unknown>,
): void {
  let contracts: PathSchemaContract[] = [{ schema, root: schema }];
  const rawRoot = baseCell.getRawUntyped({ lastNode: "top" });
  for (let index = 0; index <= path.length; index++) {
    const terminal = index === path.length;
    // A terminal replacement/initialization does not exercise a Cell
    // capability. If it resolves through an existing link, however, it is a
    // write against that producer and the wrapper must authorize it.
    if (terminal && (bindingAtTerminal || !writesThroughTerminal)) return;
    const prefix = path.slice(0, index);
    const storedValue = rawValueAtPath(rawRoot, prefix);
    let prefixCell = baseCell;
    for (const segment of prefix) {
      prefixCell = prefixCell.key(segment as keyof unknown) as Cell<unknown>;
    }
    const stored = storedCellTopology(storedValue.value, prefixCell);
    const localized = contracts.map((contract) =>
      localizeOuterCellContract(contract, stored)
    );
    const invalid = localized.find((entry) => entry.issue !== undefined);
    if (invalid?.issue !== undefined) throw new Error(invalid.issue);
    for (const entry of localized) {
      if (
        entry.outer !== undefined &&
        (!cellKindCanWrite(entry.outer.kind) ||
          !terminal && entry.outer.kind === "stream")
      ) {
        throw new Error(
          `${entry.outer.kind} Cell path is not writable`,
        );
      }
    }
    // Once a durable link is encountered, the resolved producer contract is
    // checked independently below. Continuing through the caller schema would
    // inspect payload branches without the producer's raw topology and can
    // mistake an ordinary union alternative for a restricted Cell handle.
    if (isLink(stored.value) && writesThroughTerminal) return;
    if (terminal) return;
    const localizedContracts = localized.map((entry) => entry.contract);
    try {
      contracts = linkPathContracts(localizedContracts, [path[index]!]);
    } catch {
      // Capability checks need only the wrapper shape at the next slot. The
      // ordinary write validator below still handles parent correlations, so
      // use CFC's conservative path projection when exact link localization
      // deliberately fails closed for a correlated schema.
      const cfc = new ContextualFlowControl();
      contracts = localizedContracts.map((contract) => {
        const child = cfc.schemaAtPath(contract.schema, [
          String(path[index]!),
        ]);
        return {
          schema: child,
          root: cfcSchemaChildRoot(child, contract.root),
        };
      });
    }
  }
}

/**
 * Localize a schema from a stream handle to its event payload.
 *
 * A union can describe both stream and non-stream durable values. Every union
 * branch must expose the same outer stream wrapper before it can be consumed;
 * mixed unions fail closed because an unwrapped branch may also accept an
 * opaque stream handle. Intersections retain unwrapped sibling constraints on
 * the payload, while an explicit non-stream Cell wrapper is contradictory.
 *
 * @internal Exported for focused contract tests; not part of the Piece API.
 */
export function localizeStreamEventContract(
  unresolved: PathSchemaContract,
  active = new WeakSet<object>(),
): StreamEventLocalization {
  const contract = resolvePathSchemaContract(unresolved);
  const { schema, root } = contract;
  if (typeof schema !== "object" || schema === null) {
    return { contract, consumedStream: false };
  }
  if (active.has(schema)) {
    throw new Error("recursive stream event schema cannot be localized");
  }
  active.add(schema);
  try {
    const entries = ContextualFlowControl.getAsCellValues(schema);
    if (entries.length > 0) {
      const consumed = consumeOuterCellContract(schema);
      if (consumed.kind !== "stream") {
        return {
          contract,
          consumedStream: false,
          issue: `stream event schema uses ${consumed.kind} wrapper`,
        };
      }
      return {
        contract: { schema: consumed.payloadSchema, root },
        consumedStream: true,
      };
    }

    let changed = false;
    let consumedStream = false;
    const result = { ...schema };
    for (const key of ["anyOf", "oneOf"] as const) {
      const alternatives = schema[key];
      if (!Array.isArray(alternatives)) continue;
      const localized = alternatives.map((alternative) =>
        localizeStreamEventContract(
          {
            schema: alternative,
            root: cfcSchemaChildRoot(alternative, root),
          },
          active,
        )
      );
      const streamAlternatives = localized.filter((alternative) =>
        alternative.consumedStream
      );
      if (streamAlternatives.length > 0) {
        if (streamAlternatives.length !== localized.length) {
          return {
            contract,
            consumedStream: false,
            issue:
              `stream event schema has mixed stream and non-stream ${key} alternatives`,
          };
        }
        result[key] = streamAlternatives.map((alternative) =>
          alternative.contract.schema
        );
        consumedStream = true;
        changed = true;
      } else {
        const invalid = localized.find((alternative) =>
          alternative.issue !== undefined
        );
        if (invalid !== undefined) return invalid;
      }
    }

    if (Array.isArray(schema.allOf)) {
      const localized = schema.allOf.map((alternative) =>
        localizeStreamEventContract(
          {
            schema: alternative,
            root: cfcSchemaChildRoot(alternative, root),
          },
          active,
        )
      );
      const invalid = localized.find((alternative) =>
        alternative.issue !== undefined
      );
      if (invalid !== undefined) return invalid;
      if (localized.some((alternative) => alternative.consumedStream)) {
        result.allOf = localized.map((alternative, index) =>
          alternative.consumedStream
            ? alternative.contract.schema
            : schema.allOf![index]
        );
        consumedStream = true;
        changed = true;
      }
    }
    return {
      contract: { schema: changed ? result : schema, root },
      consumedStream,
    };
  } finally {
    active.delete(schema);
  }
}

/**
 * Consume exactly one stream wrapper from the applicable event contract.
 *
 * @internal Exported for focused contract tests; not part of the Piece API.
 */
export function consumeStreamEventContract(
  contract: PathSchemaContract,
): PathSchemaContract {
  const localized = localizeStreamEventContract(contract);
  if (localized.issue !== undefined) throw new Error(localized.issue);
  if (!localized.consumedStream) {
    throw new Error("stream event schema has no stream-bearing alternative");
  }
  return localized.contract;
}

function canFollowSourceScope(
  schema: JSONSchema,
  sourceScope: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>["scope"],
): boolean {
  const cap = ContextualFlowControl.getSchemaScopeCap(schema);
  if (cap === undefined || cap === "any") return true;
  const rank = { space: 0, user: 1, session: 2 } as const;
  return rank[sourceScope] <= rank[cap];
}

/**
 * Recover a producer contract from durable Piece metadata, ignoring any schema
 * carried by the supplied alias. A caller can narrow a Cell view before
 * serializing it, so the envelope itself is not evidence about future writes.
 */
function durableSourceContract(
  linkedCell: Cell<unknown>,
  manager: PieceManager,
): DurableSourceContract | undefined {
  const sourceLink = linkedCell.getAsNormalizedFullLink();
  const sourceRoot = manager.runtime.getCellFromLink(
    { ...sourceLink, path: [], schema: undefined },
    undefined,
    linkedCell.tx,
  );

  const resultSchema = sourceRoot.getMetaRaw("schema") as
    | JSONSchema
    | undefined;
  if (resultSchema !== undefined) {
    return {
      schemas: [{
        root: resultSchema,
        path: [...sourceLink.path],
        rawBasePath: [],
        schemaBaseDepth: 0,
        validationCell: sourceRoot,
        validationPath: [...sourceLink.path],
      }],
    };
  }

  // Argument and derived-internal documents carry a producer-owned backlink
  // to their Piece result. Recover their schemas from that result's metadata;
  // the schema on `sourceLink` itself is caller-carried and can be forged with
  // asSchema().
  const resultLink = getMetaLink(sourceRoot, "result");
  if (resultLink === undefined) return undefined;
  const ownerResult = manager.runtime.getCellFromLink(
    { ...resultLink, schema: undefined },
    undefined,
    linkedCell.tx,
  );
  const relativePath = (
    producerLink: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>,
  ): (string | number)[] | undefined => {
    if (
      producerLink.space !== sourceLink.space ||
      producerLink.id !== sourceLink.id ||
      producerLink.scope !== sourceLink.scope ||
      producerLink.path.length > sourceLink.path.length ||
      producerLink.path.some((segment, index) =>
        segment !== sourceLink.path[index]
      )
    ) return undefined;
    return [...sourceLink.path.slice(producerLink.path.length)];
  };

  const schemas: DurableSchemaPath[] = [];
  let ownedArgument = false;
  const argumentLink = getMetaLink(ownerResult, "argument");
  if (argumentLink?.schema !== undefined) {
    const path = relativePath(argumentLink);
    if (path !== undefined) {
      ownedArgument = true;
      schemas.push({
        root: argumentLink.schema,
        path,
        rawBasePath: [...argumentLink.path],
        schemaBaseDepth: 0,
        validationCell: manager.runtime.getCellFromLink(
          { ...argumentLink, schema: undefined },
          undefined,
          linkedCell.tx,
        ),
        validationPath: path,
      });
    }
  }

  const internal = ownerResult.getMetaRaw("internal");
  let ownedInternal = false;
  if (!ownedArgument && Array.isArray(internal)) {
    for (const descriptor of internal) {
      if (
        descriptor === null || typeof descriptor !== "object" ||
        !("link" in descriptor)
      ) continue;
      try {
        const parsedInternalLink = parseLinkOrThrow(
          (descriptor as { link: unknown }).link,
          ownerResult,
        );
        const internalLink = manager.runtime.getCellFromLink(
          parsedInternalLink,
          parsedInternalLink.schema,
          linkedCell.tx,
        ).getAsNormalizedFullLink();
        const path = relativePath(internalLink);
        if (path === undefined) continue;
        ownedInternal = true;
        if (internalLink.schema !== undefined) {
          schemas.push({
            root: internalLink.schema,
            path,
            rawBasePath: [...internalLink.path],
            schemaBaseDepth: 0,
            validationCell: manager.runtime.getCellFromLink(
              { ...internalLink, schema: undefined },
              undefined,
              linkedCell.tx,
            ),
            validationPath: path,
          });
        }
        break;
      } catch {
        // A malformed manifest entry is not evidence for a writable contract.
      }
    }
  }
  if (!ownedArgument && !ownedInternal) return undefined;

  // Argument and internal values may also be exposed through one or more
  // public result projections. Every current projection is an additional
  // producer-owned constraint: a write must preserve the argument/internal
  // contract and all public result contracts simultaneously.
  const ownerSchema = ownerResult.getMetaRaw("schema") as
    | JSONSchema
    | undefined;
  const projected: DurableSchemaPath[] = [];
  if (ownerSchema !== undefined) {
    const rawResult = ownerResult.getRawUntyped({ lastNode: "top" });
    const seen = new WeakSet<object>();
    const visit = (
      value: unknown,
      projectionPath: (string | number)[],
      projectionCell: Cell<unknown>,
    ): void => {
      if (isLink(value)) {
        try {
          const parsed = parseLinkOrThrow(value, projectionCell);
          const target = manager.runtime.getCellFromLink(
            parsed,
            parsed.schema,
            linkedCell.tx,
          ).getAsNormalizedFullLink();
          const suffix = relativePath(target);
          if (suffix !== undefined) {
            projected.push({
              root: ownerSchema,
              path: [...projectionPath, ...suffix],
              rawBasePath: [...target.path],
              schemaBaseDepth: projectionPath.length,
              validationCell: ownerResult,
              validationPath: [...projectionPath, ...suffix],
            });
          }
        } catch {
          // Malformed aliases are rejected by ordinary Piece validation.
        }
        return;
      }
      if (value === null || typeof value !== "object" || seen.has(value)) {
        return;
      }
      seen.add(value);
      for (const key of Object.keys(value)) {
        const segment = Array.isArray(value) ? Number(key) : key;
        visit(
          (value as Record<PropertyKey, unknown>)[key],
          [...projectionPath, segment],
          projectionCell.key(segment as keyof unknown) as Cell<unknown>,
        );
      }
      seen.delete(value);
    };
    visit(rawResult, [], ownerResult);
  }
  if (projected.length > 0) {
    const unique = new Map(
      projected.map((entry) => [JSON.stringify(entry.path), entry]),
    );
    schemas.push(...unique.values());
  }
  return schemas.length === 0 ? undefined : { schemas };
}

/**
 * Record raw links supplied anywhere in a Piece API value. Default merging
 * operates on their transaction-local materializations; the exact envelopes
 * are restored before the final durable write.
 */
function suppliedLinks(
  value: unknown,
  path: (string | number)[] = [],
  seen = new WeakSet<object>(),
): SuppliedLink[] {
  if (isLink(value)) return [{ path, value }];
  if (value === null || typeof value !== "object" || seen.has(value)) return [];

  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) && prototype !== Object.prototype &&
    prototype !== null
  ) {
    return [];
  }
  seen.add(value);

  const links: SuppliedLink[] = [];
  for (const key of Object.keys(value)) {
    links.push(...suppliedLinks(
      (value as Record<string, unknown>)[key],
      [...path, key],
      seen,
    ));
  }
  seen.delete(value);
  return links;
}

function assertContractSubset(
  sources: readonly PathSchemaContract[],
  targets: readonly PathSchemaContract[],
  label: string,
): void {
  for (const target of targets) {
    let lastError: unknown;
    const proved = sources.some((source) => {
      try {
        assertSchemaSubset(
          withoutTopLevelScope(source.schema),
          withoutTopLevelScope(target.schema),
          label,
          { sourceRoot: source.root, targetRoot: target.root },
        );
        return true;
      } catch (error) {
        lastError = error;
        return false;
      }
    });
    if (!proved) throw lastError;
  }
}

function includePossibleMissingValue(
  contract: PathSchemaContract,
): PathSchemaContract {
  if (contract.mayBeMissing !== true) return contract;
  return {
    schema: { anyOf: [contract.schema, { type: "undefined" }] },
    root: contract.root,
  };
}

function assertSuppliedLinkSchemasCompatible(
  links: readonly SuppliedLink[],
  destinationSchema: JSONSchema,
  baseCell: Cell<unknown>,
  manager: PieceManager,
  options: {
    basePath?: readonly (string | number)[];
    destinationIsStream?: boolean;
  } = {},
): Set<SuppliedLink> {
  const preservedDirectHandles = new Set<SuppliedLink>();
  for (const suppliedLink of links) {
    const basePath = options.basePath ?? [];
    const fullPath = [...basePath, ...suppliedLink.path];
    const displayPath = fullPath.join(".") || "<root>";
    let linkBase = baseCell;
    for (const segment of fullPath) {
      linkBase = linkBase.key(segment as keyof unknown) as Cell<unknown>;
    }
    let targetContracts: PathSchemaContract[];
    try {
      if (options.destinationIsStream) {
        const streamContracts = linkPathContracts(
          [{ schema: destinationSchema, root: destinationSchema }],
          basePath,
        ).map((contract) => consumeStreamEventContract(contract));
        targetContracts = linkPathContracts(
          streamContracts,
          suppliedLink.path,
        );
      } else {
        targetContracts = linkPathContracts(
          [{ schema: destinationSchema, root: destinationSchema }],
          fullPath,
        );
      }
    } catch (error) {
      throw new Error(
        `input link at ${displayPath} schema is not compatible: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const link = parseLinkOrThrow(suppliedLink.value, linkBase);
    const linkedCell = manager.runtime.getCellFromLink(
      { ...link, schema: undefined },
      undefined,
      linkBase.tx,
    );
    // A direct Cell view can be narrowed with asSchema() just as easily as a
    // serialized alias can carry a narrowed schema. Neither is a future-value
    // invariant, so every durable link needs producer-owned Piece metadata.
    const durableSource = durableSourceContract(linkedCell, manager);
    if (durableSource === undefined) {
      throw new Error(
        `input link at ${displayPath} schema is not compatible: source has no durable schema contract`,
      );
    }

    const localizedTargets = targetContracts.map((contract) =>
      localizeOuterCellContract(contract)
    );
    const invalidTarget = localizedTargets.find((entry) =>
      entry.issue !== undefined
    );
    if (invalidTarget?.issue !== undefined) {
      throw new Error(
        `input link at ${displayPath} schema is not compatible: ${invalidTarget.issue}`,
      );
    }
    const targetOuters = localizedTargets.flatMap((entry) =>
      entry.outer === undefined ? [] : [entry.outer]
    );
    const targetOuter = targetOuters[0];
    for (const outer of targetOuters.slice(1)) {
      if (!outerCellShapesMatch(targetOuter!, outer)) {
        throw new Error(
          `input link at ${displayPath} schema is not compatible: destination Cell constraints disagree`,
        );
      }
    }
    const preservesDirectHandle = targetOuter !== undefined &&
      isCell(suppliedLink.value);
    if (preservesDirectHandle) preservedDirectHandles.add(suppliedLink);

    let sourceContracts: PathSchemaContract[];
    let rawSourceContracts: PathSchemaContract[];
    try {
      rawSourceContracts = durableSource.schemas.flatMap((source) =>
        linkPathContracts(
          [{ schema: source.root, root: source.root }],
          source.path,
          { trackSourcePresence: true, preserveMissingFlag: true },
        )
      );
      sourceContracts = durableSource.schemas.flatMap((source) => {
        const root = preservesDirectHandle
          ? source.root
          : sanitizeSchemaForLinks(source.root, KeepAsCell.OnlyStream);
        return linkPathContracts(
          [{ schema: root, root }],
          source.path,
          { trackSourcePresence: true, preserveMissingFlag: true },
        );
      });
      if (!preservesDirectHandle) {
        const rawLocalizedSources = rawSourceContracts.map((contract) =>
          localizeOuterCellContract(contract)
        );
        const invalidRawSource = rawLocalizedSources.find((entry) =>
          entry.issue !== undefined
        );
        if (invalidRawSource?.issue !== undefined) {
          throw new Error(invalidRawSource.issue);
        }
        const rawSourceOuters = rawLocalizedSources.flatMap((entry) =>
          entry.outer === undefined ? [] : [entry.outer]
        );
        const rawSourceOuter = rawSourceOuters[0];
        for (const outer of rawSourceOuters.slice(1)) {
          if (!outerCellShapesMatch(rawSourceOuter!, outer)) {
            throw new Error("source Cell constraints disagree");
          }
        }
        if (
          rawSourceOuter !== undefined && rawSourceOuter.kind !== "cell" &&
          rawSourceOuter.kind !== "stream"
        ) {
          throw new Error(
            `${rawSourceOuter.kind} capability cannot be exposed as an ordinary alias`,
          );
        }
        const durableEntries = sourceContracts.map((contract) =>
          ContextualFlowControl.getAsCellValues(contract.schema)
        );
        const preservesStream = durableEntries.some((entries) =>
          ContextualFlowControl.getAsCellKind(entries[0]) === "stream"
        );
        if (preservesStream) {
          const streamContract = sourceContracts.find((contract) =>
            ContextualFlowControl.getAsCellKind(
              ContextualFlowControl.getAsCellValues(contract.schema)[0],
            ) === "stream"
          )!;
          const carriedSchema = link.schema === undefined
            ? undefined
            : linkPathContracts(
              [{ schema: link.schema, root: link.schema }],
              [],
            )[0]?.schema;
          if (!asCellShapesMatch(carriedSchema, streamContract.schema)) {
            throw new Error(
              "link does not preserve its durable stream wrapper",
            );
          }
        } else if (
          ContextualFlowControl.getAsCellValues(link.schema).length > 0
        ) {
          throw new Error("link carries a non-durable Cell wrapper");
        }
      }
    } catch (error) {
      throw new Error(
        `input link at ${displayPath} schema is not compatible: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const sourceScope = linkedCell.getAsNormalizedFullLink().scope;
    for (const targetContract of targetContracts) {
      if (!canFollowSourceScope(targetContract.schema, sourceScope)) {
        throw new Error(
          `input link at ${displayPath} schema is not compatible: source Cell scope ${sourceScope} exceeds the destination scope`,
        );
      }
    }

    if (preservesDirectHandle) {
      const localizedSources = sourceContracts.map((contract) =>
        localizeOuterCellContract(contract)
      );
      const invalidSource = localizedSources.find((entry) =>
        entry.issue !== undefined
      );
      if (invalidSource?.issue !== undefined) {
        throw new Error(
          `input link at ${displayPath} schema is not compatible: ${invalidSource.issue}`,
        );
      }
      const sourceOuters = localizedSources.flatMap((entry) =>
        entry.outer === undefined ? [] : [entry.outer]
      );
      const sourceOuter = sourceOuters[0] ?? {
        kind: isStream(suppliedLink.value) ? "stream" : "cell",
        scope: undefined,
      };
      for (const outer of sourceOuters.slice(1)) {
        if (!outerCellShapesMatch(sourceOuter, outer)) {
          throw new Error(
            `input link at ${displayPath} schema is not compatible: source Cell constraints disagree`,
          );
        }
      }
      if (!cellCapabilityCanNarrow(sourceOuter.kind, targetOuter.kind)) {
        if (
          sourceOuter.kind === "stream" || targetOuter.kind === "stream"
        ) {
          throw new Error(
            `input link at ${displayPath} schema is not compatible: ${
              sourceOuter.kind === "stream" ? "Stream" : "Cell"
            } handle is not accepted as ${targetOuter.kind}`,
          );
        }
        throw new Error(
          `input link at ${displayPath} schema is not compatible: ${sourceOuter.kind} capability cannot be exposed as ${targetOuter.kind}`,
        );
      }
      sourceContracts = localizedSources.map((entry) => entry.contract);
      targetContracts = localizedTargets.map((entry) => entry.contract);
    }
    sourceContracts = sourceContracts.map(includePossibleMissingValue);

    // The source and target contracts are conjunctions. Proving any source
    // conjunct implies each target conjunct is a conservative proof that the
    // complete source intersection is accepted by the target intersection.
    const label = `input link at ${displayPath}`;
    if (
      !preservesDirectHandle || targetOuter.kind !== "writeonly" &&
        targetOuter.kind !== "stream"
    ) {
      assertContractSubset(sourceContracts, targetContracts, label);
    }
    if (preservesDirectHandle && cellKindCanWrite(targetOuter.kind)) {
      // A writable handle can send values back to the producer, so the
      // destination payload contract must also fit the source payload.
      assertContractSubset(targetContracts, sourceContracts, label);
    }
  }
  return preservedDirectHandles;
}

function localizeWritableDestinationContracts(
  destination: DurableSchemaPath,
  rootCell: Cell<unknown>,
): { contracts: PathSchemaContract[]; isStream: boolean } {
  const { root, path, rawBasePath, schemaBaseDepth } = destination;
  let contracts: PathSchemaContract[] = [{ schema: root, root }];
  const rawRoot = rootCell.getRawUntyped({ lastNode: "top" });
  for (let index = 0; index <= path.length; index++) {
    const rawPrefix = index <= schemaBaseDepth
      ? rawBasePath
      : [...rawBasePath, ...path.slice(schemaBaseDepth, index)];
    const storedValue = rawValueAtPath(rawRoot, rawPrefix);
    let prefixCell = rootCell;
    for (const segment of rawPrefix) {
      prefixCell = prefixCell.key(segment as keyof unknown) as Cell<unknown>;
    }
    const stored = storedCellTopology(storedValue.value, prefixCell);
    const localized = contracts.map((contract) =>
      localizeOuterCellContract(contract, stored)
    );
    const invalid = localized.find((entry) => entry.issue !== undefined);
    if (invalid?.issue !== undefined) throw new Error(invalid.issue);
    const outers = localized.flatMap((entry) =>
      entry.outer === undefined ? [] : [entry.outer]
    );
    const outer = outers[0];
    for (const candidate of outers.slice(1)) {
      if (!outerCellShapesMatch(outer!, candidate)) {
        throw new Error("write destination Cell constraints disagree");
      }
    }
    const terminal = index === path.length;
    if (outer !== undefined) {
      if (!cellKindCanWrite(outer.kind)) {
        throw new Error(
          `${outer.kind} Cell write destination is not writable`,
        );
      }
      if (outer.kind === "stream" && !terminal) {
        throw new Error("stream Cell write destination path is not writable");
      }
    }
    const payloadContracts = localized.map((entry) => entry.contract);
    if (terminal) {
      return {
        contracts: payloadContracts,
        isStream: outer?.kind === "stream",
      };
    }
    contracts = linkPathContracts(payloadContracts, [path[index]!]);
  }
  throw new Error("write destination path could not be localized");
}

const MISSING_PROJECTION_ALIAS = Symbol("missing projection alias");

function rawValueAtPath(
  root: unknown,
  path: readonly (string | number)[],
): { present: boolean; value: unknown } {
  let value = root;
  for (const segment of path) {
    if (
      value === null || typeof value !== "object" ||
      !Object.hasOwn(value, segment)
    ) {
      return { present: false, value: undefined };
    }
    value = (value as Record<PropertyKey, unknown>)[segment];
  }
  return { present: true, value };
}

function rawResolvedValueAtPath(
  tx: NonNullable<Cell<unknown>["tx"]>,
  resolved: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>,
): { present: boolean; value: unknown } {
  // Read the document envelope, not only its Cell value. A metadata-only
  // argument/derived document has no own `value` field, while an explicitly
  // stored Fabric undefined does. Cell.get() intentionally projects both as
  // JavaScript undefined and therefore cannot distinguish these cases.
  const document = tx.read({
    space: resolved.space,
    id: resolved.id,
    scope: resolved.scope,
    path: [],
  });
  if (document.error !== undefined) {
    if (document.error.name === "NotFoundError") {
      return { present: false, value: undefined };
    }
    throw new Error(
      `projection alias document read failed: ${document.error.name}`,
    );
  }
  const envelope = document.ok?.value;
  if (
    envelope === null || typeof envelope !== "object" ||
    !Object.hasOwn(envelope, "value")
  ) {
    return { present: false, value: undefined };
  }
  return rawValueAtPath(
    (envelope as Record<PropertyKey, unknown>).value,
    resolved.path,
  );
}

function omitMissingProjectionAliases(
  materialized: unknown,
  raw: unknown,
  schemaView: unknown,
  cell: Cell<unknown>,
  manager: PieceManager,
  schemaViewPresent = true,
  resolving = new Set<string>(),
): unknown | typeof MISSING_PROJECTION_ALIAS {
  if (isLink(raw)) {
    const tx = cell.tx;
    if (tx === undefined) {
      throw new Error("projection alias reconciliation requires a transaction");
    }
    const parsed = parseLinkOrThrow(raw, cell);
    const fullLink = manager.runtime.getCellFromLink(
      parsed,
      undefined,
      tx,
    ).getAsNormalizedFullLink();
    const resolved = resolveLink(
      manager.runtime,
      tx,
      fullLink,
      "value",
    );
    const key = JSON.stringify([
      resolved.space,
      resolved.id,
      resolved.scope,
      resolved.path,
    ]);
    if (resolving.has(key)) return materialized;
    resolving.add(key);
    try {
      const state = rawResolvedValueAtPath(tx, resolved);
      if (
        !state.present && materialized === undefined && !schemaViewPresent
      ) {
        return MISSING_PROJECTION_ALIAS;
      }
      const resolvedCell = manager.runtime.getCellFromLink(
        { ...resolved, schema: undefined },
        undefined,
        tx,
      );
      return omitMissingProjectionAliases(
        materialized,
        state.value,
        schemaView,
        resolvedCell,
        manager,
        schemaViewPresent,
        resolving,
      );
    } finally {
      resolving.delete(key);
    }
  }
  if (
    materialized === null || typeof materialized !== "object" ||
    raw === null || typeof raw !== "object"
  ) return materialized;

  const result =
    (Array.isArray(materialized)
      ? materialized.slice()
      : { ...materialized }) as Record<string, unknown>;
  const materializedRecord = materialized as Record<PropertyKey, unknown>;
  const rawRecord = raw as Record<PropertyKey, unknown>;
  const viewRecord = schemaView !== null && typeof schemaView === "object"
    ? schemaView as Record<PropertyKey, unknown>
    : undefined;
  for (const key of Object.keys(rawRecord)) {
    if (!Object.hasOwn(materializedRecord, key)) continue;
    const rawChild = rawRecord[key];
    const childViewPresent = viewRecord !== undefined &&
      Object.hasOwn(viewRecord, key);
    const reconciled = omitMissingProjectionAliases(
      materializedRecord[key],
      rawChild,
      childViewPresent ? viewRecord[key] : undefined,
      cell.key(key as keyof unknown) as Cell<unknown>,
      manager,
      childViewPresent,
      resolving,
    );
    if (reconciled === MISSING_PROJECTION_ALIAS) {
      delete result[key];
      continue;
    }
    result[key] = reconciled;
  }
  return result;
}

function validateDurableSourceRoots(
  destination: DurableSourceContract,
  nextValue: unknown,
  manager: PieceManager,
  acceptOpaqueValue: (value: unknown, schema: JSONSchema) => boolean,
): string | undefined {
  const groups: Array<{
    root: JSONSchema;
    cell: Cell<unknown>;
    paths: (string | number)[][];
  }> = [];
  const sameCell = (left: Cell<unknown>, right: Cell<unknown>): boolean => {
    const a = left.getAsNormalizedFullLink();
    const b = right.getAsNormalizedFullLink();
    return a.space === b.space && a.id === b.id && a.scope === b.scope &&
      a.path.length === b.path.length &&
      a.path.every((segment, index) => segment === b.path[index]);
  };
  for (const schema of destination.schemas) {
    let group = groups.find((candidate) =>
      candidate.root === schema.root &&
      sameCell(candidate.cell, schema.validationCell)
    );
    if (group === undefined) {
      group = {
        root: schema.root,
        cell: schema.validationCell,
        paths: [],
      };
      groups.push(group);
    }
    if (
      !group.paths.some((path) =>
        path.length === schema.validationPath.length &&
        path.every((segment, index) => segment === schema.validationPath[index])
      )
    ) {
      group.paths.push(schema.validationPath);
    }
  }

  for (const group of groups) {
    const schemaView = group.cell.asSchema(group.root).get();
    let candidate = omitMissingProjectionAliases(
      group.cell.asSchema(undefined).get(),
      group.cell.getRawUntyped(),
      schemaView,
      group.cell,
      manager,
    );
    if (candidate === MISSING_PROJECTION_ALIAS) candidate = undefined;
    for (const path of group.paths) {
      candidate = replaceMaterializedValueAtPath(candidate, path, nextValue);
    }
    const issue = validateSchemaValue(
      group.root,
      candidate,
      group.root,
      { acceptOpaqueValue },
    );
    if (issue !== undefined) return issue;
  }
  return undefined;
}

class PiecePropIo implements PieceCellIo {
  #cc: PieceController;
  #type: PiecePropIoType;
  constructor(cc: PieceController, type: PiecePropIoType) {
    this.#cc = cc;
    this.#type = type;
  }

  async get(path?: CellPath) {
    const targetCell = await this.#getTargetCell();
    await targetCell.pull();
    return resolveCellPath(targetCell, path ?? []);
  }

  getCell(): Promise<Cell<unknown>> {
    return this.#getTargetCell();
  }

  async set(value: unknown, path?: CellPath) {
    const manager = this.#cc.manager();
    let committedTargetCell: Cell<unknown> | undefined;

    const { error } = await manager.runtime.editWithRetry((tx) => {
      // Resolve the target from the piece metadata inside every retry. A
      // concurrent setsrc may replace the argument link/schema after this
      // write starts; reusing a cell captured before the retry would then
      // write through the superseded contract.
      const piece = this.#cc.getCell().withTx(tx);
      let targetCell: Cell<unknown>;
      if (this.#type === "input") {
        targetCell = manager.getArgument(piece);
      } else {
        const resultCell = manager.getResult(piece);
        const durableSchema = resultCell.getMetaRaw("schema") as
          | JSONSchema
          | undefined;
        targetCell = durableSchema === undefined
          ? resultCell
          : resultCell.asSchema(durableSchema);
      }
      committedTargetCell = targetCell;

      // Build the path with transaction context
      let txCell = targetCell.withTx(tx);
      for (const segment of (path ?? [])) {
        txCell = txCell.key(segment as keyof unknown) as Cell<unknown>;
      }

      const writePath = path ?? [];
      const writeTargetDiffers = (
        left: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>,
        right: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>,
      ): boolean =>
        left.space !== right.space || left.id !== right.id ||
        left.scope !== right.scope || left.path.length !== right.path.length ||
        left.path.some((segment, index) => segment !== right.path[index]);
      const originalWriteTarget = txCell.getAsNormalizedFullLink();
      const resolvedWriteTarget = resolveLink(
        manager.runtime,
        tx,
        originalWriteTarget,
        "writeRedirect",
      );
      const writesThroughTerminal = writeTargetDiffers(
        originalWriteTarget,
        resolvedWriteTarget,
      );
      const validateWriteDestination = (nextValue: unknown): void => {
        if (!writesThroughTerminal) return;
        const resolved = resolvedWriteTarget;
        const resolvedCell = manager.runtime.getCellFromLink(
          resolved,
          resolved.schema,
          tx,
        );
        const durableDestination = durableSourceContract(
          resolvedCell,
          manager,
        );
        if (durableDestination === undefined) {
          throw new Error(
            `updated ${this.#type} write destination has no durable schema contract`,
          );
        }
        const destination = durableDestination;
        let localizedDestination: ReturnType<
          typeof localizeWritableDestinationContracts
        >;
        try {
          const destinationRootCell = manager.runtime.getCellFromLink(
            { ...resolved, path: [], schema: undefined },
            undefined,
            tx,
          );
          const localized = destination.schemas.map((schemaPath) =>
            localizeWritableDestinationContracts(
              schemaPath,
              destinationRootCell,
            )
          );
          const isStream = localized[0]?.isStream ?? false;
          if (localized.some((entry) => entry.isStream !== isStream)) {
            throw new Error(
              "write destination contracts disagree on Stream capability",
            );
          }
          localizedDestination = {
            contracts: localized.flatMap((entry) => entry.contracts),
            isStream,
          };
          const links = suppliedLinks(nextValue);
          for (const contract of localizedDestination.contracts) {
            assertSuppliedLinkSchemasCompatible(
              links,
              contract.schema,
              resolvedCell,
              manager,
            );
          }
        } catch (error) {
          throw new Error(
            `updated ${this.#type} does not match its write destination: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        const acceptsProvedLink = (
          candidate: unknown,
          candidateSchema: JSONSchema,
        ): boolean =>
          isLink(candidate) ||
          schemaAcceptsOpaqueCellValue(candidate, candidateSchema);
        let issue: string | undefined;
        for (const contract of localizedDestination.contracts) {
          issue = validateSchemaValue(
            contract.schema,
            nextValue,
            contract.root,
            { acceptOpaqueValue: acceptsProvedLink },
          );
          if (issue !== undefined) break;
        }
        if (issue === undefined) {
          issue = validateDurableSourceRoots(
            destination,
            nextValue,
            manager,
            acceptsProvedLink,
          );
        }
        if (issue !== undefined) {
          throw new Error(
            `updated ${this.#type} does not match its write destination: ${issue}`,
          );
        }
      };
      const setTerminalValue = (nextValue: unknown) => {
        validateWriteDestination(nextValue);
        if (
          nextValue === undefined && writePath.length > 0 &&
          !isStream(txCell)
        ) {
          // Cell.set() treats undefined as a missing child at a path. Piece IO
          // preserves Fabric's first-class explicit undefined by writing the
          // raw slot instead. Streams are the exception: undefined is an event
          // payload and must go through Cell.set(). Inspect the actual Cell so
          // compound and referenced stream schemas behave identically.
          const rawTarget = resolveLink(
            manager.runtime,
            tx,
            txCell.getAsNormalizedFullLink(),
            "writeRedirect",
          );
          manager.runtime.getCellFromLink(rawTarget, undefined, tx)
            .setRawUntyped(undefined);
        } else {
          txCell.set(nextValue);
        }
      };

      if (this.#type === "input") {
        const schema = targetCell.getAsNormalizedFullLink().schema ?? true;
        const writeSchema = writePath.length === 0
          ? schema
          : manager.runtime.cfc.schemaAtPath(
            schema,
            writePath.map((segment) => String(segment)),
          );
        const linksToRestore = suppliedLinks(value);
        assertWritablePiecePath(
          schema,
          writePath,
          linksToRestore.some((link) => link.path.length === 0),
          writesThroughTerminal,
          targetCell.withTx(tx),
        );
        const preservedDirectHandles = assertSuppliedLinkSchemasCompatible(
          linksToRestore,
          schema,
          targetCell,
          manager,
          {
            basePath: writePath,
            destinationIsStream: isStream(txCell),
          },
        );
        let materializedValue = value;
        for (const suppliedLink of linksToRestore) {
          let linkBase = txCell;
          for (const segment of suppliedLink.path) {
            linkBase = linkBase.key(segment as keyof unknown) as Cell<unknown>;
          }
          const link = parseLinkOrThrow(suppliedLink.value, linkBase);
          const linkValue = preservedDirectHandles.has(suppliedLink)
            ? suppliedLink.value
            : manager.runtime.getCellFromLink(
              link,
              sanitizeSchemaForLinks(link.schema, KeepAsCell.OnlyStream),
              tx,
            ).get();
          materializedValue = replaceMaterializedValueAtPath(
            materializedValue,
            suppliedLink.path,
            linkValue,
          );
        }
        const stagedRoot = replaceMaterializedValueAtPath(
          targetCell.asSchema(undefined).withTx(tx).get(),
          writePath,
          materializedValue,
        );
        const mergedRoot = mergeSchemaDefaults(
          stagedRoot,
          extractDefaultValues(schema),
          schema,
          {
            // A Piece API write is present even when its value is the Fabric
            // extension `undefined`; do not replace it with a default.
            valuePresent: true,
            mergeMaterializedLinks: true,
            acceptOpaqueValue: schemaAcceptsOpaqueCellValue,
          },
        );
        let nextValue = getValueAtPath(mergedRoot, writePath);
        if (writePath.length > 0) {
          nextValue = mergeSchemaDefaults(
            nextValue,
            extractDefaultValues(writeSchema),
            writeSchema,
            {
              valuePresent: true,
              mergeMaterializedLinks: true,
              acceptOpaqueValue: schemaAcceptsOpaqueCellValue,
              acceptUnionCandidate: (candidate) =>
                validateSchemaValue(
                  schema,
                  replaceMaterializedValueAtPath(
                    stagedRoot,
                    writePath,
                    candidate,
                  ),
                  schema,
                  { acceptOpaqueValue: schemaAcceptsOpaqueCellValue },
                ) === undefined,
            },
          );
        }
        const validationRoot = writePath.length === 0
          ? nextValue
          : replaceMaterializedValueAtPath(
            stagedRoot,
            writePath,
            nextValue,
          );
        const issue = validateSchemaValue(
          schema,
          validationRoot,
          schema,
          { acceptOpaqueValue: schemaAcceptsOpaqueCellValue },
        );
        if (issue !== undefined) {
          throw new Error(`updated input does not match its schema: ${issue}`);
        }
        for (const suppliedLink of linksToRestore) {
          nextValue = replaceMaterializedValueAtPath(
            nextValue,
            suppliedLink.path,
            suppliedLink.value,
          );
        }
        setTerminalValue(nextValue);
      } else {
        const schema = targetCell.getAsNormalizedFullLink().schema ?? true;
        const linksToRestore = suppliedLinks(value);
        assertWritablePiecePath(
          schema,
          writePath,
          linksToRestore.some((link) => link.path.length === 0),
          writesThroughTerminal,
          targetCell.withTx(tx),
        );
        const preservedDirectHandles = assertSuppliedLinkSchemasCompatible(
          linksToRestore,
          schema,
          targetCell,
          manager,
          {
            basePath: writePath,
            destinationIsStream: isStream(txCell),
          },
        );
        let materializedValue = value;
        for (const suppliedLink of linksToRestore) {
          let linkBase = txCell;
          for (const segment of suppliedLink.path) {
            linkBase = linkBase.key(segment as keyof unknown) as Cell<unknown>;
          }
          const link = parseLinkOrThrow(suppliedLink.value, linkBase);
          const linkValue = preservedDirectHandles.has(suppliedLink)
            ? suppliedLink.value
            : manager.runtime.getCellFromLink(
              link,
              sanitizeSchemaForLinks(link.schema, KeepAsCell.OnlyStream),
              tx,
            ).get();
          materializedValue = replaceMaterializedValueAtPath(
            materializedValue,
            suppliedLink.path,
            linkValue,
          );
        }
        if (isStream(txCell)) {
          // Sending an event does not replace the stream handle in the result
          // object. Validate the payload contract itself so unrelated result
          // projections (VNode/FS values, or optional aliases that are not
          // materialized yet) cannot invalidate an otherwise valid event.
          // This consumes exactly one stream wrapper and retains nested Cell
          // contracts plus Common Fabric extensions such as `undefined`.
          const eventContracts = linkPathContracts(
            [{ schema, root: schema }],
            writePath,
          ).map((contract) => consumeStreamEventContract(contract));
          for (const contract of eventContracts) {
            const issue = validateSchemaValue(
              contract.schema,
              materializedValue,
              contract.root,
              { acceptOpaqueValue: schemaAcceptsOpaqueCellValue },
            );
            if (issue !== undefined) {
              throw new Error(
                `updated result does not match its schema: ${issue}`,
              );
            }
          }
        } else {
          const validationRoot = replaceMaterializedValueAtPath(
            // Result projections contain aliases for optional outputs whose
            // targets may not exist yet. Untyped materialization turns those
            // missing aliases into present `undefined` properties, which can
            // make an unrelated path write fail (for example, optional array
            // output -> present undefined). The durable schema-aware view
            // keeps missing optional projections absent while preserving
            // explicit undefined wherever the schema accepts it.
            omitMissingProjectionAliases(
              targetCell.asSchema(undefined).withTx(tx).get(),
              targetCell.withTx(tx).getRawUntyped(),
              targetCell.withTx(tx).get(),
              targetCell.withTx(tx),
              manager,
            ),
            writePath,
            materializedValue,
          );
          const issue = validateSchemaValue(
            schema,
            validationRoot,
            schema,
            { acceptOpaqueValue: schemaAcceptsOpaqueCellValue },
          );
          if (issue !== undefined) {
            throw new Error(
              `updated result does not match its schema: ${issue}`,
            );
          }
        }
        setTerminalValue(value);
      }
    });
    if (error) {
      if ("reason" in error && error.reason instanceof Error) {
        throw error.reason;
      }
      throw error;
    }

    const targetCell = committedTargetCell ?? await this.#getTargetCell();

    if (this.#type === "input") {
      await manager.getResult(this.#cc.getCell()).pull();
    } else {
      await targetCell.pull();
    }
    await manager.synced();
  }

  #getTargetCell(): Promise<Cell<unknown>> {
    if (this.#type === "input") {
      return Promise.resolve(
        this.#cc.manager().getArgument(this.#cc.getCell()),
      );
    } else if (this.#type === "result") {
      return Promise.resolve(this.#cc.manager().getResult(this.#cc.getCell()));
    }
    throw new Error(`Unknown property type "${this.#type}"`);
  }
}

export class PieceController<T = unknown> {
  #cell: Cell<T>;
  #manager: PieceManager;
  #mutationVersion = 0;
  #latestSuccessfulMutationVersion = 0;
  readonly id: string;

  input: PieceCellIo;
  result: PieceCellIo;

  constructor(manager: PieceManager, cell: Cell<T>) {
    const id = pieceId(cell);
    if (!id) {
      throw new Error("Could not get an ID from a Cell<Piece>");
    }
    this.id = id;
    this.#manager = manager;
    this.#cell = cell;
    this.input = new PiecePropIo(this, "input");
    this.result = new PiecePropIo(this, "result");
  }

  name(): string | undefined {
    return this.#cell.asSchema(nameSchema).get()?.[NAME];
  }

  getCell(): Cell<T> {
    return this.#cell;
  }

  async setInput(input: object): Promise<void> {
    const mutationVersion = ++this.#mutationVersion;
    await this.#runMutation(mutationVersion, async () => {
      while (true) {
        const { pattern, ref } = await this.#loadCurrentPattern();
        try {
          const links = suppliedLinks(input);
          assertSuppliedLinkSchemasCompatible(
            links,
            pattern.argumentSchema,
            this.#manager.getArgument(this.#cell),
            this.#manager,
          );
          // Validate the exact caller value before Runner serializes Cell
          // handles into argument links. Every accepted link below has already
          // been proved against its durable producer contract, so treating it
          // as opaque here checks the surrounding native value without
          // dereferencing a cold/absent `asCell` payload. This also preserves
          // Common Fabric's first-class explicit `undefined` semantics.
          const acceptsProvedLink = (
            value: unknown,
            schema: JSONSchema,
          ) => isLink(value) || schemaAcceptsOpaqueCellValue(value, schema);
          const candidate = mergeSchemaDefaults(
            input,
            extractDefaultValues(pattern.argumentSchema),
            pattern.argumentSchema,
            { acceptOpaqueValue: acceptsProvedLink },
          );
          const issue = validateSchemaValue(
            pattern.argumentSchema,
            candidate,
            pattern.argumentSchema,
            { acceptOpaqueValue: acceptsProvedLink },
          );
          if (issue !== undefined) {
            throw new Error(
              `updated arguments do not match the candidate schema: ${issue}`,
            );
          }
          // Use setup/start so we can update inputs without forcing reschedule.
          // The identity guard prevents a concurrent setsrc from being
          // overwritten by this already-loaded pattern.
          return await execute(
            this.#manager,
            this.id,
            pattern,
            input,
            { start: true, expectedPatternIdentity: ref },
          ) as Cell<T>;
        } catch (error) {
          if (error instanceof Error) {
            if (
              error.message.includes(
                "piece pattern changed while the source update was compiling",
              )
            ) {
              continue;
            }
            // Link-schema checking happens before the runner transaction so it
            // can inspect the caller's exact envelopes. If that check raced a
            // source update, retry against the durable winner instead of
            // reporting a stale contract failure.
            await this.#cell.sync();
            const currentRef = getPatternIdentityRef(this.#cell);
            if (
              currentRef !== undefined &&
              (currentRef.identity !== ref.identity ||
                currentRef.symbol !== ref.symbol)
            ) {
              continue;
            }
          }
          throw error;
        }
      }
    });
  }

  async getPattern(): Promise<Pattern> {
    return (await this.#loadCurrentPattern()).pattern;
  }

  async #loadCurrentPattern(): Promise<{
    pattern: Pattern;
    ref: { identity: string; symbol: string };
  }> {
    await this.#cell.sync();
    const ref = getPatternIdentityRef(this.#cell);
    if (!ref) throw new Error("piece missing pattern identity");
    const runtime = this.#manager.runtime;
    const pattern = await runtime.patternManager.loadPatternByIdentity(
      ref.identity,
      ref.symbol,
      this.#manager.getSpace(),
    );
    if (!pattern) {
      throw new Error(
        `could not load pattern ${ref.identity}#${ref.symbol}`,
      );
    }
    return { pattern, ref };
  }

  /**
   * The pattern's authored source program (`{ main, mainExport?, files }`),
   * recovered from the content-addressed `pattern:<identity>` source-doc closure
   * in the piece's space. Replaces the deleted meta cell's `program`. `main` is
   * the entry filename; `mainExport` is the pattern pointer's export symbol.
   * Returns undefined when no verified source closure exists (the source docs
   * are written by every cold compile).
   */
  async getPatternSourceProgram(): Promise<
    | {
      main: string;
      mainExport?: string;
      files: { name: string; contents: string }[];
    }
    | undefined
  > {
    const ref = getPatternIdentityRef(this.#cell);
    if (!ref) throw new Error("piece missing pattern identity");
    const program = await this.#manager.runtime.patternManager
      .getPatternSourceProgramByIdentity(
        ref.identity,
        this.#manager.getSpace(),
      );
    if (!program) return undefined;
    return { ...program, mainExport: ref.symbol };
  }

  /**
   * The pattern's authored source files (see {@link getPatternSourceProgram}).
   * Returns undefined when no verified source closure exists.
   */
  async getPatternSourceFiles(): Promise<
    { name: string; contents: string }[] | undefined
  > {
    return (await this.getPatternSourceProgram())?.files;
  }

  async setPattern(program: RuntimeProgram): Promise<void> {
    const mutationVersion = ++this.#mutationVersion;
    await this.#runMutation(mutationVersion, async () => {
      const { pattern: previousPattern, ref: previousRef } = await this
        .#loadCurrentPattern();
      const pattern = await compileProgram(this.#manager, program);
      assertPatternSchemasBackwardCompatible(previousPattern, pattern);
      return await execute(this.#manager, this.id, pattern, undefined, {
        start: true,
        expectedPatternIdentity: previousRef,
        validateArgumentLinks: (argumentCell, argumentSchema) =>
          assertSuppliedLinkSchemasCompatible(
            suppliedLinks(argumentCell.getRaw()),
            argumentSchema,
            argumentCell,
            this.#manager,
          ),
      }) as Cell<T>;
    });
  }

  async #runMutation(
    mutationVersion: number,
    operation: () => Promise<Cell<T>>,
  ): Promise<void> {
    try {
      const cell = await operation();
      this.#latestSuccessfulMutationVersion = Math.max(
        this.#latestSuccessfulMutationVersion,
        mutationVersion,
      );
      if (mutationVersion === this.#mutationVersion) {
        this.#cell = cell;
      } else if (
        this.#latestSuccessfulMutationVersion === mutationVersion
      ) {
        // A newer mutation may have committed while this one was doing
        // post-commit work. If no newer mutation succeeded, reconcile from
        // durable identity instead of installing this now-stale schema view.
        await this.#refreshCellSchema(this.#mutationVersion);
      }
    } catch (error) {
      // A rejection is not evidence that setup did not commit: syncPattern()
      // and result pull both run after the atomic setup. Keep mutation versions
      // monotonic and reload the schema attached to the durable winner.
      if (this.#latestSuccessfulMutationVersion <= mutationVersion) {
        await this.#refreshCellSchema(this.#mutationVersion);
      }
      throw error;
    }
  }

  async #refreshCellSchema(refreshVersion: number): Promise<void> {
    const cell = this.#cell;
    while (
      refreshVersion === this.#mutationVersion && cell === this.#cell
    ) {
      await cell.sync();
      const refBeforeLoad = getPatternIdentityRef(cell);
      if (!refBeforeLoad) return;
      const pattern = await this.#manager.runtime.patternManager
        .loadPatternByIdentity(
          refBeforeLoad.identity,
          refBeforeLoad.symbol,
          this.#manager.getSpace(),
        );
      if (!pattern) return;
      await cell.sync();
      const refAfterLoad = getPatternIdentityRef(cell);
      if (
        !refAfterLoad ||
        refBeforeLoad.identity !== refAfterLoad.identity ||
        refBeforeLoad.symbol !== refAfterLoad.symbol
      ) {
        continue;
      }
      if (
        refreshVersion === this.#mutationVersion && cell === this.#cell
      ) {
        this.#cell = cell.asSchema(pattern.resultSchema);
      }
      return;
    }
  }

  async readingFrom(): Promise<PieceController[]> {
    const cells = await this.#manager.getReadingFrom(this.#cell);
    return cells.map((cell) => new PieceController(this.#manager, cell));
  }

  async readBy(): Promise<PieceController[]> {
    const cells = await this.#manager.getReadByPieces(this.#cell);
    return cells.map((cell) => new PieceController(this.#manager, cell));
  }

  manager(): PieceManager {
    return this.#manager;
  }
}

async function execute(
  manager: PieceManager,
  pieceId: string,
  pattern: Pattern,
  input?: object,
  options?: {
    start?: boolean;
    expectedPatternIdentity?: { identity: string; symbol: string };
    validateArgumentLinks?: (
      argumentCell: Cell<unknown>,
      argumentSchema: JSONSchema,
    ) => void;
  },
): Promise<Cell<unknown>> {
  return await manager.runWithPattern(pattern, pieceId, input, options);
}
