import {
  FabricPrimitive,
  type FabricValue,
} from "@commonfabric/data-model/fabric-value";
import {
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import {
  DEFAULT_MODEL_NAME,
  LLMClient,
  LLMRequest,
  LLMToolCall,
} from "@commonfabric/llm";
import type {
  BuiltInLLMMessage,
  BuiltInLLMParams,
  BuiltInLLMTextPart,
  BuiltInLLMTool,
  BuiltInLLMToolCallPart,
  JSONSchema,
} from "commonfabric";
import type { Schema } from "@commonfabric/api/schema";
import {
  isNontrivialSchema,
  toDeepFrozenSchema,
} from "@commonfabric/data-model/schema-utils";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { cfcAtom } from "@commonfabric/api/cfc";
import {
  LLMDialogResultSchema,
  LLMMessageSchema,
  LLMParamsSchema,
  LLMToolSchema,
} from "./llm-schemas.ts";
import { getLogger } from "@commonfabric/utils/logger";
import { isBoolean, isObject, isRecord } from "@commonfabric/utils/types";

// Message schema that mints the `LlmDerived` provenance stamp (Epic D1).
// Recorded as the schema write-policy input for each model-produced message's
// own entity doc, so the CFC persist pass stamps a labelMap integrity entry on
// exactly that message — see `pushModelMessages`.
const LLM_DERIVED_MESSAGE_SCHEMA = internSchema({
  ...LLMMessageSchema,
  ifc: { addIntegrity: [cfcAtom.llmDerived()] },
} as JSONSchema);
import type { Cell, MemorySpace, Stream } from "../cell.ts";
import {
  isCell,
  isStream,
  recordRelevantSchemaWritePolicyInput,
} from "../cell.ts";
import { resolveLinkScope } from "../scope.ts";
import { type CellScope, ID, NAME, type Pattern } from "../builder/types.ts";
import { getEntityId } from "../create-ref.ts";
import {
  entityRefToString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
import { type Action, ignoreReadForScheduling } from "../scheduler.ts";
import { Runtime } from "../runtime.ts";
import { spaceCellSchema } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { getResultCellWithSourceSchema } from "../piece-helpers.ts";
import { schemaToTypeString } from "../schema-format.ts";
import { formatTransactionSummary } from "../storage/transaction-summary.ts";
import {
  createLLMFriendlyLink,
  getMetaLink,
  matchLLMFriendlyLink,
  type NormalizedFullLink,
  parseLink,
  parseLLMFriendlyLink,
  sanitizeSchemaForLinks,
} from "../link-utils.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";
import { ContextualFlowControl } from "../cfc.ts";
import {
  type CfcLabelView,
  cfcLabelViewForCellFailClosed,
} from "../cfc/label-view.ts";
import {
  CFC_ENFORCING_STRICTNESS,
  cfcEnforcementStrictness,
} from "../cfc/types.ts";
import {
  cfcConfidentialityForObservationNode,
  type CfcFloorTrustContext,
  cfcIntegritySatisfiesFloor,
  cfcObservationFitsCeiling,
  type CfcObservationResult,
  joinCfcObservedConfidentiality,
  meetCfcObservationCeilings,
  uniqueCfcAtoms,
} from "../cfc/observation.ts";
import { createTrustResolver } from "../cfc/trust.ts";
import { cfcSchemaToObject, resolveCfcSchemaRefs } from "../cfc/schema-refs.ts";
import { createFrozenRequestSnapshot } from "../cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../cfc/sink-request.ts";
import { resolveLink } from "../link-resolution.ts";
import { internalVerifierRead } from "../storage/reactivity-log.ts";
import type { RawBuiltinResult } from "../module.ts";
import { scopedCell } from "./scope-policy.ts";
import { getFrameworkProvidedPaths } from "../builder/pattern-metadata.ts";
import {
  applyFrameworkProvidedInputs,
  stripFrameworkProvidedPaths,
} from "../framework-provided-inputs.ts";
import {
  FactoryArtifactUnavailableError,
  type MaterializedFactory,
  materializeFactory,
  prepareFactory,
} from "../factory-materialization.ts";
import { RetryWhenReady } from "../scheduler/retry-when-ready.ts";

// Avoid importing from @commonfabric/piece to prevent circular deps in tests

const logger = getLogger("llm-dialog", {
  enabled: false,
  level: "info",
});

const client = new LLMClient();
const REQUEST_TIMEOUT = 1000 * 60 * 5; // 5 minutes
// Pattern-backed tools can themselves run LLM/tool loops (for example generic
// sub-agents), so the dialog needs a budget longer than a single model call.
const TOOL_CALL_TIMEOUT = 1000 * 120; // 120 seconds
const MAX_SERIALIZE_DEPTH = 100;

/**
 * Remove the injected `result` field from a JSON schema so tools don't
 * advertise it as an input parameter.
 */
function stripInjectedResult(
  schema: JSONSchema,
): JSONSchema {
  if (!schema || typeof schema !== "object") return schema;
  const obj = schema as Record<string, unknown>;
  if (obj.type !== "object") return schema;

  const copy: Record<string, unknown> = { ...obj };
  const props = copy.properties as Record<string, unknown> | undefined;
  if (props && typeof props === "object") {
    const { result: _, ...rest } = props as Record<string, unknown>;
    copy.properties = rest;
  }
  const req = copy.required as unknown[] | undefined;
  if (Array.isArray(req)) {
    copy.required = req.filter((k) => k !== "result");
  }
  return copy;
}

// --------------------
// Helper types + utils
// --------------------

type ToolKind = "handler" | "cell" | "pattern";
type LLMObservationSerializationResult = CfcObservationResult;

type SerializeForLLMObservationParams = {
  value: unknown;
  schema?: JSONSchema;
  seen?: Set<unknown>;
  contextSpace?: MemorySpace;
  depth?: number;
  logicalPath?: readonly string[];
  rootLink?: NormalizedFullLink;
  labelView?: CfcLabelView;
  observationMaxConfidentiality?: readonly unknown[];
};

function normalizeInputSchema(schemaLike: unknown): JSONSchema {
  let inputSchema: any = schemaLike;
  if (isBoolean(inputSchema)) {
    inputSchema = {
      type: "object",
      properties: {},
      additionalProperties: inputSchema,
    };
  }
  if (!isObject(inputSchema)) inputSchema = { type: "object" };
  const stripped = stripInjectedResult(inputSchema);
  return prepareSchemaForLLM(stripped);
}

// Tool-input fields the framework fills from trusted compiler metadata.
// They are removed from the model-facing schema so the model is never asked for
// a value it cannot set — the runtime owns them.
const FRAMEWORK_PROVIDED_TOOL_FIELDS: readonly string[] = ["sandboxId"];

// Remove framework-provided fields from a tool's model-facing input schema. The
// pattern's own argumentSchema (which the runtime reads to decide what to fill)
// is untouched; only what the model sees changes.
function stripFrameworkProvidedFields(schema: JSONSchema): JSONSchema {
  return stripFrameworkProvidedPaths(
    schema,
    FRAMEWORK_PROVIDED_TOOL_FIELDS.map((field) => [field]),
  );
}

/**
 * Inline all `$ref: "#/$defs/X"` references in a JSON schema, producing a
 * self-contained schema with no `$ref` or `$defs`.
 *
 * Circular references are detected by tracking which definition names are
 * currently being resolved on the active path. When a cycle is found (or
 * `maxDepth` $ref resolutions are exceeded), the node is truncated to a
 * permissive object.
 *
 * `refDepth` only increments when resolving a `$ref`, not when recursing into
 * regular JSON properties, so deeply nested but non-recursive schemas pass
 * through without truncation.
 */
function resolveRefsForLLM(
  schema: JSONSchema,
  maxDepth = 4,
): JSONSchema {
  // Like toSchemaObj but maps false to a permissive object instead of
  // { not: true } which LLMs don't handle well.
  const toObj = (s: unknown) =>
    s === false
      ? ({ type: "object", properties: {} } as Record<string, unknown>)
      : cfcSchemaToObject(
        typeof s === "boolean" ? s : (s as JSONSchema) ?? undefined,
      );

  const schemaObj = toObj(schema);

  function resolve(
    node: unknown,
    refDepth: number,
    activeRefs: Set<string>,
  ): any {
    const nodeObj = toObj(node);

    // Handle $ref using CFC's resolveSchemaRefs for chain resolution
    if (nodeObj.$ref && typeof nodeObj.$ref === "string") {
      const refString = nodeObj.$ref;
      if (activeRefs.has(refString) || refDepth >= maxDepth) {
        // Circular or too deep — truncate
        return { type: "object", additionalProperties: true };
      }
      const resolved = resolveCfcSchemaRefs(
        nodeObj,
        schema,
      );
      if (resolved === undefined) {
        // Unresolvable or cyclic — truncate
        return { type: "object", additionalProperties: true };
      }
      const resolvedObj = toObj(resolved);
      const newActiveRefs = new Set(activeRefs);
      newActiveRefs.add(refString);
      return resolve(resolvedObj, refDepth + 1, newActiveRefs);
    }

    // Recurse into object properties (does not increment refDepth)
    const result: any = {};
    for (const [key, value] of Object.entries(nodeObj)) {
      if (key === "$defs") continue; // strip $defs from output
      if (Array.isArray(value)) {
        result[key] = value.map((item) =>
          typeof item === "object" && item !== null || typeof item === "boolean"
            ? resolve(item, refDepth, activeRefs)
            : item
        );
      } else if (
        typeof value === "object" && value !== null ||
        typeof value === "boolean"
      ) {
        result[key] = resolve(value, refDepth, activeRefs);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return resolve(schemaObj, 0, new Set());
}

/**
 * Prepare a schema for use in LLM tool definitions by:
 * 1. Stripping internal `asCell` markers and removing cycles
 * 2. Inlining all $ref references
 */
function prepareSchemaForLLM(schema: JSONSchema): JSONSchema {
  if (typeof schema !== "object" || schema === null) return schema;
  const sanitized = sanitizeSchemaForLinks(schema);
  return resolveRefsForLLM(sanitized);
}

/**
 * Resolve a piece's result schema similarly to PieceManager.#getResultSchema:
 * - Prefer a non-empty pattern.resultSchema if pattern is loaded
 * - Otherwise derive a simple object schema from the current value
 */
function getCellSchema(
  cell: Cell<unknown>,
): JSONSchema | undefined {
  // Extract schema from cell, following links that carry an embedded schema
  const { schema } = cell.asSchemaFromLinks().getAsNormalizedFullLink();

  if (isNontrivialSchema(schema)) {
    return schema;
  }

  // Resolve all links, clear the schema, then look up the schema embedded
  // in the links along the resolved chain. This handles cells accessed via
  // arrays (e.g., mentionables, recents) where the intermediate cell doesn't
  // carry a schema but a link in the chain does.
  try {
    const resolvedSchema = cell.resolveAsCell().asSchema(undefined)
      .asSchemaFromLinks()?.getAsNormalizedFullLink()?.schema;
    if (isNontrivialSchema(resolvedSchema)) {
      return resolvedSchema;
    }
  } catch (e) {
    logger.debug("llm", "getCellSchema fallback failed:", e);
  }

  // Read the resultSchema stored in a result document's meta "schema" field
  // (written by updateResultSchemaMeta when a piece runs), projected along
  // the cell's path. Checked on the cell's own document first (covers paths
  // into a result document whose links carry no schema), then on the fully
  // resolved target (covers reference chains that end at a result document).
  try {
    const own = getResultCellWithSourceSchema(cell.asSchema(undefined));
    if (isNontrivialSchema(own.schema)) {
      return own.schema;
    }
  } catch (e) {
    logger.debug("llm", "getCellSchema meta-schema lookup failed:", e);
  }
  try {
    const resolved = getResultCellWithSourceSchema(
      cell.resolveAsCell().asSchema(undefined),
    );
    if (isNontrivialSchema(resolved.schema)) {
      return resolved.schema;
    }
  } catch (e) {
    logger.debug("llm", "getCellSchema meta-schema fallback failed:", e);
  }

  // Fall back to minimal schema based on current value
  return buildMinimalSchemaFromValue(cell);
}

function buildMinimalSchemaFromValue(piece: Cell<any>): JSONSchema | undefined {
  try {
    const resultValue = piece.asSchema().get();
    if (resultValue && typeof resultValue === "object") {
      const keys = Object.keys(resultValue).filter((k) => !k.startsWith("$"));
      if (keys.length > 0) {
        return {
          type: "object",
          properties: Object.fromEntries(keys.map((k) => [k, true])),
        } as JSONSchema;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * @deprecated Use schemaToTypeString instead for cleaner TypeScript-like output.
 *
 * Simplifies a schema for LLM context documentation.
 * Removes $defs and $ref which can make schemas very large with recursive types.
 * Preserves essential type information including wrapper markers (asCell),
 * nested properties, required arrays, and small enums.
 *
 * @param schema - The schema to simplify
 * @param depth - Current recursion depth (default 0)
 * @param maxDepth - Maximum recursion depth (default 3)
 */
function simplifySchemaForContext(
  schema: JSONSchema,
  depth: number = 0,
  maxDepth: number = 3,
): JSONSchema {
  if (typeof schema !== "object" || schema === null) {
    return schema;
  }

  const schemaObj = schema as Record<string, unknown>;

  // At max depth, return a minimal schema preserving only type and wrapper markers
  if (depth >= maxDepth) {
    const minimal: Record<string, unknown> = {};
    if (schemaObj.type) minimal.type = schemaObj.type;
    if (schemaObj.asCell) minimal.asCell = schemaObj.asCell;
    return minimal as JSONSchema;
  }

  const simplified: Record<string, unknown> = {};

  // Semantic markers and essential keys to always preserve
  const PRESERVE_KEYS = [
    "type",
    "description",
    "asCell",
    "default",
    "required",
    "additionalProperties",
  ];

  // Maximum enum values to preserve (to prevent bloat)
  const MAX_ENUM_VALUES = 10;

  for (const [key, value] of Object.entries(schemaObj)) {
    // Skip $defs and $ref - these can be huge with recursive types
    if (key === "$defs" || key === "$ref") {
      continue;
    }

    // Skip $-prefixed keys (like $UI schemas) - these are internal/VDOM
    if (key.startsWith("$")) {
      continue;
    }

    // Handle properties recursively
    if (key === "properties" && typeof value === "object" && value !== null) {
      const simplifiedProps: Record<string, unknown> = {};
      for (const [propKey, propValue] of Object.entries(value)) {
        // Skip $-prefixed properties ($UI, $TYPE, etc.) - these are internal/VDOM
        if (propKey.startsWith("$")) {
          continue;
        }
        if (typeof propValue === "object" && propValue !== null) {
          simplifiedProps[propKey] = simplifySchemaForContext(
            propValue as JSONSchema,
            depth + 1,
            maxDepth,
          );
        } else {
          simplifiedProps[propKey] = propValue;
        }
      }
      simplified[key] = simplifiedProps;
      continue;
    }

    // Handle items recursively (for arrays)
    if (key === "items" && typeof value === "object" && value !== null) {
      simplified[key] = simplifySchemaForContext(
        value as JSONSchema,
        depth + 1,
        maxDepth,
      );
      continue;
    }

    // Handle enum - preserve if small, otherwise truncate
    if (key === "enum" && Array.isArray(value)) {
      if (value.length <= MAX_ENUM_VALUES) {
        simplified[key] = value;
      } else {
        // Truncate large enums and add indicator
        simplified[key] = [...value.slice(0, MAX_ENUM_VALUES), "..."];
      }
      continue;
    }

    // Handle anyOf/oneOf/allOf recursively
    if (
      (key === "anyOf" || key === "oneOf" || key === "allOf") &&
      Array.isArray(value)
    ) {
      simplified[key] = value.map((v) =>
        typeof v === "object" && v !== null
          ? simplifySchemaForContext(v as JSONSchema, depth + 1, maxDepth)
          : v
      );
      continue;
    }

    // Preserve keys from PRESERVE_KEYS list
    if (PRESERVE_KEYS.includes(key)) {
      simplified[key] = value;
      continue;
    }

    // Preserve other primitive values, but skip complex objects not handled above
    if (typeof value !== "object" || value === null) {
      simplified[key] = value;
    }
  }

  return simplified as JSONSchema;
}

function observationLinkForValue(
  value: unknown,
  logicalPath: readonly string[],
  contextSpace: MemorySpace | undefined,
  rootLink: NormalizedFullLink | undefined,
): { "@link": string } | undefined {
  if (rootLink !== undefined) {
    return {
      "@link": createLLMFriendlyLink({
        ...rootLink,
        path: [...rootLink.path, ...logicalPath],
      }, contextSpace),
    };
  }

  if (isCellResultForDereferencing(value)) {
    value = getCellOrThrow(value);
  }

  if (isCell(value)) {
    return {
      "@link": createLLMFriendlyLink(
        value.resolveAsCell().getAsNormalizedFullLink(),
        contextSpace,
      ),
    };
  }

  return undefined;
}

// TODO(danfuzz): This `isRecord`-gated walk over cell-resolved values has no
// `FabricSpecialObject` guard; a `FabricPrimitive` is decomposed and a
// `FabricInstance` is walked by internal slots rather than codec contents.
function serializeForLLMObservation(
  {
    value,
    schema,
    seen = new Set(),
    contextSpace,
    depth = 0,
    logicalPath = [],
    rootLink,
    labelView,
    observationMaxConfidentiality,
  }: SerializeForLLMObservationParams,
): LLMObservationSerializationResult {
  if (depth > MAX_SERIALIZE_DEPTH) {
    const msg =
      `[LLM Serialize] Maximum depth of ${MAX_SERIALIZE_DEPTH} reached.`;
    logger.warn(msg);
    console.warn(msg);
    return {
      value: "[Maximum depth reached]",
      observedConfidentiality: [],
    };
  }

  const nodeConfidentiality = cfcConfidentialityForObservationNode({
    schema,
    labelView,
    logicalPath,
  });
  if (
    !cfcObservationFitsCeiling(
      nodeConfidentiality,
      observationMaxConfidentiality,
    )
  ) {
    const link = observationLinkForValue(
      value,
      logicalPath,
      contextSpace,
      rootLink,
    );
    if (link !== undefined) {
      // Rendering WHICH reference sits here — without following it — is a
      // followRef observation (C4, C0 §7): the opaque handle taints the
      // prompt with the pointer's label, not the target's content label.
      const handleConfidentiality = cfcConfidentialityForObservationNode({
        labelView,
        logicalPath,
        observes: "followRef",
      });
      if (
        cfcObservationFitsCeiling(
          handleConfidentiality,
          observationMaxConfidentiality,
        )
      ) {
        return {
          value: link,
          observedConfidentiality: handleConfidentiality,
        };
      }
      // Even the pointer's label exceeds the ceiling: the handle would leak
      // which-document, and falling through would serialize the over-ceiling
      // CONTENT into consumers with no downstream gate (the post-commit
      // context/pinned-cell docs send llmParams without a sink-request
      // gate). Redact entirely — no content, no handle, no observation
      // (Codex review on #4541).
      return {
        value: "[redacted: exceeds observation ceiling]",
        observedConfidentiality: [],
      };
    }
  }

  if (!isRecord(value)) {
    return {
      value,
      observedConfidentiality: nodeConfidentiality,
    };
  }

  // If we encounter an `any` schema, turn value into a cell link
  if (
    seen.size > 0 && schema !== undefined &&
    ContextualFlowControl.isTrueSchema(schema) &&
    isCellResultForDereferencing(value)
  ) {
    value = getCellOrThrow(value);
  }

  // Turn cells into a link, unless they are data: URIs and traverse instead
  if (isCell(value)) {
    const link = value.resolveAsCell().getAsNormalizedFullLink();
    if (link.id.startsWith("data:")) {
      return serializeForLLMObservation({
        value: value.get(),
        schema,
        seen,
        contextSpace,
        depth: depth + 1,
        logicalPath,
        rootLink,
        labelView,
        observationMaxConfidentiality,
      });
    }
    return {
      value: { "@link": createLLMFriendlyLink(link, contextSpace) },
      observedConfidentiality: [],
    };
  }

  if (seen.has(value)) {
    if (isCellResultForDereferencing(value)) {
      return serializeForLLMObservation({
        value: getCellOrThrow(value),
        schema,
        seen,
        contextSpace,
        depth: depth + 1,
        logicalPath,
        rootLink,
        labelView,
        observationMaxConfidentiality,
      });
    }
    throw new Error(
      "Cannot serialize a value that has already been seen and cannot be mapped to a cell.",
    );
  }

  const nextSeen = new Set(seen);
  nextSeen.add(value);

  const cfc = new ContextualFlowControl();

  if (Array.isArray(value)) {
    const observedParts: Array<readonly unknown[] | undefined> = [
      nodeConfidentiality,
    ];
    const serialized = value.map((v, index) => {
      const linkSchema = schema !== undefined
        ? cfc.schemaAtPath(schema, [index.toString()])
        : undefined;
      let child = serializeForLLMObservation({
        value: v,
        schema: linkSchema,
        seen: nextSeen,
        contextSpace,
        depth: depth + 1,
        logicalPath: [...logicalPath, index.toString()],
        rootLink,
        labelView,
        observationMaxConfidentiality,
      });
      observedParts.push(child.observedConfidentiality);

      if (isRecord(child.value) && isCellResultForDereferencing(v)) {
        const link = getCellOrThrow(v).resolveAsCell()
          .getAsNormalizedFullLink();
        if (!link.id.startsWith("data:")) {
          child = {
            ...child,
            value: {
              "@arrayEntry": createLLMFriendlyLink(link, contextSpace),
              ...child.value,
            },
          };
        }
      }
      return child.value;
    });

    return {
      value: serialized,
      observedConfidentiality: joinCfcObservedConfidentiality(observedParts),
    };
  }

  const observedParts: Array<readonly unknown[] | undefined> = [
    nodeConfidentiality,
  ];
  const serialized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !key.startsWith("$"))
      .map(([key, propValue]) => {
        const child = serializeForLLMObservation({
          value: propValue,
          schema: schema !== undefined
            ? cfc.schemaAtPath(schema, [key])
            : undefined,
          seen: nextSeen,
          contextSpace,
          depth: depth + 1,
          logicalPath: [...logicalPath, key],
          rootLink,
          labelView,
          observationMaxConfidentiality,
        });
        observedParts.push(child.observedConfidentiality);
        return [key, child.value];
      }),
  );

  return {
    value: serialized,
    observedConfidentiality: joinCfcObservedConfidentiality(observedParts),
  };
}

/**
 * Traverses a value and serializes any cells mentioned to our LLM-friendly JSON
 * link object format.
 *
 * @param value - The value to traverse and serialize
 * @param schema - The schema for the value
 * @param seen - Set of already-visited values (for cycle detection)
 * @param contextSpace - The current execution space (for cross-space link encoding)
 * @returns The serialized value
 */
function traverseAndSerialize(
  value: unknown,
  schema: JSONSchema | undefined,
  seen: Set<unknown> = new Set(),
  contextSpace?: MemorySpace,
  depth: number = 0,
): unknown {
  return serializeForLLMObservation({
    value,
    schema,
    seen,
    contextSpace,
    depth,
  }).value;
}

/**
 * Traverses a value and converts any of our LLM friendly JSON link object
 * format cells mentioned to actual cells.
 *
 * @param runtime - The runtime to use to get the cells
 * @param space - The space to use to get the cells
 * @param value - The value to traverse and cellify
 * @returns The cellified value
 *
 * TODO(danfuzz): A `FabricPrimitive` is now returned atomically, but the other
 * special-object type, `FabricInstance` (a container), still reaches the
 * `Object.fromEntries(Object.entries(...))` walk and is flattened by its
 * internal slots (zero enumerable own-props) instead of its codec contents.
 * Unlike a primitive it *does* need descending into — but by its actual
 * contents, which this walk won't do correctly. This site will need attention
 * once FabricInstances see real use.
 */
function traverseAndCellify(
  runtime: Runtime,
  space: MemorySpace,
  value: unknown,
): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (
          isRecord(parsed) && typeof parsed["@link"] === "string" &&
          Object.keys(parsed).length === 1 &&
          matchLLMFriendlyLink.test(parsed["@link"])
        ) {
          const link = parseLLMFriendlyLink(parsed["@link"], space);
          return runtime.getCellFromLink(link);
        }
      } catch {
        // Not a JSON-encoded link object; leave the string as-is.
      }
    }
  }

  // It's a valid link, if
  // - it's a record with a single key "/"
  // - the value of the "/" key is a string that matches the URI pattern
  if (
    isRecord(value) && typeof value["@link"] === "string" &&
    Object.keys(value).length === 1 && matchLLMFriendlyLink.test(value["@link"])
  ) {
    const link = parseLLMFriendlyLink(value["@link"], space);
    return runtime.getCellFromLink(link);
  }
  if (Array.isArray(value)) {
    return value.map((v) => traverseAndCellify(runtime, space, v));
  }
  // A `FabricPrimitive` is an atomic value whose state lives in private fields
  // (zero enumerable own-props). It is not a link, so the `Object.fromEntries(
  // Object.entries(...))` rebuild below would flatten it to `{}`; leave it
  // intact as an atomic leaf, like any string or number.
  if (value instanceof FabricPrimitive) return value;
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map((
        [key, value],
      ) => [key, traverseAndCellify(runtime, space, value)]),
    );
  }
  return value;
}

const resultSchema = LLMDialogResultSchema;

const internalSchema = internSchema(
  {
    type: "object",
    properties: {
      requestId: { type: "string" },
      lastActivity: { type: "number" },
      messageObservations: {
        type: "object",
        additionalProperties: {
          type: "array",
          items: {},
        },
        default: {},
      },
    },
    required: ["requestId", "lastActivity"],
  },
);

type ToolEntry = {
  name: string;
  tool: any;
  cell: Cell<Schema<typeof LLMToolSchema>>;
};

type FactoryToolSelection = {
  selection: unknown;
  leafCell: Cell<unknown>;
  metadata: Record<string, unknown>;
};

type MaterializedFactoryTool =
  & FactoryToolSelection
  & { factory: MaterializedFactory & Readonly<Pattern> };

function admittedFactoryFromCell(cell: Cell<unknown>): unknown {
  const resolved = cell.resolveAsCell();
  for (const read of [() => resolved.getRaw(), () => resolved.get()]) {
    try {
      const value = read();
      if (isAdmittedFabricFactory(value)) return value;
    } catch {
      // A cold schema-aware get can fail before the generic imperative
      // materializer runs. The raw decoded shell, when present, wins.
    }
  }
  return undefined;
}

function factoryToolSelection(
  toolDef: Cell<unknown>,
  toolValue?: unknown,
): FactoryToolSelection | undefined {
  if (isAdmittedFabricFactory(toolValue)) {
    return { selection: toolValue, leafCell: toolDef, metadata: {} };
  }
  const direct = admittedFactoryFromCell(toolDef);
  if (isAdmittedFabricFactory(direct)) {
    return { selection: direct, leafCell: toolDef, metadata: {} };
  }

  const metadata = isRecord(toolValue) ? toolValue : {};
  const patternValue = metadata.pattern;
  if (isAdmittedFabricFactory(patternValue)) {
    return {
      selection: patternValue,
      leafCell: toolDef.key("pattern") as Cell<unknown>,
      metadata,
    };
  }
  const patternCell = toolDef.key("pattern") as Cell<unknown>;
  const nested = admittedFactoryFromCell(patternCell);
  return isAdmittedFabricFactory(nested)
    ? { selection: nested, leafCell: patternCell, metadata }
    : undefined;
}

function canonicalToolMaterializationContext(
  runtime: Runtime,
  leafCell: Cell<unknown>,
) {
  const resolvedCell = leafCell.resolveAsCell();
  const tx = runtime.readTx(
    (resolvedCell as unknown as { tx?: IExtendedStorageTransaction }).tx,
  );
  const source = resolveLink(
    runtime,
    tx,
    resolvedCell.getAsNormalizedFullLink(),
    "top",
  );
  return { runtime, artifactSpace: source.space } as const;
}

function assertToolPatternFactory(
  factory: MaterializedFactory,
): MaterializedFactory & Readonly<Pattern> {
  const state = factoryStateOf(factory);
  if (state.kind !== "pattern") {
    throw new TypeError(
      `LLM tools require a PatternFactory, got ${state.kind}`,
    );
  }
  return factory as MaterializedFactory & Readonly<Pattern>;
}

function materializeFactoryTool(
  runtime: Runtime,
  toolDef: Cell<unknown>,
  toolValue?: unknown,
): MaterializedFactoryTool | undefined {
  const selected = factoryToolSelection(toolDef, toolValue);
  if (!selected) return undefined;
  const context = canonicalToolMaterializationContext(
    runtime,
    selected.leafCell,
  );
  try {
    return {
      ...selected,
      factory: assertToolPatternFactory(
        materializeFactory(selected.selection, context),
      ),
    };
  } catch (error) {
    if (!(error instanceof FactoryArtifactUnavailableError)) throw error;
    throw new RetryWhenReady(
      prepareFactory(selected.selection, context),
      "LLM tool factory is waiting for artifact readiness",
    );
  }
}

async function prepareFactoryTool(
  runtime: Runtime,
  toolDef: Cell<unknown>,
  toolValue?: unknown,
): Promise<MaterializedFactoryTool | undefined> {
  const selected = factoryToolSelection(toolDef, toolValue);
  if (!selected) return undefined;
  return {
    ...selected,
    factory: assertToolPatternFactory(
      await prepareFactory(
        selected.selection,
        canonicalToolMaterializationContext(runtime, selected.leafCell),
      ),
    ),
  };
}

type PieceToolEntry = {
  name: string;
  piece: Cell<any>;
  pieceName: string;
  handle: string; // e.g., "/of:bafyabc123"
};

type ToolCatalog = {
  llmTools: Record<string, { description: string; inputSchema: JSONSchema }>;
  dynamicToolCells: Map<string, Cell<Schema<typeof LLMToolSchema>>>;
};

type DialogMessageObservationMap = Record<string, unknown[]>;

type DialogRequestSnapshot = {
  llmParams: LLMRequest;
  toolCatalog: ToolCatalog;
  userResultSchema: JSONSchema | undefined;
  queueName?: string;
  observationMaxConfidentiality?: readonly unknown[];
  systemObservedConfidentiality: readonly unknown[];
};

type AvailableCellsDocumentation = {
  docs: string;
  observedConfidentiality: readonly unknown[];
};

function resolveDirectContextCellRef(cell: unknown): Cell<any> | undefined {
  return isCellResultForDereferencing(cell)
    ? getCellOrThrow(cell).resolveAsCell()
    : isCell(cell)
    ? cell.resolveAsCell()
    : isRecord(cell) && typeof cell.resolveAsCell === "function"
    ? cell.resolveAsCell()
    : undefined;
}

function resolveContextCellRef(cell: unknown): Cell<any> | undefined {
  const resolved = resolveDirectContextCellRef(cell);
  if (!resolved) {
    return undefined;
  }

  try {
    const nested = resolveDirectContextCellRef(resolved.get());
    if (nested) {
      return nested;
    }
  } catch {
    // Ignore nested resolution failures and use the outer cell.
  }

  return resolved;
}

function readCellValueForObservation(
  cell: Cell<unknown>,
): unknown {
  const readTx = cell.runtime.readTx(
    (cell as unknown as { tx?: IExtendedStorageTransaction }).tx,
  );
  const link = resolveLink(
    cell.runtime,
    readTx,
    cell.getAsNormalizedFullLink(),
    "top",
  );
  const value = readTx.readValueOrThrow(link, {
    meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
  });
  return value === undefined ? cell.get() ?? cell.getRaw() : value;
}

function collectToolEntries(
  toolsCell: Cell<Record<string, Schema<typeof LLMToolSchema>>>,
): { tools: ToolEntry[]; pieces: PieceToolEntry[] } {
  const tools = toolsCell.get() ?? {};
  const rawTools = toolsCell.getRaw();
  const names = new Set(Object.keys(tools));
  if (isRecord(rawTools)) {
    for (const name of Object.keys(rawTools)) names.add(name);
  }
  const toolEntries: ToolEntry[] = [];
  const pieces: PieceToolEntry[] = [];

  for (const name of names) {
    const tool = tools[name] ??
      (isRecord(rawTools) ? rawTools[name] : undefined);
    if (tool?.piece?.get?.()) {
      const piece: Cell<any> = tool.piece;
      const pieceValue = piece.get();
      const pieceName = String(pieceValue?.[NAME] ?? name);

      // Extract handle from link
      const link = piece.getAsNormalizedFullLink();
      const handle = link.id; // Keep the "/of:..." format as the internal handle

      pieces.push({ name, piece, pieceName, handle });
      continue;
    }

    toolEntries.push({
      name,
      tool,
      cell: toolsCell.key(name) as unknown as Cell<
        Schema<typeof LLMToolSchema>
      >,
    });
  }

  return { tools: toolEntries, pieces };
}

const READ_TOOL_NAME = "read";
const INVOKE_TOOL_NAME = "invoke";
const SCHEMA_TOOL_NAME = "schema";
const PIN_TOOL_NAME = "pin";
const UNPIN_TOOL_NAME = "unpin";
const PRESENT_RESULT_TOOL_NAME = "presentResult";
const UPDATE_ARGUMENT_TOOL_NAME = "updateArgument";

const READ_INPUT_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      path: {
        type: "object",
        properties: {
          "@link": { type: "string" },
        },
        required: ["@link"],
        description:
          'Link to the cell to read. Format: { "@link": "/of:bafyabc123/path" }.',
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
);

const INVOKE_INPUT_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      path: {
        type: "object",
        properties: {
          "@link": { type: "string" },
        },
        required: ["@link"],
        description:
          'Link to the handler or pattern to invoke. Format: { "@link": "/of:bafyabc123/doThing" }.',
      },
      args: {
        type: "object",
        description: "Arguments passed to the handler or pattern.",
      },
    },
    required: ["path"],
    additionalProperties: true,
  },
);

const SCHEMA_INPUT_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      path: {
        type: "object",
        properties: {
          "@link": { type: "string" },
        },
        required: ["@link"],
        description:
          'Link to the cell to inspect. Format: { "@link": "/of:bafyabc123" }.',
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
);

const PIN_INPUT_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      path: {
        type: "object",
        properties: {
          "@link": { type: "string" },
        },
        required: ["@link"],
        description:
          'Link to pin for easy reference. Format: { "@link": "/of:bafyabc123" }.',
      },
      name: {
        type: "string",
        description: "Human-readable name for this pinned cell.",
      },
    },
    required: ["path", "name"],
    additionalProperties: false,
  },
);

const UNPIN_INPUT_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      path: {
        type: "object",
        properties: {
          "@link": { type: "string" },
        },
        required: ["@link"],
        description:
          'Link of the pinned cell to remove. Format: { "@link": "/of:bafyabc123" }.',
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
);

const UPDATE_ARGUMENT_INPUT_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      path: {
        type: "object",
        properties: {
          "@link": { type: "string" },
        },
        required: ["@link"],
        description:
          'Link to the pattern instance to update. Format: { "@link": "/of:bafyabc123" }.',
      },
      updates: {
        type: "object",
        description:
          "Field updates to apply to the pattern's arguments. Keys are field paths (e.g., 'query' or 'config.theme'), values are new values.",
      },
    },
    required: ["path", "updates"],
    additionalProperties: false,
  },
);

/**
 * Represents a pinned cell in the conversation.
 * Pinned cells are links of interest that the LLM can add/remove as a scratchpad.
 */
type PinnedCell = {
  path: string; // e.g., "/of:bafyabc123" or "/of:bafyabc123"
  name: string; // Human-readable name for display
};

// ============================================================================
// Path Utility Functions
// ============================================================================
// These utilities handle the conversion between LLM-facing path format (/of:...)
// and internal runtime format (of:...). The LLM sees paths with a leading slash
// to make it clear that strings are links.

function ensureString(
  value: unknown,
  field: string,
  example: string,
): string {
  if (isRecord(value) && typeof value["@link"] === "string") {
    return ensureString(value["@link"], field, example);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(
        `${field} must be a non-empty string, e.g. "${example}".`,
      );
    }
    return trimmed;
  }
  throw new Error(`${field} must be a string, e.g. "${example}".`);
}

function extractStringField(
  input: unknown,
  field: string,
  example: string,
): string {
  if (typeof input === "string") {
    return ensureString(input, field, example);
  }
  if (input && typeof input === "object") {
    const value = (input as Record<string, unknown>)[field];
    return ensureString(value, field, example);
  }
  throw new Error(`${field} must be a non-empty string, e.g. "${example}".`);
}

function extractRunArguments(input: unknown): Record<string, any> {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (obj.args && typeof obj.args === "object") {
      return obj.args as Record<string, any>;
    }
    const { path: _path, ...rest } = obj;
    return rest as Record<string, any>;
  }
  return {};
}

/**
 * Flattens tools by extracting handlers from piece-based tools.
 * Converts { piece: ... } entries into individual handler entries.
 *
 * @param toolsCell - Cell containing the tools
 * @param toolHandlers - Optional map to populate with handler references for invocation
 * @returns Flattened tools object with handler/pattern entries
 */
function flattenTools(
  toolsCell: Cell<any>,
  includeBuiltinTools = true,
): Record<
  string,
  {
    handler?: any;
    description: string;
    inputSchema?: JSONSchema;
    internal?: {
      kind: ToolKind;
      path: string[];
      pieceName: string;
      handle?: string;
    };
  }
> {
  const flattened: Record<string, any> = {};
  const { tools } = collectToolEntries(toolsCell);

  for (const entry of tools) {
    const canonical = materializeFactoryTool(
      toolsCell.runtime,
      entry.cell as unknown as Cell<unknown>,
      entry.tool,
    );
    if (canonical) {
      const inputSchema = stripFrameworkProvidedPaths(
        normalizeInputSchema(canonical.factory.argumentSchema),
        getFrameworkProvidedPaths(canonical.factory),
      );
      flattened[entry.name] = {
        pattern: canonical.factory,
        description: typeof canonical.metadata.description === "string"
          ? canonical.metadata.description
          : isRecord(inputSchema) && typeof inputSchema.description === "string"
          ? inputSchema.description
          : "",
        inputSchema,
        ...(canonical.metadata.useResultSchemaForObservation === true
          ? { useResultSchemaForObservation: true }
          : {}),
      };
      continue;
    }

    const passThrough: Record<string, unknown> = { ...entry.tool };
    if (!("handler" in passThrough)) continue;
    if (
      passThrough.inputSchema && typeof passThrough.inputSchema === "object"
    ) {
      passThrough.inputSchema = stripInjectedResult(passThrough.inputSchema);
    }
    flattened[entry.name] = passThrough;
  }

  if (!includeBuiltinTools) {
    return flattened;
  }

  flattened[READ_TOOL_NAME] = {
    description:
      'Read data from any cell. Input: { "@link": "/of:bafyabc123/path" }. ' +
      "Returns the cell's data with nested cells as link objects. " +
      "Compose with invoke(): invoke() returns a link, then read(link) gets the data. ",
    inputSchema: READ_INPUT_SCHEMA,
  };
  flattened[INVOKE_TOOL_NAME] = {
    description:
      'Invoke a handler or pattern. If you do not know the schema of the the handler, use schema() first. Input: { "@link": "/of:bafyabc123/doThing" }, plus optional args. ' +
      'Returns { "@link": "/of:xyz/result" } pointing to the result cell. ',
    inputSchema: INVOKE_INPUT_SCHEMA,
  };
  flattened[PIN_TOOL_NAME] = {
    description:
      'Pin a cell for easy reference. Input: { "@link": "/of:bafyabc123" } and a name. ' +
      "Pinned cells and their values appear in the system prompt. " +
      "Use to track important cells you're working with.",
    inputSchema: PIN_INPUT_SCHEMA,
  };
  flattened[UNPIN_TOOL_NAME] = {
    description: 'Unpin a cell. Input: { "@link": "/of:bafyabc123" }. ' +
      "Use when you no longer need quick access to a cell.",
    inputSchema: UNPIN_INPUT_SCHEMA,
  };
  flattened[UPDATE_ARGUMENT_TOOL_NAME] = {
    description:
      'Update arguments of a running pattern instance. Input: { "@link": "/of:bafyabc123" } and updates object. ' +
      "The pattern will automatically re-execute with the new arguments. " +
      "Use after invoke() creates a pattern, or to modify attached pattern instances. " +
      'Example: updateArgument({ "@link": "/of:xyz" }, { "query": "new search" })',
    inputSchema: UPDATE_ARGUMENT_INPUT_SCHEMA,
  };
  flattened[SCHEMA_TOOL_NAME] = {
    description:
      "Get the JSON schema for a cell to understand its structure, fields, and handlers. " +
      'Input: { "@link": "/of:bafyabc123" }. ' +
      "Returns schema showing what data can be read and what handlers can be invoked. ",
    inputSchema: SCHEMA_INPUT_SCHEMA,
  };

  return flattened;
}

/**
 * Compare two flattened tool objects to detect changes.
 * Uses a heuristic approach that compares only serializable properties
 * (description, inputSchema, internal) and excludes handler which may have
 * circular references.
 */
function _toolsHaveChanged(
  newTools: Record<string, any>,
  oldTools: Record<string, any> | undefined,
): boolean {
  if (!oldTools) return true;

  const newKeys = Object.keys(newTools).sort();
  const oldKeys = Object.keys(oldTools).sort();

  // Check if the set of tools changed
  if (newKeys.length !== oldKeys.length) return true;
  if (newKeys.some((key, i) => key !== oldKeys[i])) return true;

  // Check if any tool's serializable properties changed
  for (const key of newKeys) {
    const newTool = newTools[key];
    const oldTool = oldTools[key];

    // Compare description
    if (newTool.description !== oldTool.description) return true;

    // Compare inputSchema via interned-schema identity. `internSchema()`
    // returns the canonical reference, so structurally-equal schemas
    // collapse to `===`. Handles non-JSON-compatible `FabricValue`s in
    // schema `default` fields correctly, unlike plain `JSON.stringify`
    // (which silently mis-encodes them and could hide real changes).
    try {
      if (
        internSchema(newTool.inputSchema) !== internSchema(oldTool.inputSchema)
      ) {
        return true;
      }
    } catch {
      // Defensive: preserve the prior try/catch shape in case of
      // unexpected input. Treat any failure as "changed."
      return true;
    }

    // Compare internal metadata
    try {
      const newInternal = JSON.stringify(newTool.internal);
      const oldInternal = JSON.stringify(oldTool.internal);
      if (newInternal !== oldInternal) return true;
    } catch {
      // If internal has circular refs (unlikely), consider it changed
      return true;
    }
  }

  return false;
}

function buildToolCatalog(
  toolsCell:
    | Cell<Record<string, Schema<typeof LLMToolSchema>>>
    | Cell<Record<string, BuiltInLLMTool> | undefined>,
  includeBuiltinTools = true,
): ToolCatalog {
  const { tools } = collectToolEntries(
    toolsCell as Cell<Record<string, Schema<typeof LLMToolSchema>>>,
  );
  const llmTools: ToolCatalog["llmTools"] = {};
  const dynamicToolCells = new Map<
    string,
    Cell<Schema<typeof LLMToolSchema>>
  >();

  for (const entry of tools) {
    const canonical = materializeFactoryTool(
      toolsCell.runtime,
      entry.cell as unknown as Cell<unknown>,
      entry.tool,
    );
    if (canonical) {
      const normalizedInputSchema = normalizeInputSchema(
        canonical.factory.argumentSchema,
      );
      const description = typeof canonical.metadata.description === "string"
        ? canonical.metadata.description
        : isRecord(normalizedInputSchema) &&
            typeof normalizedInputSchema.description === "string"
        ? normalizedInputSchema.description
        : "";
      llmTools[entry.name] = {
        description,
        inputSchema: stripFrameworkProvidedPaths(
          normalizedInputSchema,
          getFrameworkProvidedPaths(canonical.factory),
        ),
      };
      dynamicToolCells.set(entry.name, entry.cell);
      continue;
    }

    const cellToolValue = (entry.cell.get() ?? {}) as Record<string, unknown>;
    const parentToolValue = (entry.tool ?? {}) as Record<string, unknown>;
    // Prefer the parent object from toolsCell.get() for static fields like
    // description/inputSchema. Child tool cells can lose nested schema detail
    // after transformer lowering, but still remain useful as a fallback.
    const toolValue = {
      ...cellToolValue,
      ...parentToolValue,
    } as Record<string, unknown>;
    const handlerValue = toolValue.handler ?? cellToolValue.handler;
    const handler =
      (isCell(handlerValue) ? handlerValue.resolveAsCell() : undefined) as
        | Cell<any>
        | undefined;
    const inputSchema = toolValue?.inputSchema ?? handler?.schema;
    if (inputSchema === undefined) {
      logger.warn("llm", `No input schema found for tool ${entry.name}`);
      continue;
    }
    const normalizedInputSchema = normalizeInputSchema(inputSchema);
    const description: string = toolValue.description ??
      (normalizedInputSchema as any)?.description ?? "";
    llmTools[entry.name] = {
      description,
      inputSchema: stripFrameworkProvidedFields(normalizedInputSchema),
    };
    dynamicToolCells.set(entry.name, entry.cell);
  }

  if (!includeBuiltinTools) {
    return { llmTools, dynamicToolCells };
  }

  llmTools[READ_TOOL_NAME] = {
    description:
      'Read data from any cell. Input: { "@link": "/of:bafyabc123/path" }. ' +
      "Returns the cell's data with nested cells as link objects. " +
      "Compose with invoke(): invoke() returns a link, then read(link) gets the data. ",
    inputSchema: READ_INPUT_SCHEMA,
  };
  llmTools[INVOKE_TOOL_NAME] = {
    description:
      'Invoke a handler or pattern. Input: { "@link": "/of:bafyabc123/doThing" }, plus optional args. ' +
      'Returns { "@link": "/of:xyz/result" } pointing to the result cell. ',
    inputSchema: INVOKE_INPUT_SCHEMA,
  };
  llmTools[PIN_TOOL_NAME] = {
    description:
      'Pin a cell for easy reference. Input: { "@link": "/of:bafyabc123" } and a name. ' +
      "Pinned cells and their values appear in the system prompt. " +
      "Use to track important cells you're working with.",
    inputSchema: PIN_INPUT_SCHEMA,
  };
  llmTools[UNPIN_TOOL_NAME] = {
    description: 'Unpin a cell. Input: { "@link": "/of:bafyabc123" }. ' +
      "Use when you no longer need quick access to a cell.",
    inputSchema: UNPIN_INPUT_SCHEMA,
  };
  llmTools[UPDATE_ARGUMENT_TOOL_NAME] = {
    description:
      'Update arguments of a running pattern instance. Input: { "@link": "/of:bafyabc123" } and updates object. ' +
      "The pattern will automatically re-execute with the new arguments. " +
      "Use after invoke() creates a pattern, or to modify attached pattern instances. " +
      'Example: updateArgument({ "@link": "/of:xyz" }, { "query": "new search" })',
    inputSchema: UPDATE_ARGUMENT_INPUT_SCHEMA,
  };
  llmTools[SCHEMA_TOOL_NAME] = {
    description:
      "Get the JSON schema for a cell to understand its structure, fields, and handlers. " +
      'Input: { "@link": "/of:bafyabc123" }. ' +
      "Returns schema showing what data can be read and what handlers can be invoked. ",
    inputSchema: SCHEMA_INPUT_SCHEMA,
  };

  return { llmTools, dynamicToolCells };
}

function materializeDialogRequestSnapshot(
  runtime: Runtime,
  space: MemorySpace,
  inputs: Cell<Schema<typeof LLMParamsSchema>>,
  pinnedCells: Cell<PinnedCell[]>,
  tx: IExtendedStorageTransaction,
): DialogRequestSnapshot {
  const { system, maxTokens, model } = inputs.withTx(tx).get();
  const context = inputs.key("context").withTx(tx).get();
  // Bound the pattern-supplied observation ceiling by the deployment's llmDialog
  // ceiling so post-commit tool-loop reads (which carry no sink-request input)
  // cannot exceed it (#3993 review).
  const observationMaxConfidentiality = effectiveObservationCeiling(
    runtime,
    "llmDialog",
    inputs.key("observationMaxConfidentiality").withTx(tx).get() as
      | readonly unknown[]
      | undefined,
  );
  const toolsCell = inputs.key("tools").withTx(tx) as Cell<
    Record<string, Schema<typeof LLMToolSchema>>
  >;
  const builtinTools = inputs.key("builtinTools").withTx(tx).get() !== false;
  const toolCatalog = buildToolCatalog(toolsCell, builtinTools);
  // TODO(danfuzz): `resultSchema` is untrusted input, so this `as` is an
  // unchecked assertion. Replace with a runtime validating guard, e.g.
  // `asSchemaOrThrow(schema: unknown): schema is JSONSchema`.
  const userResultSchema = inputs.key("resultSchema").withTx(tx).get() as
    | JSONSchema
    | undefined;
  if (userResultSchema) {
    toolCatalog.llmTools[PRESENT_RESULT_TOOL_NAME] = {
      description:
        "Call this tool to present a structured result. This stores the result for the caller.",
      inputSchema: prepareSchemaForLLM(
        toDeepFrozenSchema(userResultSchema),
      ),
    };
  }

  // A DECLARED bound — even the empty one — engages observation-aware
  // serialization: [] means "public only" (cfcObservationFitsCeiling), and the
  // deployment sink ceiling folds in as exactly that, so treating it like the
  // absent bound would disable redaction right when the strictest bound is set
  // (#3993 review).
  const cellsDocs = observationMaxConfidentiality !== undefined
    ? buildAvailableCellsDocumentationWithObservation(
      runtime,
      space,
      context,
      pinnedCells.withTx(tx),
      observationMaxConfidentiality,
    )
    : {
      docs: buildAvailableCellsDocumentation(
        runtime,
        space,
        context,
        pinnedCells.withTx(tx),
      ),
      observedConfidentiality: [],
    };
  const linkModelDocs = builtinTools
    ? "\n\n# Link and Cell Model\n\nThe system organizes all data and computation into cells. Use links to navigate between related data and compose tool operations."
    : "";
  const listRecentHint = builtinTools
    ? "\n\nIf the user's request is unclear or you need context about what they're referring to, call listRecent() to see recently viewed pieces."
    : "";
  const augmentedSystem = (system ?? "") + linkModelDocs + cellsDocs.docs +
    listRecentHint;

  const llmParams = {
    system: augmentedSystem,
    messages: inputs.key("messages").withTx(tx)
      .get() as readonly BuiltInLLMMessage[],
    maxTokens: maxTokens ?? 4096,
    stream: true,
    model: model ?? DEFAULT_MODEL_NAME,
    metadata: { context: "piece" },
    cache: true,
    tools: toolCatalog.llmTools,
  };

  return {
    // TODO(danfuzz): Latent — schemas don't admit `Fabric*` values on this
    // `.get()`-path today, but will in the not-too-distant future; at that point
    // this JSON round-trip silently loses any `FabricPrimitive`/`FabricInstance`
    // (class instances don't survive JSON). Mark ahead of that.
    llmParams: createFrozenRequestSnapshot(
      JSON.parse(JSON.stringify(llmParams)),
    ),
    toolCatalog,
    userResultSchema,
    observationMaxConfidentiality,
    systemObservedConfidentiality: cellsDocs.observedConfidentiality,
    queueName: inputs.key("queue").withTx(tx).get() as unknown as
      | string
      | undefined,
  };
}

/**
 * Build a formatted documentation string describing all available cells:
 * both context cells (passed via the context parameter) and pinned cells
 * (managed by pin/unpin tools). Includes schemas and current values for each cell.
 * This is appended to the system prompt so the LLM has immediate context.
 */
function buildAvailableCellsDocumentationWithObservation(
  runtime: Runtime,
  space: MemorySpace,
  context: Record<string, unknown> | undefined,
  pinnedCells: Cell<PinnedCell[]>,
  observationMaxConfidentiality?: readonly unknown[],
): AvailableCellsDocumentation {
  // Collect all cell entries, deduplicating by resolved path.
  // When the same cell appears multiple times (e.g., from context AND pinned),
  // prefer the entry with a schema.
  const seenPaths = new Map<
    string,
    {
      name: string;
      entry: string;
      hasSchema: boolean;
      observedConfidentiality: readonly unknown[];
    }
  >();

  function addCellEntry(
    name: string,
    cell: unknown,
  ): void {
    const resolvedCell = resolveContextCellRef(cell);
    if (!resolvedCell) {
      throw new Error(`Context entry "${name}" is not a cell`);
    }
    const concreteCell = resolvedCell;
    const link = concreteCell.getAsNormalizedFullLink();
    const path = createLLMFriendlyLink(link, space);
    const schemaInfo = getCellSchema(concreteCell);

    // Deduplicate: skip if we already have an entry with schema for this path
    const existing = seenPaths.get(path);
    if (existing?.hasSchema && !schemaInfo) return;

    let entry = `## ${name} (${path})\n`;
    let observedConfidentiality: readonly unknown[] = [];

    if (schemaInfo !== undefined) {
      const schemaStr = getSchemaTypeString(schemaInfo);
      entry += `- Schema: \`\`\`typescript\n${schemaStr}\n\`\`\`\n`;
    }

    try {
      // Declared-empty bound (public only) must take the observation-aware
      // read path too — see the cellsDocs guard above (#3993 review).
      let value = observationMaxConfidentiality !== undefined
        ? readCellValueForObservation(concreteCell)
        : concreteCell.get() ?? concreteCell.getRaw();
      if (
        value === undefined &&
        isRecord(schemaInfo) &&
        Object.hasOwn(schemaInfo, "default")
      ) {
        value = (schemaInfo as Record<string, unknown>).default;
      }
      const serialized = serializeForLLMObservation({
        value,
        schema: schemaInfo,
        seen: new Set(),
        contextSpace: space,
        rootLink: link,
        labelView: observationMaxConfidentiality
          ? cfcLabelViewForCellFailClosed(concreteCell)
          : undefined,
        observationMaxConfidentiality,
      });
      observedConfidentiality = serialized.observedConfidentiality;

      let valueJson = JSON.stringify(serialized.value ?? null, null, 2);

      const MAX_VALUE_LENGTH = 2000;
      if (valueJson.length > MAX_VALUE_LENGTH) {
        valueJson = valueJson.substring(0, MAX_VALUE_LENGTH) +
          "\n... (truncated)";
      }

      entry += `- Current Value: \`\`\`json\n${valueJson}\n\`\`\`\n`;
    } catch (e) {
      logger.warn(
        "llm",
        `Failed to serialize value for cell ${name}:`,
        e,
      );
      entry += `- Current Value: (unable to serialize)\n`;
    }

    seenPaths.set(path, {
      name,
      entry,
      hasSchema: schemaInfo !== undefined,
      observedConfidentiality,
    });
  }

  // First, process context cells (if provided)
  if (context) {
    for (const [name, cell] of Object.entries(context)) {
      try {
        addCellEntry(name, cell);
      } catch (e) {
        logger.warn("llm", `Failed to document context cell ${name}:`, e);
      }
    }
  }

  // Then, process pinned cells (may override context entries if they have schema)
  const currentPinnedCells = pinnedCells.get() || [];
  for (const pinnedCell of currentPinnedCells) {
    try {
      // Parse the path using the same parser as read/run tools
      const link = parseLLMFriendlyLink(pinnedCell.path, space);

      // Get cell from link
      const cell = runtime.getCellFromLink(link);
      if (!cell) {
        logger.warn(
          "llm",
          `Could not resolve pinned cell ${pinnedCell.path} to a cell`,
        );
        continue;
      }

      addCellEntry(pinnedCell.name, cell);
    } catch (e) {
      logger.warn(
        "llm",
        `Failed to document pinned cell ${pinnedCell.name} (${pinnedCell.path}):`,
        e,
      );
    }
  }

  if (seenPaths.size === 0) {
    return {
      docs: "",
      observedConfidentiality: [],
    };
  }

  const entries = [...seenPaths.values()].map((v) => v.entry);
  return {
    docs: "\n\n# Available Cells\n\n" + entries.join("\n\n"),
    observedConfidentiality: joinCfcObservedConfidentiality(
      [...seenPaths.values()].map((value) => value.observedConfidentiality),
    ),
  };
}

function buildAvailableCellsDocumentation(
  runtime: Runtime,
  space: MemorySpace,
  context: Record<string, unknown> | undefined,
  pinnedCells: Cell<PinnedCell[]>,
  observationMaxConfidentiality?: readonly unknown[],
): string {
  return buildAvailableCellsDocumentationWithObservation(
    runtime,
    space,
    context,
    pinnedCells,
    observationMaxConfidentiality,
  ).docs;
}

function getObservedDialogMessages(
  messagesCell: Cell<any>,
  messages: readonly BuiltInLLMMessage[],
  messageObservations: DialogMessageObservationMap,
): {
  messages: readonly BuiltInLLMMessage[];
  observedConfidentiality: readonly unknown[];
} {
  const labelView = cfcLabelViewForCellFailClosed(messagesCell);
  const observedConfidentiality = joinCfcObservedConfidentiality(
    messages.map((_message, index) => {
      const stored = messageObservations[index.toString()];
      if (Array.isArray(stored)) {
        return stored;
      }
      return cfcConfidentialityForObservationNode({
        labelView,
        logicalPath: [index.toString()],
      });
    }),
  );

  return { messages, observedConfidentiality };
}

function mergeDialogMessageObservations(
  current: DialogMessageObservationMap | undefined,
  updates: Array<
    { index: number; observedConfidentiality: readonly unknown[] }
  >,
): DialogMessageObservationMap {
  const merged: Record<string, unknown[]> = {
    ...(current ?? {}),
  };
  for (const update of updates) {
    const key = update.index.toString();
    merged[key] = uniqueCfcAtoms([
      ...(merged[key] ?? []),
      ...(update.observedConfidentiality ?? []),
    ]) as unknown[];
  }
  return merged;
}

function recordDialogMessageObservations(
  tx: IExtendedStorageTransaction,
  internal: Cell<Schema<typeof internalSchema>>,
  updates: Array<
    { index: number; observedConfidentiality: readonly unknown[] }
  >,
): void {
  if (updates.length === 0) {
    return;
  }
  const current = internal.withTx(tx).key("messageObservations").get() as
    | DialogMessageObservationMap
    | undefined;
  internal.withTx(tx).key("messageObservations").set(
    mergeDialogMessageObservations(current, updates),
  );
}

// Discriminated union separating external tools from built-in tools
type ResolvedToolCall =
  // Tools provided from outside (by the pattern calling llm-dialog)
  | {
    type: "external";
    call: LLMToolCall;
    toolDef: Cell<Schema<typeof LLMToolSchema>>;
  }
  // Built-in tools provided by llm-dialog itself
  | { type: "pin"; call: LLMToolCall; path: string; name: string }
  | { type: "unpin"; call: LLMToolCall; path: string }
  | { type: "schema"; call: LLMToolCall; cellRef: Cell<any> }
  | { type: "read"; call: LLMToolCall; cellRef: Cell<any> }
  | { type: "presentResult"; call: LLMToolCall; result: unknown }
  | {
    type: "updateArgument";
    call: LLMToolCall;
    cellRef: Cell<any>;
    updates: Record<string, unknown>;
  }
  | {
    type: "invoke";
    call: LLMToolCall;
    // Implementation details for how to invoke the target
    toolDef?: Cell<unknown>;
    handler?: Stream<any>;
    piece?: Cell<any>;
  };

function resolveToolCall(
  runtime: Runtime,
  space: MemorySpace,
  toolCallPart: BuiltInLLMToolCallPart,
  catalog: ToolCatalog,
): ResolvedToolCall {
  const name = toolCallPart.toolName;
  const id = toolCallPart.toolCallId;
  const externalTool = catalog.dynamicToolCells.get(name);
  if (externalTool) {
    return {
      type: "external",
      toolDef: externalTool,
      call: { id, name, input: toolCallPart.input },
    };
  }

  if (
    name === READ_TOOL_NAME || name === INVOKE_TOOL_NAME ||
    name === SCHEMA_TOOL_NAME || name === PIN_TOOL_NAME ||
    name === UNPIN_TOOL_NAME || name === PRESENT_RESULT_TOOL_NAME ||
    name === UPDATE_ARGUMENT_TOOL_NAME
  ) {
    // Handle pin
    if (name === PIN_TOOL_NAME) {
      const path = extractStringField(
        toolCallPart.input,
        "path",
        "/of:bafyabc123",
      );
      const pinnedCellName = extractStringField(
        toolCallPart.input,
        "name",
        "My Cell",
      );
      return {
        type: "pin",
        call: { id, name, input: { path, name: pinnedCellName } },
        path,
        name: pinnedCellName,
      };
    }

    // Handle unpin
    if (name === UNPIN_TOOL_NAME) {
      const path = extractStringField(
        toolCallPart.input,
        "path",
        "/of:bafyabc123",
      );
      return {
        type: "unpin",
        call: { id, name, input: { path } },
        path,
      };
    }

    // Handle presentResult (builtin tool for generateObject)
    if (name === PRESENT_RESULT_TOOL_NAME) {
      return {
        type: "presentResult",
        call: { id, name, input: toolCallPart.input },
        result: toolCallPart.input,
      };
    }

    // Handle updateArgument
    if (name === UPDATE_ARGUMENT_TOOL_NAME) {
      const target = extractStringField(
        toolCallPart.input,
        "path",
        "/of:bafyabc123",
      );
      const link = parseLLMFriendlyLink(target, space);
      const cellRef = runtime.getCellFromLink(link);

      const updates = toolCallPart.input?.updates;
      if (!updates || typeof updates !== "object") {
        throw new Error(
          "updates must be an object with field names and values",
        );
      }

      return {
        type: "updateArgument",
        cellRef,
        call: { id, name, input: { path: target, updates } },
        updates: updates as Record<string, unknown>,
      };
    }

    const target = extractStringField(
      toolCallPart.input,
      "path",
      "/of:bafyabc123/path",
    );

    const link = parseLLMFriendlyLink(target, space);
    const cellRef = runtime.getCellFromLink(link);

    if (name === SCHEMA_TOOL_NAME) {
      const pieceName = extractStringField(
        toolCallPart.input,
        "path",
        "/of:bafyabc123/path",
      );
      return {
        type: "schema",
        cellRef,
        call: { id, name, input: { piece: pieceName } },
      };
    }

    if (name === READ_TOOL_NAME) {
      // Get cell reference from the link - works for any valid handle
      if (isStream(cellRef.resolveAsCell())) {
        throw new Error(`Path resolves to a handler; use invoke() instead.`);
      }

      return {
        type: "read",
        cellRef,
        call: { id, name, input: { path: target } },
      };
    }

    if (isStream(cellRef.resolveAsCell())) {
      return {
        type: "invoke",
        handler: cellRef as unknown as Stream<any>,
        call: {
          id,
          name,
          input: extractRunArguments(toolCallPart.input),
        },
      };
    }

    const toolValue = cellRef.getRaw();
    if (factoryToolSelection(cellRef as Cell<unknown>, toolValue)) {
      return {
        type: "invoke",
        toolDef: cellRef as Cell<unknown>,
        call: {
          id,
          name,
          input: extractRunArguments(toolCallPart.input),
        },
      };
    }

    throw new Error(
      "target does not resolve to a handler stream or PatternFactory.",
    );
  }

  throw new Error("Tool has neither pattern nor handler");
}

function extractToolCallParts(
  content: BuiltInLLMMessage["content"],
): BuiltInLLMToolCallPart[] {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is BuiltInLLMToolCallPart =>
    (part as BuiltInLLMToolCallPart).type === "tool-call"
  );
}

/**
 * Validates whether message content is non-empty and valid for the Anthropic API.
 * Returns true if the content contains at least one non-empty text block or tool call.
 */
function hasValidContent(content: BuiltInLLMMessage["content"]): boolean {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }

  if (Array.isArray(content)) {
    return content.some((part) => {
      if (part.type === "tool-call" || part.type === "tool-result") {
        return true;
      }
      if (part.type === "text") {
        return (part as BuiltInLLMTextPart).text?.trim().length > 0;
      }
      return false;
    });
  }

  return false;
}

function buildAssistantMessage(
  content: BuiltInLLMMessage["content"],
  toolCallParts: BuiltInLLMToolCallPart[],
): BuiltInLLMMessage {
  const assistantContentParts: Array<
    BuiltInLLMTextPart | BuiltInLLMToolCallPart
  > = [];

  if (typeof content === "string" && content) {
    assistantContentParts.push({
      type: "text",
      text: content,
    });
  } else if (Array.isArray(content)) {
    assistantContentParts.push(
      ...content.filter((part) => part.type === "text") as BuiltInLLMTextPart[],
    );
  }

  assistantContentParts.push(...toolCallParts);

  return {
    role: "assistant",
    content: assistantContentParts,
  };
}

type ToolCallExecutionResult = {
  id: string;
  toolName: string;
  result?: any;
  error?: string;
  observedConfidentiality?: readonly unknown[];
};

/**
 * Fold the deployment's per-sink confidentiality ceiling into a
 * pattern-supplied observation bound, yielding the EFFECTIVE bound the LLM
 * builtins enforce while serializing reads for the model.
 *
 * The pattern-supplied `observationMaxConfidentiality` is adversary-controlled
 * in the CFC threat model (and unbounded when omitted), so a deployment that
 * declares a ceiling for this sink must additionally bound every value that can
 * reach the model — including the post-commit tool-loop reads, which carry no
 * `sink-request` input and so are never gated by `prepareBoundaryCommit`
 * (#3993 review). The meet (`pattern ∧ deployment`) admits exactly the values
 * both allowlists admit: pattern omitted → deployment ceiling alone; sink has no
 * deployment ceiling → pattern bound alone (unchanged behavior); declared empty
 * deployment ceiling → public-only regardless of the pattern bound.
 */
function effectiveObservationCeiling(
  runtime: Runtime,
  sink: string,
  patternBound: readonly unknown[] | undefined,
): readonly unknown[] | undefined {
  const ceilings = runtime.cfcSinkMaxConfidentiality;
  // Object.hasOwn guard: the sink name is a runner-controlled literal today, but
  // a name colliding with an Object.prototype member must resolve to "no
  // ceiling", not an inherited function.
  const deploymentCeiling = Object.hasOwn(ceilings, sink)
    ? ceilings[sink]
    : undefined;
  return meetCfcObservationCeilings(patternBound, deploymentCeiling);
}

function toolAllowsObservedConfidentiality(
  toolCatalog: ToolCatalog,
  toolName: string,
  observedConfidentiality: readonly unknown[] | undefined,
): boolean {
  if (!observedConfidentiality || observedConfidentiality.length === 0) {
    return true;
  }

  const toolSchema = toolCatalog.llmTools[toolName]?.inputSchema;
  const maxConfidentiality = isRecord(toolSchema) && isRecord(toolSchema.ifc)
    ? toolSchema.ifc.maxConfidentiality
    : undefined;
  // A non-array ceiling means none was declared. A declared (even empty) ceiling
  // is enforced: an empty array is "public only". Delegate to
  // cfcObservationFitsCeiling rather than special-casing empty as allow-all,
  // which would skip the empty-ceiling protection (review follow-up to W0.7).
  if (!Array.isArray(maxConfidentiality)) {
    return true;
  }

  return cfcObservationFitsCeiling(observedConfidentiality, maxConfidentiality);
}

// The integrity a model-supplied tool-input value carries (Epic D2). A value
// the model passed BY REFERENCE (a `{"@link":…}` to a cell) carries that
// cell's stored integrity; a value the model emitted as a plain literal
// carries none — it is model output (stamped at most `LlmDerived`, D1), which
// by construction lacks any endorsement family. `traverseAndCellify` is the
// same resolver the invoke path uses, so a reference is read identically here.
function toolInputValueIntegrity(
  runtime: Runtime,
  space: MemorySpace,
  value: unknown,
): unknown[] {
  const cellified = traverseAndCellify(runtime, space, value);
  if (!isCell(cellified)) {
    return [];
  }
  const view = cfcLabelViewForCellFailClosed(cellified);
  return (view?.entries ?? []).flatMap((entry) => entry.label.integrity ?? []);
}

// Walk a tool's `inputSchema` for fields declaring `ifc.requiredIntegrity` and
// verify the model-supplied value at each carries every required atom (Epic D2,
// docs/history/specs/cfc-trusted-agent-tool-integrity.md piece A/C). A control/routing
// field (e.g. `sendMail.recipient`) declaring the agent-kernel integrity floor
// can only be satisfied by an integrity-bearing reference the model passed, not
// by a string it copied out of a hostile briefing — that fails closed. Returns
// the first failing field's reason, or undefined if all floors are satisfied.
function toolInputRequiredIntegrityFailure(
  runtime: Runtime,
  space: MemorySpace,
  schema: unknown,
  value: unknown,
  path: string,
  trust: CfcFloorTrustContext,
): string | undefined {
  if (!isRecord(schema)) {
    return undefined;
  }
  const ifc = schema.ifc;
  if (isRecord(ifc) && Array.isArray(ifc.requiredIntegrity)) {
    const required = ifc.requiredIntegrity;
    if (required.length > 0) {
      const integrity = toolInputValueIntegrity(runtime, space, value);
      // The single shared floor predicate (observation.ts) — the same
      // membership the commit-boundary gates use. `trust` carries the acting
      // principal's closure so a CONCEPT-valued floor accepts any concrete
      // atom above the concept (D5), consistently with the read/write gates.
      const satisfied = cfcIntegritySatisfiesFloor(integrity, required, trust);
      if (!satisfied) {
        return `field "${path || "(root)"}" requires integrity the ` +
          `model-supplied value does not carry (pass an integrity-bearing ` +
          `reference, not a literal)`;
      }
    }
  }
  if (isRecord(schema.properties)) {
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      // Only gate fields the model actually supplied. An absent (e.g. optional)
      // field carries no value to gate; treating it as `undefined` would fail
      // an optional field's floor and over-block the call. A required field the
      // model omitted is a structural error handled by ordinary input
      // validation, not a floor bypass — there is no injected value to gate.
      if (!isRecord(value) || !Object.hasOwn(value, key)) {
        continue;
      }
      const failure = toolInputRequiredIntegrityFailure(
        runtime,
        space,
        childSchema,
        value[key],
        path ? `${path}.${key}` : key,
        trust,
      );
      if (failure !== undefined) {
        return failure;
      }
    }
  }
  // Array items: a floor under `items` gates every model-supplied element
  // (e.g. `recipients: { items: { ifc: { requiredIntegrity } } }`).
  if (isRecord(schema.items) && Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const failure = toolInputRequiredIntegrityFailure(
        runtime,
        space,
        schema.items,
        value[index],
        `${path}[${index}]`,
        trust,
      );
      if (failure !== undefined) {
        return failure;
      }
    }
  }
  // Compound schemas: mirror the IFC schema walker — descend into every
  // branch. For a required-integrity FLOOR, requiring the union across
  // branches is the fail-safe (over-require) direction, matching walkIfcSchema.
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        const failure = toolInputRequiredIntegrityFailure(
          runtime,
          space,
          branch,
          value,
          path,
          trust,
        );
        if (failure !== undefined) {
          return failure;
        }
      }
    }
  }
  return undefined;
}

// The (schema, input) the D2 integrity gate checks for a resolved tool call.
// For the generic `invoke` builtin the target is the resolved handler /
// pattern, whose ARGUMENT schema carries the requiredIntegrity floors — its
// own `path`/`args` builtin schema declares none — and the value is the
// resolved args (path stripped). External tools keep the catalog input schema
// and the raw model input. Other management builtins (pin/read/schema/…) have
// fixed floor-free schemas, so their check is a no-op.
function integrityGateTarget(
  resolved: ResolvedToolCall,
  part: BuiltInLLMToolCallPart,
  toolCatalog: ToolCatalog,
): { schema: unknown; input: unknown } {
  if (resolved.type === "invoke") {
    const selected = resolved.toolDef === undefined
      ? undefined
      : factoryToolSelection(resolved.toolDef, resolved.toolDef.getRaw());
    const state = selected !== undefined &&
        isAdmittedFabricFactory(selected.selection)
      ? factoryStateOf(selected.selection)
      : undefined;
    const schema = state?.kind === "pattern"
      ? state.argumentSchema
      : (resolved.handler as unknown as { schema?: unknown } | undefined)
        ?.schema;
    return { schema, input: resolved.call.input };
  }
  return {
    schema: toolCatalog.llmTools[part.toolName]?.inputSchema,
    input: part.input,
  };
}

async function executeToolCalls(
  runtime: Runtime,
  space: MemorySpace,
  toolCatalog: ToolCatalog,
  toolCallParts: BuiltInLLMToolCallPart[],
  pinnedCells?: Cell<PinnedCell[]>,
  observedConfidentiality?: readonly unknown[],
  observationMaxConfidentiality?: readonly unknown[],
): Promise<ToolCallExecutionResult[]> {
  const results: ToolCallExecutionResult[] = [];
  for (const part of toolCallParts) {
    try {
      if (
        !toolAllowsObservedConfidentiality(
          toolCatalog,
          part.toolName,
          observedConfidentiality,
        )
      ) {
        results.push({
          id: part.toolCallId,
          toolName: part.toolName,
          error:
            `Tool call denied: observed confidentiality exceeds maxConfidentiality for ${part.toolName}`,
        });
        continue;
      }

      const resolved = resolveToolCall(runtime, space, part, toolCatalog);

      // Epic D2: gate the model-supplied input against the TARGET's
      // requiredIntegrity floors before the handler runs, so an injected
      // control-field value (e.g. a recipient copied from a hostile briefing)
      // is refused rather than executed. Runs AFTER resolveToolCall so the
      // generic `invoke` builtin is checked against the resolved handler /
      // pattern argument schema (its own path/args schema declares no floors),
      // closing the invoke bypass. Only DENIES in enforcing modes — observe is
      // diagnostic and must not block — and is a no-op for tools declaring no
      // requiredIntegrity.
      if (
        cfcEnforcementStrictness(runtime.cfcEnforcementMode) >=
          CFC_ENFORCING_STRICTNESS
      ) {
        const gate = integrityGateTarget(resolved, part, toolCatalog);
        // Acting principal's trust closure for CONCEPT-valued floors (D5),
        // built from the runtime's frozen trust config + acting principal —
        // the same inputs the tx-side gates use via cfcFloorTrustContext.
        const trust: CfcFloorTrustContext = {
          trustResolver: createTrustResolver(runtime.cfcTrustConfig),
          actingPrincipal: runtime.trustSnapshotProvider()?.actingPrincipal,
        };
        const integrityFailure = toolInputRequiredIntegrityFailure(
          runtime,
          space,
          gate.schema,
          gate.input,
          "",
          trust,
        );
        if (integrityFailure !== undefined) {
          results.push({
            id: part.toolCallId,
            toolName: part.toolName,
            error: `Tool call denied: ${integrityFailure}`,
          });
          continue;
        }
      }

      const resultValue = await invokeToolCall(
        runtime,
        space,
        resolved,
        toolCatalog,
        pinnedCells,
        observationMaxConfidentiality,
      );
      results.push({
        id: part.toolCallId,
        toolName: part.toolName,
        result: resultValue.result,
        observedConfidentiality: resultValue.observedConfidentiality,
      });
    } catch (error) {
      console.error(`Tool ${part.toolName} failed:`, error);
      results.push({
        id: part.toolCallId,
        toolName: part.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function createToolResultMessages(
  results: ToolCallExecutionResult[],
): BuiltInLLMMessage[] {
  return results.map((toolResult) => {
    // Ensure output is never undefined/null - Anthropic API requires valid tool_result
    // for every tool_use, even if the tool returns nothing
    let output: any;
    if (toolResult.error) {
      output = { type: "error-text", value: toolResult.error };
    } else if (toolResult.result === undefined || toolResult.result === null) {
      // Tool returned nothing - use explicit null value
      output = { type: "json", value: null };
    } else {
      output = toolResult.result;
    }

    return {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: toolResult.id,
        toolName: toolResult.toolName || "unknown",
        output,
      }],
    };
  });
}

export const llmDialogTestHelpers = {
  getCellSchema,
  parseLLMFriendlyLink,
  traverseAndSerialize,
  serializeForLLMObservation,
  traverseAndCellify,
  extractStringField,
  extractRunArguments,
  extractToolCallParts,
  buildAssistantMessage,
  createToolResultMessages,
  hasValidContent,
  PRESENT_RESULT_TOOL_NAME,
  simplifySchemaForContext,
  prepareSchemaForLLM,
  resolveRefsForLLM,
  toolAllowsObservedConfidentiality,
};

/**
 * Shared tool execution utilities for use by other LLM built-ins (llm, generateText).
 * These functions handle tool catalog building, tool call resolution, and execution.
 */
export const llmToolExecutionHelpers = {
  PRESENT_RESULT_TOOL_NAME,
  buildToolCatalog,
  executeToolCalls,
  extractToolCallParts,
  buildAssistantMessage,
  createToolResultMessages,
  hasValidContent,
  buildAvailableCellsDocumentation,
  buildAvailableCellsDocumentationWithObservation,
  traverseAndCellify,
  prepareSchemaForLLM,
  serializeForLLMObservation,
  toolAllowsObservedConfidentiality,
  effectiveObservationCeiling,
  stripFrameworkProvidedFields,
};

/**
 * Performs a mutation on the storage if the pending flag is active and the
 * request ID matches. This ensures the pending flag has final say over whether
 * the LLM continues generating.
 *
 * @param runtime - The runtime instance
 * @param pending - Cell containing the pending state
 * @param internal - Cell containing the internal state
 * @param requestId - The request ID
 * @param action - The mutation action to perform if pending is true
 * @returns true if the action was performed, false otherwise
 */
async function safelyPerformUpdate(
  runtime: Runtime,
  pending: Cell<boolean>,
  internal: Cell<Schema<typeof internalSchema>>,
  requestId: string,
  action: (tx: IExtendedStorageTransaction) => void,
) {
  const { ok } = await runtime.editWithRetry((tx) => {
    if (
      pending.withTx(tx).get() &&
      internal.withTx(tx).key("requestId").get() === requestId
    ) {
      action(tx);
      internal.withTx(tx).key("lastActivity").set(Date.now());
      return true;
    } else {
      // We might have flagged success as true in a previous call, but if the
      // retry flow lands us here, it means it wasn't written and that now
      // the requestId has changed.
      return false;
    }
  });

  return !!ok;
}

/**
 * Handles the pin tool call.
 */
function handlePin(
  runtime: Runtime,
  resolved: ResolvedToolCall & { type: "pin" },
  pinnedCells: Cell<PinnedCell[]>,
): { type: string; value: any } {
  const current = pinnedCells.get() || [];

  // Check if already pinned
  if (current.some((p) => p.path === resolved.path)) {
    return {
      type: "json",
      value: { success: false, message: "Already pinned" },
    };
  }

  // Add new pinned cell using a transaction
  runtime.editWithRetry((tx) => {
    const currentInTx = pinnedCells.withTx(tx).get() || [];
    pinnedCells.withTx(tx).set([
      ...currentInTx,
      { path: resolved.path, name: resolved.name },
    ]);
  });

  return { type: "json", value: { success: true } };
}

/**
 * Handles the unpin tool call.
 */
function handleUnpin(
  runtime: Runtime,
  resolved: ResolvedToolCall & { type: "unpin" },
  pinnedCells: Cell<PinnedCell[]>,
): { type: string; value: any } {
  const current = pinnedCells.get() || [];
  const filtered = current.filter((p) => p.path !== resolved.path);

  if (filtered.length === current.length) {
    return {
      type: "json",
      value: { success: false, message: "Not found" },
    };
  }

  // Remove pinned cell using a transaction
  runtime.editWithRetry((tx) => {
    const currentInTx = pinnedCells.withTx(tx).get() || [];
    const filteredInTx = currentInTx.filter((p) => p.path !== resolved.path);
    pinnedCells.withTx(tx).set(filteredInTx);
  });

  return { type: "json", value: { success: true } };
}

/**
 * Handles the schema tool call.
 */
function handleSchema(
  resolved: ResolvedToolCall & { type: "schema" },
): { type: string; value: any } {
  const schema = getCellSchema(resolved.cellRef) ?? {};
  // Deep-frozen clone: `schema` may be a query-result proxy, so de-proxy and
  // preserve `FabricValue` leaves rather than mangling them through JSON. The
  // result is a read-only `"json"` tool payload, so freezing is fine.
  const value = toDeepFrozenSchema(schema);
  return { type: "json", value };
}

/**
 * Handles the read tool call.
 */
async function handleRead(
  resolved: ResolvedToolCall & { type: "read" },
  space: MemorySpace,
  observationMaxConfidentiality?: readonly unknown[],
): Promise<
  {
    result: { type: string; value: unknown };
    observedConfidentiality: readonly unknown[];
  }
> {
  let cell = resolved.cellRef.resolveAsCell().asSchemaFromLinks();
  await cell.pull();
  let schema = cell.schema ?? getCellSchema(cell);
  if (!cell.schema && schema) {
    cell = cell.asSchema(schema);
  }
  schema = cell.schema ?? schema;
  let value = schema ? cell.get() : cell.getRaw();
  if (value === undefined) {
    // If our cell is an intermediate with a parent result, follow that
    const parentLink = getMetaLink(cell, "result");
    if (parentLink !== undefined) {
      const parentCell = cell.runtime.getCellFromLink(parentLink);
      await parentCell.pull();
      schema = parentCell.schema ?? getCellSchema(parentCell);
      cell = schema ? parentCell.asSchema(schema) : parentCell;
      value = schema ? cell.get() : cell.getRaw();
    }
  }
  const serialized = serializeForLLMObservation({
    value,
    schema,
    seen: new Set(),
    contextSpace: space,
    rootLink: cell.getAsNormalizedFullLink(),
    labelView: cfcLabelViewForCellFailClosed(cell),
    observationMaxConfidentiality,
  });

  // Handle undefined by returning null (valid JSON) instead
  return {
    result: {
      type: "json",
      value: serialized.value ?? null,
      ...(schema !== undefined && { schema }),
    },
    observedConfidentiality: serialized.observedConfidentiality,
  };
}

/**
 * Handles the update Argument tool call.
 */
function handleUpdateArgument(
  runtime: Runtime,
  resolved: ResolvedToolCall & { type: "updateArgument" },
): { type: string; value: any } {
  const cell = resolved.cellRef;
  const updates = resolved.updates;

  const argumentLink = getMetaLink(cell, "argument");
  if (argumentLink === undefined) {
    throw new Error(
      "Target is not a pattern instance - no argument cell found. " +
        "updateArgument only works with running patterns (e.g., from invoke() or attached patterns).",
    );
  }

  // Access the argument cell
  const argumentCell = runtime.getCellFromLink(argumentLink);
  const cellifiedValue = traverseAndCellify(
    runtime,
    argumentCell.space,
    updates,
  );

  // Apply updates to argument fields
  runtime.editWithRetry((tx) => {
    if (
      isRecord(cellifiedValue) && !Array.isArray(cellifiedValue) &&
      !isCell(cellifiedValue)
    ) {
      argumentCell.withTx(tx).update(cellifiedValue);
    } else {
      argumentCell.withTx(tx).set(cellifiedValue);
    }
  });

  return {
    type: "json",
    value: {
      success: true,
      message: "Arguments updated. Pattern will re-execute automatically.",
    },
  };
}

function applyFrameworkProvidedFactoryInputs(
  args: Record<string, unknown>,
  paths: readonly (readonly string[])[],
  identityCell: Cell<any> | undefined,
): Record<string, unknown> {
  if (paths.length === 0) return args;
  const ref = identityCell ? getEntityId(identityCell) : undefined;
  const entityId = ref && isEntityRef(ref) ? entityRefToString(ref) : undefined;
  return applyFrameworkProvidedInputs(args, paths, entityId);
}

/**
 * Handles the invoke tool call (both pattern and handler execution).
 */
async function handleInvoke(
  runtime: Runtime,
  space: MemorySpace,
  resolved: ResolvedToolCall,
  observationMaxConfidentiality?: readonly unknown[],
): Promise<{
  result: { type: string; value: any };
  observedConfidentiality: readonly unknown[];
}> {
  const toolCall = resolved.call;

  // Resolve the selected first-class factory or handler.
  let pattern: Readonly<Pattern> | undefined;
  let handler: any;
  let useResultSchemaForObservation = false;
  let frameworkProvidedPaths: readonly (readonly string[])[] = [];
  // The cell the tool was resolved from. Its content-addressed entity id is the
  // running instance's identity, used to auto-provide a per-instance sandbox id.
  let identityCell: Cell<any> | undefined;

  const toolDef = resolved.type === "external"
    ? resolved.toolDef as unknown as Cell<unknown>
    : resolved.type === "invoke"
    ? resolved.toolDef
    : undefined;
  if (toolDef !== undefined) {
    const toolValue = toolDef.getRaw();
    const canonical = await prepareFactoryTool(
      runtime,
      toolDef,
      toolValue,
    );
    if (canonical) {
      pattern = canonical.factory;
      frameworkProvidedPaths = getFrameworkProvidedPaths(canonical.factory);
      useResultSchemaForObservation = Boolean(
        canonical.metadata.useResultSchemaForObservation,
      );
    } else {
      handler = resolved.type === "external"
        ? resolved.toolDef.key("handler")
        : resolved.type === "invoke"
        ? resolved.handler
        : undefined;
      useResultSchemaForObservation = Boolean(
        resolved.type === "external"
          ? resolved.toolDef.key("useResultSchemaForObservation").get()
          : false,
      );
    }
    identityCell = toolDef;
  } else if (resolved.type === "invoke") {
    handler = resolved.handler;
  }

  const input = traverseAndCellify(runtime, space, toolCall.input) as object;
  let invocationArgs = {
    ...input as Record<string, unknown>,
  };
  if (pattern !== undefined) {
    invocationArgs = applyFrameworkProvidedFactoryInputs(
      invocationArgs,
      frameworkProvidedPaths,
      identityCell,
    );
  }

  const { resolve, promise } = Promise.withResolvers<any>();

  // Create result cell reference that will be set in the transaction
  let result: Cell<any> = null as any;

  await runtime.editWithRetry((tx) => {
    // Create the result cell within the transaction context
    result = runtime.getCell<any>(
      space,
      toolCall.id,
      pattern ? pattern.resultSchema : undefined,
      tx,
    );

    if (pattern) {
      runtime.run(tx, pattern, invocationArgs, result);
    } else if (handler) {
      handler.withTx(tx).send({
        ...input,
        result, // doesn't HAVE to be used, but can be
      }, (completedTx: IExtendedStorageTransaction) => {
        const summary = formatTransactionSummary(completedTx, space);
        const value = result.withTx(completedTx);
        resolve({ value, summary });
      });
    } else {
      throw new Error("Tool has neither pattern nor handler");
    }
  });

  await runtime.idle();

  // Wait for the pattern/handler to complete and write the result
  const cancel = result.sink((r) => {
    r !== undefined && resolve(r);
  });

  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("Tool call timed out"));
    }, TOOL_CALL_TIMEOUT);
  }).then(() => {
    throw new Error("Tool call timed out");
  });

  try {
    await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
    cancel();
  }

  // Get the actual entity ID from the result cell
  const resultLink = createLLMFriendlyLink(
    result.getAsNormalizedFullLink(),
    space,
  );

  const resultSchema = getCellSchema(result);

  // Patterns always write to the result cell, so always return the link
  if (pattern) {
    const concreteResult = result.resolveAsCell();
    const concreteResultSchema = getCellSchema(concreteResult) ?? resultSchema;
    const serialized = serializeForLLMObservation({
      value: concreteResult.get(),
      schema: concreteResultSchema,
      seen: new Set(),
      contextSpace: space,
      rootLink: concreteResult.getAsNormalizedFullLink(),
      labelView: useResultSchemaForObservation
        ? undefined
        : cfcLabelViewForCellFailClosed(concreteResult),
      observationMaxConfidentiality,
    });
    return {
      result: {
        type: "json",
        value: {
          "@resultLocation": resultLink,
          result: serialized.value,
          schema: concreteResultSchema,
        },
      },
      observedConfidentiality: serialized.observedConfidentiality,
    };
  }

  // Handlers may or may not write to the result cell
  // Only return a link if the handler actually wrote something
  if (handler) {
    const resultValue = result.get();

    if (resultValue !== undefined && resultValue !== null) {
      const serialized = serializeForLLMObservation({
        value: resultValue,
        schema: resultSchema,
        seen: new Set(),
        contextSpace: space,
        rootLink: result.getAsNormalizedFullLink(),
        labelView: cfcLabelViewForCellFailClosed(result),
        observationMaxConfidentiality,
      });
      return {
        result: {
          type: "json",
          value: {
            "@resultLocation": resultLink,
            result: serialized.value,
            schema: resultSchema,
          },
        },
        observedConfidentiality: serialized.observedConfidentiality,
      };
    }
    // Handler didn't write anything, return null
    return {
      result: { type: "json", value: null },
      observedConfidentiality: [],
    };
  }

  throw new Error("Tool has neither pattern nor handler");
}

/**
 * Executes a tool call by invoking its handler function and returning the
 * result. Creates a new transaction, sends the tool call arguments to the
 * handler, and waits for the result to be available before returning it.
 *
 * @param runtime - The runtime instance for creating transactions and cells
 * @param space - The memory space for the tool execution
 * @param resolved - The resolved tool call containing type and metadata
 * @param catalog - Optional tool catalog for lookups
 * @returns Promise that resolves to the tool execution result
 */
async function invokeToolCall(
  runtime: Runtime,
  space: MemorySpace,
  resolved: ResolvedToolCall,
  _catalog?: ToolCatalog,
  pinnedCells?: Cell<PinnedCell[]>,
  observationMaxConfidentiality?: readonly unknown[],
) {
  // Handle pinned cell tools
  if (resolved.type === "pin") {
    return {
      result: handlePin(runtime, resolved, pinnedCells!),
      observedConfidentiality: [],
    };
  }

  if (resolved.type === "unpin") {
    return {
      result: handleUnpin(runtime, resolved, pinnedCells!),
      observedConfidentiality: [],
    };
  }

  if (resolved.type === "schema") {
    return {
      result: handleSchema(resolved),
      observedConfidentiality: [],
    };
  }

  if (resolved.type === "read") {
    return await handleRead(resolved, space, observationMaxConfidentiality);
  }

  if (resolved.type === "presentResult") {
    // Cellify to get live references, then serialize back to @link for the
    // conversation message. The caller (startRequest) cellifies separately
    // from the raw tool call input to store on the dialog's result cell.
    const cellified = traverseAndCellify(runtime, space, resolved.result);
    return {
      result: {
        type: "json",
        value: traverseAndSerialize(cellified, undefined, new Set(), space),
      },
      observedConfidentiality: [],
    };
  }

  // Handle run-type tools (external, run with pattern/handler)
  if (resolved.type === "updateArgument") {
    return {
      result: handleUpdateArgument(runtime, resolved),
      observedConfidentiality: [],
    };
  }

  // Handle invoke-type tools (external, invoke with pattern/handler)
  return await handleInvoke(
    runtime,
    space,
    resolved,
    observationMaxConfidentiality,
  );
}

/**
 * Run a (tool using) dialog with an LLM.
 *
 * @param messages - list of messages representing the conversation. This is mutated by the internal process.
 * @param model - A doc to store the model to use.
 * @param system - A doc to store the system message.
 * @param stop - A doc to store (optional) stop sequence.
 * @param maxTokens - A doc to store the maximum number of tokens to generate.
 *
 * @returns { pending: boolean, addMessage: (message: BuiltInLLMMessage) => void } - As individual
 *   docs, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function llmDialog(
  inputsCell: Cell<BuiltInLLMParams>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: Runtime, // Runtime will be injected by the registration function
): RawBuiltinResult {
  const inputs = inputsCell.asSchema(LLMParamsSchema);

  // Helper function to create and register handlers
  const createHandler = <T>(
    stream: Stream<T>,
    handler: (tx: IExtendedStorageTransaction, event: T) => void,
  ) => {
    addCancel(
      runtime.scheduler.addEventHandler(handler, parseLink(stream)),
    );
  };

  let cellsInitialized = false;
  let result: Cell<Schema<typeof resultSchema>>;
  let internal: Cell<Schema<typeof internalSchema>>;
  let pinnedCells: Cell<PinnedCell[]>;
  let cellScope: CellScope | undefined;
  let requestId: string | undefined = undefined;
  let abortController: AbortController | undefined = undefined;

  // This is called when the pattern containing this node is being stopped.
  addCancel(() => {
    // Abort the request if it's still pending.
    abortController?.abort("Pattern stopped");

    const tx = runtime.edit();

    // If the pending request is ours, set pending to false and clear the requestId.
    if (internal.withTx(tx).key("requestId").get() === requestId) {
      result.withTx(tx).key("pending").set(false);
      internal.withTx(tx).key("requestId").set("");
    }

    // Since we're aborting, don't retry. If the above fails, it's because the
    // requestId was already changing under us.
    runtime.prepareTxForCommit(tx);
    tx.commit();
  });

  const action: Action = (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    inputs.withTx(tx).get();
    const outputScope = tx.getNarrowestReadScope();

    // Setup cells on first run.
    if (!cellsInitialized || cellScope !== outputScope) {
      // Create result cell. The predictable cause means that it'll map to
      // previously existing results. Note that we might not yet have it loaded
      // and that this function will be called again once the data is loaded
      // (but this if branch will be skipped then).
      const baseResult = runtime.getCell(
        parentCell.space,
        { llmDialog: { result: cause } },
        resultSchema,
        tx,
      );
      result = scopedCell(runtime, tx, baseResult, outputScope);
      result.sync(); // Kick off sync, no need to await

      // Create another cell to store the internal state. This isn't returned to
      // the caller. But again, the predictable cause means all instances tied
      // to the same input cells will coordinate via the same cell.
      const baseInternal = runtime.getCell(
        parentCell.space,
        { llmDialog: { internal: cause } },
        internalSchema,
        tx,
      );
      internal = scopedCell(runtime, tx, baseInternal, outputScope);
      internal.sync(); // Kick off sync, no need to await

      // Create pinnedCells cell to store the internal pinned cells state
      const pinnedCellsSchema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            name: { type: "string" },
          },
          required: ["path", "name"],
        },
      } as const;
      const basePinnedCells = runtime.getCell(
        parentCell.space,
        { llmDialog: { pinnedCells: cause } },
        pinnedCellsSchema,
        tx,
      );
      pinnedCells = scopedCell(runtime, tx, basePinnedCells, outputScope);
      pinnedCells.sync(); // Kick off sync, no need to await

      const pending = result.key("pending");

      // Write the stream markers and initialize pinnedCells as empty array.
      // This write might fail (since the original data wasn't loaded yet), but
      // that's ok, since in that case another instance already wrote these.
      //
      // We are carrying the existing pending state over, in case the result
      // cell was already loaded. We don't want to overwrite it.
      // Stream markers ({$stream: true}) don't match the schema type, so use
      // setRawUntyped to bypass T.
      result.setRawUntyped({
        ...result.getRaw(),
        addMessage: { $stream: true },
        cancelGeneration: { $stream: true },
        pinCell: { $stream: true },
        unpinAllCells: { $stream: true },
        pinnedCells: [],
      } as FabricValue);

      // Declare `addMessage` handler and register
      createHandler<BuiltInLLMMessage>(
        // Cast is necessary as .key doesn't yet correctly handle Stream<>
        result.key("addMessage") as unknown as Stream<BuiltInLLMMessage>,
        (tx: IExtendedStorageTransaction, event: BuiltInLLMMessage) => {
          if (
            pending.withTx(tx).get() && (
              internal.withTx(tx).key("lastActivity").get() >
                Date.now() - REQUEST_TIMEOUT
            )
          ) {
            // For now, let's drop messages added while request is pending for
            // less than five minutes. Add message UI should either be disabled
            // or change the send button to be a stop button.
            return;
          }

          // Before starting request, set pending and append the new message.
          pending.withTx(tx).set(true);
          inputs.key("messages").withTx(tx).push(
            {
              ...event,
              // Add ID manually, as for built-ins this isn't automated
              // TODO(seefeld): Once we have event ids, it should be that.
              [ID]: { llmDialog: { message: cause, id: crypto.randomUUID() } },
              // Cast because we can't yet express ArrayBuffer in JSON Schema
            } as Schema<
              typeof LLMMessageSchema
            >,
          );

          // Set up new request (abort existing ones just in case) by allocating
          // a new request Id and setting up a new abort controller.
          abortController?.abort("New request started");
          abortController = undefined;
          const nextRequestId = crypto.randomUUID();
          requestId = nextRequestId;
          internal.withTx(tx).set({
            requestId: nextRequestId,
            lastActivity: Date.now(),
            messageObservations:
              internal.withTx(tx).key("messageObservations").get() ?? {},
          });

          const capturedRequest = materializeDialogRequestSnapshot(
            runtime,
            parentCell.space,
            inputs,
            pinnedCells,
            tx,
          );
          const requestSnapshot = createFrozenRequestSnapshot({
            ...capturedRequest.llmParams,
            resultSchema: capturedRequest.userResultSchema,
          });

          enqueueSinkRequestPostCommitEffect(
            tx,
            "llmDialog",
            `llmDialog:${nextRequestId}`,
            requestSnapshot,
            "llmDialog-start",
            () => {
              if (requestId !== nextRequestId) {
                return;
              }

              abortController = new AbortController();
              // Track the dialog turn (LLM call + writeback) as async builtin
              // work so `runtime.settled()` wait for the result;
              // `idle()` does not, so the handler never blocks on the LLM call.
              runtime.trackAsyncWork(startRequest(
                runtime,
                parentCell.space,
                cause,
                inputs,
                pending,
                internal,
                pinnedCells,
                result,
                nextRequestId,
                abortController.signal,
                capturedRequest,
              ));
            },
          );
        },
      );

      // Declare `cancelGeneration` handler and register
      createHandler<void>(
        result.key("cancelGeneration") as unknown as Stream<any>,
        (tx: IExtendedStorageTransaction, _event: void) => {
          // Cancel request by setting pending to false. This will trigger the
          // code below to be executed in all tabs.
          pending.withTx(tx).set(false);
        },
      );

      // Declare `pinCell` handler and register
      createHandler<{ path: string; name: string }>(
        result.key("pinCell") as unknown as Stream<
          { path: string; name: string }
        >,
        (
          tx: IExtendedStorageTransaction,
          event: { path: string; name: string },
        ) => {
          const current = pinnedCells.withTx(tx).get() || [];

          // Check if already pinned
          if (current.some((p) => p.path === event.path)) {
            return;
          }

          // Add new pinned cell
          const updated = [
            ...current,
            { path: event.path, name: event.name },
          ];
          pinnedCells.withTx(tx).set(updated);
          // Merge with existing result pins (which include context-derived
          // pins) so we don't clobber them. Deduplicate by path.
          const existingResult = result.withTx(tx).key("pinnedCells").get() ||
            [];
          const existingPaths = new Set(
            existingResult.map((p: any) => p.path),
          );
          if (!existingPaths.has(event.path)) {
            result
              .withTx(tx)
              .key("pinnedCells")
              .set([
                ...existingResult,
                { path: event.path, name: event.name },
              ] as any);
          }
        },
      );

      // Declare `unpinAllCells` handler and register
      createHandler<void>(
        result.key("unpinAllCells") as unknown as Stream<void>,
        (tx: IExtendedStorageTransaction, _event: void) => {
          // Clear user-pinned cells
          const userPaths = new Set(
            (pinnedCells.withTx(tx).get() || []).map(
              (p: PinnedCell) => p.path,
            ),
          );
          pinnedCells.withTx(tx).set([]);
          // Keep context-derived pins in result, remove only user pins
          const existingResult = result.withTx(tx).key("pinnedCells").get() ||
            [];
          result
            .withTx(tx)
            .key("pinnedCells")
            .set(
              existingResult.filter(
                (p: any) => !userPaths.has(p.path),
              ) as any,
            );
        },
      );

      cellsInitialized = true;
      cellScope = outputScope;
    }

    sendResult(tx, result);

    // This will remain the reactive part. It will be called whenever one of the

    // read cells change. This is why it's important to do the read before the
    // "&& requestId" part: Otherwise, we'd run this once without requestId and
    // so read no cells and then this wouldn't be called again.
    //
    // Note: If this were sandboxed code, this part would naturally read this
    // cell as it's the only way to get to requestId, here we are passing it
    // around on the side.

    // Update flattened tools whenever tools change
    // `flattenedTools` is for now just used in the UI, and so we only need
    // inputSchema and description. This makes retrieving the tools much faster.
    const toolsCell = inputs.key("tools").withTx(tx) as Cell<
      Record<string, Schema<typeof LLMToolSchema>>
    >;
    const builtinTools = inputs.key("builtinTools").withTx(tx).get() !== false;
    const flattened = flattenTools(toolsCell, builtinTools);

    // Runtime already makes this a no-op if there are no changes
    result.withTx(tx).key("flattenedTools").set(flattened);

    if (
      (!result.withTx(tx).key("pending").get() ||
        requestId !== internal.withTx(tx).key("requestId").get()) && requestId
    ) {
      // We have a pending request and either something set pending to false or
      // another request started, so we have to abort this one.
      abortController?.abort("Another request started");
      requestId = undefined;
    }
  };

  return { action, isEffect: true };
}

async function startRequest(
  runtime: Runtime,
  space: MemorySpace,
  cause: any,
  inputs: Cell<Schema<typeof LLMParamsSchema>>,
  pending: Cell<boolean>,
  internal: Cell<Schema<typeof internalSchema>>,
  pinnedCells: Cell<PinnedCell[]>,
  result: Cell<Schema<typeof resultSchema>>,
  requestId: string,
  abortSignal: AbortSignal,
  capturedRequest?: DialogRequestSnapshot,
) {
  // Pull input dependencies to ensure they're computed in pull mode
  await inputs.pull();
  await pinnedCells.pull();

  // Also pull individual context cells and pinned cell targets
  const contextCellsForPull = inputs.key("context").get() ?? {};
  for (const cell of Object.values(contextCellsForPull)) {
    await resolveContextCellRef(cell)?.pull();
  }
  const pinnedCellsForPull = pinnedCells.get() ?? [];
  for (const pinnedCell of pinnedCellsForPull) {
    try {
      const link = parseLLMFriendlyLink(pinnedCell.path, space);
      const cell = runtime.getCellFromLink(link);
      if (cell) {
        await cell.resolveAsCell().pull();
      }
    } catch {
      // Ignore errors - cell might not exist
    }
  }

  const { system, maxTokens, model } = inputs.get();
  const queueName = capturedRequest?.queueName ??
    (inputs.key("queue").get() as unknown as string | undefined);
  // The snapshot already carries the deployment-bounded ceiling. When there is
  // no snapshot, fold the deployment llmDialog ceiling in here too so a
  // direct/recovery path can't observe past it (#3993 review).
  const observationMaxConfidentiality = capturedRequest
    ?.observationMaxConfidentiality ??
    effectiveObservationCeiling(
      runtime,
      "llmDialog",
      inputs.key("observationMaxConfidentiality").get() as
        | readonly unknown[]
        | undefined,
    );
  const builtinTools = inputs.key("builtinTools").get() !== false;

  const messagesCell = inputs.key("messages");

  // Epic D1 (docs/history/specs/cfc-trusted-agent-tool-integrity.md piece B): model-
  // produced bytes — assistant content and tool results entering the dialog
  // transcript — are stamped `LlmDerived` at the point they enter the store,
  // so "untrusted model output" is explicit provenance rather than absence of
  // integrity. The stamp rides the item schema's `ifc.addIntegrity`, which
  // persists a labelMap entry on exactly the pushed message; the plain-schema
  // pushes (user messages via `addMessage`, builtin-authored error literals)
  // stay unstamped. The write is attributed to the builtin because
  // `LlmDerived` is a runtime-minted evidence family: the persist-time gate
  // (`gateRuntimeMintedIntegrity`, audit S4) strips it from any other author,
  // which is also what stops pattern code from forging the stamp.
  const pushModelMessages = (
    tx: IExtendedStorageTransaction,
    messages: Schema<typeof LLMMessageSchema>[],
  ) => {
    const startIndex = (messagesCell.withTx(tx).get() as
      | readonly unknown[]
      | undefined)?.length ?? 0;
    messagesCell.withTx(tx).push(...messages);
    if (runtime.cfcEnforcementMode === "disabled") {
      return;
    }
    // Attribute the writes to the builtin: `LlmDerived` is a runtime-minted
    // evidence family, so the persist-time gate (`gateRuntimeMintedIntegrity`,
    // audit S4) admits it only from builtin authors — the same gating that
    // stops pattern code from forging the stamp.
    tx.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: "llmDialog",
    });
    // Record the stamping schema for each pushed message's own entity doc
    // (every model push carries an [ID] sigil, so each message splits into
    // its own doc). The messages link carries its own schema, which wins over
    // an `asSchema` handle inside `push()` (`resolvedLink.schema ?? ...`), so
    // the stamp cannot ride the array handle — instead this mirrors the
    // split-entity idiom in data-updating.ts (`recordRelevantSchemaWrite-
    // PolicyInput` on the child doc), which also marks the transaction
    // CFC-relevant so `prepareTxForCommit` runs the persist pass that mints
    // the labelMap entry.
    const base = messagesCell.getAsNormalizedFullLink();
    for (let index = 0; index < messages.length; index++) {
      const raw = messagesCell.withTx(tx).key(startIndex + index).getRaw();
      const link = parseLink(raw);
      const id = link?.id;
      if (link === undefined || id === undefined) {
        logger.warn(
          "llm",
          "model message did not split into its own doc; LlmDerived stamp skipped",
        );
        continue;
      }
      recordRelevantSchemaWritePolicyInput(tx, {
        ...link,
        id,
        space: link.space ?? base.space ?? space,
        scope: resolveLinkScope(link.scope, base.scope),
        path: [],
        schema: LLM_DERIVED_MESSAGE_SCHEMA,
      }, LLM_DERIVED_MESSAGE_SCHEMA);
    }
  };

  const toolsCell = inputs.key("tools") as Cell<
    Record<string, Schema<typeof LLMToolSchema>>
  >;

  // Update merged pinnedCells in case context or internal pinnedCells changed
  const contextCells = inputs.key("context").get() ?? {};
  const toolPinnedCells = pinnedCells.get() ?? [];

  const contextAsPinnedCells: PinnedCell[] = Object.entries(contextCells)
    // Convert context cells to PinnedCell format
    .map(
      ([name, cell]) => {
        const link = resolveContextCellRef(cell)?.getAsNormalizedFullLink();
        if (!link) {
          throw new Error(`Context entry "${name}" is not a cell`);
        }
        const path = createLLMFriendlyLink(link, space);
        return { name, path };
      },
    )
    // Remove pinned cells that are already in the context
    .filter(({ path }) => !toolPinnedCells.some((cell) => cell.path === path));

  // Merge context cells and tool-pinned cells
  const mergedPinnedCells = [...contextAsPinnedCells, ...toolPinnedCells];

  // Write to result cell using editWithRetry since we're outside handler tx
  await runtime.editWithRetry((tx) => {
    result.withTx(tx).key("pinnedCells").set(mergedPinnedCells as any);
  });

  const toolCatalog = capturedRequest?.toolCatalog ?? buildToolCatalog(
    toolsCell,
    builtinTools,
  );

  // If resultSchema is provided, inject presentResult built-in tool.
  // TODO(danfuzz): `resultSchema` is untrusted input, so this `as` is an
  // unchecked assertion. Replace with a runtime validating guard, e.g.
  // `asSchemaOrThrow(schema: unknown): schema is JSONSchema`.
  const userResultSchema = capturedRequest?.userResultSchema ??
    (inputs.key("resultSchema").get() as JSONSchema | undefined);
  if (userResultSchema && capturedRequest === undefined) {
    toolCatalog.llmTools[PRESENT_RESULT_TOOL_NAME] = {
      description:
        "Call this tool to present a structured result. This stores the result for the caller.",
      inputSchema: prepareSchemaForLLM(
        toDeepFrozenSchema(userResultSchema),
      ),
    };
  }

  // Build available cells documentation (both context and pinned cells).
  // This rebuild happens POST-COMMIT (no sink-request input gates these
  // reads), so a declared bound — including the empty "public only" one the
  // deployment sink ceiling can fold in — must engage observation-aware
  // serialization; only the truly absent bound may skip it (#3993 review).
  const context = inputs.key("context").get();
  const cellsDocs = observationMaxConfidentiality !== undefined
    ? buildAvailableCellsDocumentationWithObservation(
      runtime,
      space,
      context,
      pinnedCells,
      observationMaxConfidentiality,
    )
    : {
      docs: buildAvailableCellsDocumentation(
        runtime,
        space,
        context,
        pinnedCells,
      ),
      observedConfidentiality: [],
    };

  const linkModelDocs = builtinTools
    ? `

# Link and Cell Model

The system organizes all data and computation into **cells**:

- **Data cells**: Contain JSON data that can be read and written
- **Handler cells (streams)**: Executable functions that can be invoked but not read directly
- **Pattern cells**: Running program instances that may contain both data fields and handler fields

## Links

Links are universal identifiers that point to cells. They use the format:

\`\`\`json
{ "@link": "/of:bafyabc123/path/to/cell" }
\`\`\`

Where:
- \`of:bafyabc123\` is the handle/ID of the root entity (piece, pattern instance, etc.)
- \`/path/to/cell\` is the path within that entity to a specific cell

## Tool Composition

Tools work together by passing links between them:

1. \`invoke({ "@link": "/of:abc/handler" }, args)\` → Returns \`{ "@link": "/of:xyz/result" }\`
2. \`read({ "@link": "/of:xyz/result" })\` → Returns the data, which may contain nested links
3. \`updateArgument({ "@link": "/of:pattern" }, { field: value })\` → Updates running pattern arguments
4. Data often contains links to other cells: \`{ items: [{ "@link": "/of:123" }, { "@link": "/of:456" }] }\`

## Pages

Some operations (especially \`invoke()\` with patterns) create "Pages" - running pattern instances that:
- Have their own identity accessible via a link
- Contain data fields that can be read with \`read()\`
- Contain handler fields that can be invoked with \`invoke()\`
- Arguments can be updated with \`updateArgument()\` to change pattern behavior dynamically
- May link to other cells in the system

**Use links to navigate between related data and compose operations.**`
    : "";

  const listRecentHint = builtinTools
    ? "\n\nIf the user's request is unclear or you need context about what they're referring to, " +
      "call listRecent() to see recently viewed pieces."
    : "";

  const augmentedSystem = (system ?? "") + linkModelDocs + cellsDocs.docs +
    listRecentHint;

  const liveMessages = messagesCell.get() as readonly BuiltInLLMMessage[];
  const visibleMessages = getObservedDialogMessages(
    messagesCell,
    liveMessages,
    (internal.key("messageObservations")
      .get() as DialogMessageObservationMap) ??
      {},
  );
  const requestObservedConfidentiality = joinCfcObservedConfidentiality([
    visibleMessages.observedConfidentiality,
    cellsDocs.observedConfidentiality,
  ]);
  const llmParams: LLMRequest = capturedRequest
    ? {
      ...capturedRequest.llmParams,
      system: augmentedSystem,
      messages: visibleMessages.messages,
    }
    : {
      system: augmentedSystem,
      messages: visibleMessages.messages,
      maxTokens: maxTokens,
      stream: true,
      model: model ?? DEFAULT_MODEL_NAME,
      metadata: { context: "piece" },
      cache: true,
      tools: toolCatalog.llmTools,
    };

  // TODO(bf): sendRequest must be given a callback, even if it does nothing
  const mappedLlmHost = runtime.mappedHostFor(space);
  const doWork = () =>
    client.sendRequest(
      llmParams,
      () => {},
      abortSignal,
      mappedLlmHost
        ? { endpoint: new URL("/api/ai/llm", mappedLlmHost) }
        : undefined,
    );

  const resultPromise = queueName
    ? runtime.getOrCreateQueue(queueName).enqueue(doWork)
    : doWork();

  resultPromise
    .then(async (llmResult) => {
      // Validate that the response has valid content
      if (!hasValidContent(llmResult.content)) {
        // LLM returned empty or invalid content (e.g., stream aborted mid-flight,
        // or AI SDK bug with empty text blocks). Insert a proper error message
        // instead of storing invalid content.
        logger.warn(
          "llm",
          "LLM returned invalid/empty content, adding error message",
        );
        const errorMessage = {
          [ID]: { llmDialog: { message: cause, id: crypto.randomUUID() } },
          role: "assistant",
          content:
            "I encountered an error generating a response. Please try again.",
        } satisfies BuiltInLLMMessage & { [ID]: unknown };

        await safelyPerformUpdate(
          runtime,
          pending,
          internal,
          requestId,
          (tx) => {
            messagesCell.withTx(tx).push(
              errorMessage as Schema<typeof LLMMessageSchema>,
            );
            pending.withTx(tx).set(false);
          },
        );
        return;
      }

      // Extract tool calls from content if it's an array
      const hasToolCalls = Array.isArray(llmResult.content) &&
        llmResult.content.some((part) => part.type === "tool-call");

      if (hasToolCalls) {
        try {
          const llmContent = llmResult.content as BuiltInLLMMessage["content"];
          const toolCallParts = extractToolCallParts(llmContent);
          const assistantMessage = buildAssistantMessage(
            llmContent,
            toolCallParts,
          );

          // Add ID to assistant message and publish immediately
          (assistantMessage as BuiltInLLMMessage & { [ID]: unknown })[ID] = {
            llmDialog: { message: cause, id: crypto.randomUUID() },
          };

          await safelyPerformUpdate(
            runtime,
            pending,
            internal,
            requestId,
            (tx) => {
              const nextIndex = (messagesCell.withTx(tx).get() as
                | readonly BuiltInLLMMessage[]
                | undefined)?.length ?? 0;
              recordDialogMessageObservations(tx, internal, [
                {
                  index: nextIndex,
                  observedConfidentiality: requestObservedConfidentiality,
                },
              ]);
              pushModelMessages(tx, [
                assistantMessage as Schema<typeof LLMMessageSchema>,
              ]);
            },
          );

          // Now execute the tool calls
          const toolResults = await executeToolCalls(
            runtime,
            space,
            toolCatalog,
            toolCallParts,
            pinnedCells,
            requestObservedConfidentiality,
            observationMaxConfidentiality,
          );

          // If presentResult was called, cellify the raw input so we can
          // store it on the dialog's result cell (guarded by requestId below).
          let cellifiedResult: unknown | undefined;
          if (userResultSchema) {
            const presentResultPart = toolCallParts.find(
              (p) => p.toolName === PRESENT_RESULT_TOOL_NAME,
            );
            if (presentResultPart) {
              cellifiedResult = traverseAndCellify(
                runtime,
                space,
                presentResultPart.input,
              );
            }
          }

          // Validate that we have a result for every tool call with matching IDs
          const toolCallIds = new Set(toolCallParts.map((p) => p.toolCallId));
          const resultIds = new Set(toolResults.map((r) => r.id));
          const mismatch = toolResults.length !== toolCallParts.length ||
            !toolCallParts.every((p) => resultIds.has(p.toolCallId));

          if (mismatch) {
            logger.error(
              "llm-error",
              `Tool execution mismatch: ${toolCallParts.length} calls [${
                Array.from(toolCallIds)
              }] but ${toolResults.length} results [${Array.from(resultIds)}]`,
            );
            // Add error message instead of invalid partial results
            const errorMessage = {
              [ID]: { llmDialog: { message: cause, id: crypto.randomUUID() } },
              role: "assistant",
              content: "Some tool calls failed to execute. Please try again.",
            } satisfies BuiltInLLMMessage & { [ID]: unknown };

            await safelyPerformUpdate(
              runtime,
              pending,
              internal,
              requestId,
              (tx) => {
                messagesCell.withTx(tx).push(
                  errorMessage as Schema<typeof LLMMessageSchema>,
                );
                pending.withTx(tx).set(false);
              },
            );
            return;
          }

          // Create and publish tool result messages
          const toolResultMessages = createToolResultMessages(toolResults);

          toolResultMessages.forEach((message) => {
            (message as BuiltInLLMMessage & { [ID]: unknown })[ID] = {
              llmDialog: { message: cause, id: crypto.randomUUID() },
            };
          });

          const success = await safelyPerformUpdate(
            runtime,
            pending,
            internal,
            requestId,
            (tx) => {
              // Write presentResult atomically with tool result messages,
              // guarded by requestId to prevent stale writes from canceled requests.
              if (cellifiedResult !== undefined) {
                result.withTx(tx).key("result").set(cellifiedResult);
              }
              const nextIndex = (messagesCell.withTx(tx).get() as
                | readonly BuiltInLLMMessage[]
                | undefined)?.length ?? 0;
              recordDialogMessageObservations(
                tx,
                internal,
                toolResultMessages.map((_, index) => ({
                  index: nextIndex + index,
                  observedConfidentiality:
                    toolResults[index]?.observedConfidentiality ?? [],
                })),
              );
              pushModelMessages(
                tx,
                toolResultMessages as Schema<typeof LLMMessageSchema>[],
              );
            },
          );

          // Optionally record to suggestion history via the default pattern's
          // recordSuggestion handler. This is intentionally best-effort: spaces
          // whose default pattern doesn't export recordSuggestion simply skip
          // recording (caught below) rather than failing the suggestion flow.
          if (
            success && cellifiedResult !== undefined &&
            queueName === "suggestions"
          ) {
            try {
              const spaceCell = runtime.getCell(space, space, spaceCellSchema);
              const handler = spaceCell
                .key("defaultPattern")
                .key("recordSuggestion");
              handler.send({
                result: (cellifiedResult as any)?.cell ?? cellifiedResult,
                messages: messagesCell.get() ?? [],
                timestamp: new Date().toISOString(),
              });
            } catch (e) {
              logger.warn(
                "llm",
                "Failed to record suggestion history entry",
                e,
              );
            }
          }

          if (success) {
            logger.info("llm", "Continuing conversation after tool calls...");

            startRequest(
              runtime,
              space,
              cause,
              inputs,
              pending,
              internal,
              pinnedCells,
              result,
              requestId,
              abortSignal,
              capturedRequest,
            );
          } else {
            logger.info(
              "llm",
              "Skipping write: pending=false or request changed",
            );
          }
        } catch (error: unknown) {
          console.error(error);
        }
      } else {
        // No tool calls, just add the assistant message
        const assistantMessage = {
          [ID]: { llmDialog: { message: cause, id: crypto.randomUUID() } },
          role: "assistant",
          content: llmResult.content,
        } satisfies BuiltInLLMMessage & { [ID]: unknown };

        // Ignore errors here, it probably means something else took over.
        await safelyPerformUpdate(
          runtime,
          pending,
          internal,
          requestId,
          (tx) => {
            const nextIndex = (messagesCell.withTx(tx).get() as
              | readonly BuiltInLLMMessage[]
              | undefined)?.length ?? 0;
            recordDialogMessageObservations(tx, internal, [
              {
                index: nextIndex,
                observedConfidentiality: requestObservedConfidentiality,
              },
            ]);
            pushModelMessages(tx, [
              assistantMessage as Schema<typeof LLMMessageSchema>,
            ]);
            pending.withTx(tx).set(false);
          },
        );
      }
    })
    .catch((error: unknown) => {
      console.error("Error generating data", error);
      const errorMessageText = error instanceof Error
        ? error.message
        : String(error);
      const errorMessage = {
        [ID]: { llmDialog: { message: cause, id: crypto.randomUUID() } },
        role: "assistant",
        content:
          `I encountered an error generating a response: ${errorMessageText}`,
      } satisfies BuiltInLLMMessage & { [ID]: unknown };

      safelyPerformUpdate(runtime, pending, internal, requestId, (tx) => {
        messagesCell.withTx(tx).push(
          errorMessage as Schema<typeof LLMMessageSchema>,
        );
        pending.withTx(tx).set(false);
      });
    });
}

function getSchemaTypeString(schema: JSONSchema): string {
  let defs;
  if (isRecord(schema)) {
    // Convert schema to TypeScript-like string for readability
    defs = (schema as Record<string, unknown>).$defs as
      | Record<string, JSONSchema>
      | undefined;
  }
  let schemaStr = schemaToTypeString(schema, { defs });
  const MAX_SCHEMA_LENGTH = 1000;
  if (schemaStr.length > MAX_SCHEMA_LENGTH) {
    schemaStr = schemaStr.substring(0, MAX_SCHEMA_LENGTH) +
      "\n  // ... truncated";
  }
  return schemaStr;
}
