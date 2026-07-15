import {
  Cell,
  type CellPath,
  ContextualFlowControl,
  extractDefaultValues,
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

interface StreamEventLocalization {
  contract: PathSchemaContract;
  consumedStream: boolean;
  issue?: string;
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
  "properties",
  "readOnly",
  "required",
  "scope",
  "tags",
  "title",
  "type",
  "writeOnly",
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
  options: { trackSourcePresence?: boolean } = {},
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
      const arrayShaped = schema.type === "array" || schema.items !== undefined;
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
        const mayBeMissing = contract.mayBeMissing === true ||
          options.trackSourcePresence === true &&
            (!isUnconditionallyType(schema, "array") ||
              typeof schema.minItems !== "number" ||
              schema.minItems <= index);
        const child = schema.items ?? true;
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
    options.trackSourcePresence === true && contract.mayBeMissing === true
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
): { root: JSONSchema; path: (string | number)[] } | undefined {
  const sourceLink = linkedCell.getAsNormalizedFullLink();
  const sourceRoot = manager.runtime.getCellFromLink(
    { ...sourceLink, path: [], schema: undefined },
    undefined,
    linkedCell.tx,
  );

  const resultSchema = sourceRoot.getMetaRaw("schema") as
    | JSONSchema
    | undefined;
  if (resultSchema === undefined) return undefined;
  return { root: resultSchema, path: [...sourceLink.path] };
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

function assertSuppliedLinkSchemasCompatible(
  links: readonly SuppliedLink[],
  destinationSchema: JSONSchema,
  baseCell: Cell<unknown>,
  manager: PieceManager,
  options: {
    basePath?: readonly (string | number)[];
    destinationIsStream?: boolean;
  } = {},
): void {
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

    const wrappedTargets = targetContracts.filter((contract) =>
      ContextualFlowControl.getAsCellValues(contract.schema).length > 0
    );
    const targetWrapper = wrappedTargets[0]?.schema;
    for (const contract of wrappedTargets.slice(1)) {
      if (!asCellShapesMatch(targetWrapper, contract.schema)) {
        throw new Error(
          `input link at ${displayPath} schema is not compatible: destination Cell constraints disagree`,
        );
      }
    }
    const preservesDirectHandle = targetWrapper !== undefined &&
      isCell(suppliedLink.value);

    const sourceRoot = preservesDirectHandle
      ? durableSource.root
      : sanitizeSchemaForLinks(
        durableSource.root,
        KeepAsCell.OnlyStream,
      );
    let sourceContracts: PathSchemaContract[];
    try {
      sourceContracts = linkPathContracts(
        [{ schema: sourceRoot, root: sourceRoot }],
        durableSource.path,
        { trackSourcePresence: true },
      );
      if (!preservesDirectHandle) {
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
      const target = consumeOuterCellContract(targetWrapper!);
      const sourceIsStream = isStream(suppliedLink.value);
      const targetIsStream = target.kind === "stream";
      if (sourceIsStream !== targetIsStream) {
        throw new Error(
          `input link at ${displayPath} schema is not compatible: ${
            sourceIsStream ? "Stream" : "Cell"
          } handle is not accepted as ${target.kind}`,
        );
      }
      sourceContracts = sourceContracts.map((contract) => {
        const entries = ContextualFlowControl.getAsCellValues(contract.schema);
        return entries.length === 0 ? contract : {
          schema: consumeOuterCellContract(contract.schema).payloadSchema,
          root: contract.root,
        };
      });
      targetContracts = targetContracts.map((contract) => {
        const entries = ContextualFlowControl.getAsCellValues(contract.schema);
        return entries.length === 0 ? contract : {
          schema: consumeOuterCellContract(contract.schema).payloadSchema,
          root: contract.root,
        };
      });
    }

    // The source and target contracts are conjunctions. Proving any source
    // conjunct implies each target conjunct is a conservative proof that the
    // complete source intersection is accepted by the target intersection.
    for (const targetContract of targetContracts) {
      let lastError: unknown;
      const proved = sourceContracts.some((sourceContract) => {
        try {
          assertSchemaSubset(
            withoutTopLevelScope(sourceContract.schema),
            withoutTopLevelScope(targetContract.schema),
            `input link at ${displayPath}`,
            {
              sourceRoot: sourceContract.root,
              targetRoot: targetContract.root,
            },
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
      const setTerminalValue = (nextValue: unknown) => {
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
        assertSuppliedLinkSchemasCompatible(
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
          const linkValue = manager.runtime.getCellFromLink(
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
        assertSuppliedLinkSchemasCompatible(
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
          const linkValue = manager.runtime.getCellFromLink(
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
            targetCell.withTx(tx).get(),
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
