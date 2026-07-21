import {
  fabricFromNativeValue,
  type FabricValue,
  isFabricPlainObject,
  shallowMutableClone,
  valueEqual,
} from "@commonfabric/data-model/fabric-value";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";
import {
  isModule,
  isReactive,
  type JSONSchema,
  type Module,
  type Pattern,
} from "./builder/types.ts";
import { isCell, isStream } from "./cell.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { isCellLink } from "./link-utils.ts";
import { type SigilLink, type URI } from "./sigil-types.ts";
import {
  cfcSchemaChildRoot,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
} from "./cfc/schema-refs.ts";
import { validateSchemaValue } from "./cfc/schema-sanitization.ts";
import {
  hasOwnEnumerableDataProperty,
  isAsCellEntryArray,
  isCellKind,
  isSchemaScope,
} from "./scope.ts";

const schemaDefaultValueEqual = (left: unknown, right: unknown): boolean => {
  try {
    return valueEqual(left as FabricValue, right as FabricValue);
  } catch {
    if (Object.is(left, right)) return true;
    try {
      return deepEqual(left, right);
    } catch {
      return false;
    }
  }
};

type ActiveDefaultMergePairs = WeakMap<
  object,
  WeakMap<object, WeakSet<object>>
>;

const mergeDefaultCandidateObjects = (
  earlier: Record<string, FabricValue>,
  later: Record<string, FabricValue>,
): Record<string, FabricValue> => {
  const result: Record<string, FabricValue> = {};
  for (const key of new Set([...Object.keys(earlier), ...Object.keys(later)])) {
    const hasEarlier = Object.hasOwn(earlier, key);
    const hasLater = Object.hasOwn(later, key);
    const earlierValue = earlier[key];
    const laterValue = later[key];
    const value = hasEarlier && hasLater &&
        isFabricPlainObject(earlierValue) && !isCellLink(earlierValue) &&
        isFabricPlainObject(laterValue) && !isCellLink(laterValue)
      ? mergeDefaultCandidateObjects(earlierValue, laterValue)
      : hasEarlier
      ? earlierValue
      : laterValue;
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
};

/** Whether an opaque Cell materialization matches this schema's wrapper. */
export const schemaAcceptsOpaqueCellValue = (
  value: unknown,
  schema: JSONSchema,
): boolean => {
  if (!isCell(value)) return false;
  if (
    typeof schema !== "object" || schema === null ||
    !hasOwnEnumerableDataProperty(schema, "asCell") ||
    !isAsCellEntryArray(schema.asCell)
  ) {
    return false;
  }
  if ("scope" in schema) {
    if (!hasOwnEnumerableDataProperty(schema, "scope")) return false;
    if (schema.scope !== undefined && !isSchemaScope(schema.scope)) {
      return false;
    }
  }
  const expectedKind = ContextualFlowControl.getAsCellKind(
    schema.asCell.at(0),
  );
  return isCellKind(expectedKind) &&
    (expectedKind === "stream") === isStream(value);
};

export function setRunnableName<T extends object & { src?: string }>(
  target: T,
  name: string,
  options: { setSrc?: boolean } = {},
): void {
  Object.defineProperty(target, "name", {
    value: name,
    configurable: true,
  });

  if (options.setSrc) {
    target.src = name;
  }
}

export function sanitizeDebugLabel(label?: string): string | undefined {
  if (!label) return undefined;
  return label.replace(/^async\s+/, "").trim() || undefined;
}

export function getSigilLink(id: URI): SigilLink {
  return linkRefFrom({ id });
}

export function describePatternOrModule(
  patternOrModule: Pattern | Module | undefined,
): string {
  if (!patternOrModule) return "undefined";
  if (isModule(patternOrModule)) {
    if (
      patternOrModule.type === "ref" &&
      typeof patternOrModule.implementation === "string"
    ) {
      return `module:ref:${patternOrModule.implementation}`;
    }

    if (typeof patternOrModule.implementation === "function") {
      const impl = patternOrModule.implementation as {
        debugName?: string;
        src?: string;
        name?: string;
      };
      const name = sanitizeDebugLabel(impl.debugName) ??
        sanitizeDebugLabel(impl.src) ??
        sanitizeDebugLabel(impl.name) ??
        "anonymous";
      return `module:${patternOrModule.type}:${name}`;
    }

    return `module:${patternOrModule.type}`;
  }

  return `pattern:nodes=${patternOrModule.nodes.length}`;
}

const hasToJSON = (value: object): boolean =>
  "toJSON" in value &&
  typeof (value as { toJSON?: unknown }).toJSON === "function";

/**
 * Returns whether the value is a native container whose children can contain
 * Reactives. Objects with `toJSON()` are atomic at the native-conversion
 * boundary, so their implementation details must not participate in Reactive
 * detection.
 */
function isActionResultContainer(
  value: unknown,
): value is unknown[] | Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  if (hasToJSON(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function typeNameForActionResult(value: unknown): string {
  switch (typeof value) {
    case "function":
      return "function";
    case "symbol":
      return "Symbol";
    case "bigint":
      return "BigInt";
    case "number":
      if (Number.isNaN(value)) return "NaN";
      if (!Number.isFinite(value)) return "Infinity";
      return "number";
    case "object":
      if (value === null) return "null";
      return value.constructor?.name ?? "unknown type";
    default:
      return typeof value;
  }
}

function hintForActionResult(value: unknown): string | undefined {
  const typeName = typeNameForActionResult(value);
  if (typeName === "Map") return "Consider using a plain object instead.";
  if (typeName === "Set") return "Consider using an array instead.";
  if (typeof value === "symbol") return "Consider removing this property.";
  return undefined;
}

function formatActionResultError(
  value: unknown,
  cause: unknown,
  actionName: string | undefined,
  path: string[],
): Error {
  const pathStr = path.length > 0 ? ` at path "${path.join(".")}"` : "";
  const actionStr = actionName ? `\n  in action: ${actionName}` : "";
  const hint = hintForActionResult(value);
  const hintStr = hint ? ` ${hint}` : "";
  const causeStr = cause instanceof Error ? `\n${cause.message}` : "";
  return new Error(
    `Action returned a ${typeNameForActionResult(value)}${pathStr}.` +
      `${actionStr}\nActions must return FabricValues, Reactives, or Cells.` +
      `${hintStr}${causeStr}`,
    { cause },
  );
}

/**
 * Applies the data-model's native-to-Fabric conversion as the sole authority
 * for action-result value legality. On failure, descends only to identify the
 * offending path for the action-facing diagnostic.
 */
function validateFabricActionResult(
  value: unknown,
  actionName: string | undefined,
  path: string[],
  seen: Set<object> = new Set(),
): void {
  try {
    // Validation must not freeze or retain a duplicate result tree. The actual
    // cell write performs the canonical conversion with its normal freezing.
    fabricFromNativeValue(value, false);
    return;
  } catch (cause) {
    if (isActionResultContainer(value) && !seen.has(value)) {
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        try {
          fabricFromNativeValue(child, false);
        } catch {
          validateFabricActionResult(
            child,
            actionName,
            [...path, Array.isArray(value) ? `[${key}]` : key],
            seen,
          );
        }
      }
    }
    throw formatActionResultError(value, cause, actionName, path);
  }
}

/**
 * Produces the value tree used for data-model validation. Reactive and Cell
 * leaves are legal action-result placeholders but are not FabricValues, so the
 * recursive walk replaces them with `undefined` while preserving container
 * structure, shared references, cycles, and invalid array properties for the
 * authoritative conversion check.
 */
function prepareActionResultValidation(
  value: unknown,
  prepared: Map<object, { value: unknown; hasReactive: boolean }> = new Map(),
): { value: unknown; hasReactive: boolean } {
  if (isReactive(value)) return { value: undefined, hasReactive: true };
  if (isCellLink(value)) return { value: undefined, hasReactive: false };
  if (!isActionResultContainer(value)) {
    return { value, hasReactive: false };
  }
  const existing = prepared.get(value);
  if (existing !== undefined) return existing;

  const valueIsArray = Array.isArray(value);
  const copy: unknown[] | Record<string, unknown> = valueIsArray
    ? []
    : Object.create(Object.getPrototypeOf(value));
  const result = { value: copy, hasReactive: false };
  prepared.set(value, result);
  if (valueIsArray) {
    (copy as unknown[]).length = (value as unknown[]).length;
  }

  for (const [key, child] of Object.entries(value)) {
    const childResult = prepareActionResultValidation(child, prepared);
    result.hasReactive ||= childResult.hasReactive;
    Object.defineProperty(copy, key, {
      value: childResult.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

/**
 * Validates an action result and reports whether it contains Reactives.
 * Reactives and Cell links remain legal leaves; every native value subtree is
 * accepted or rejected by `fabricFromNativeValue()`.
 */
export function validateAndCheckReactives(
  value: unknown,
  actionName?: string,
): boolean {
  const prepared = prepareActionResultValidation(value);
  validateFabricActionResult(prepared.value, actionName, []);
  return prepared.hasReactive;
}

/**
 * Extracts default values from a JSON schema object.
 * @param schema - The JSON schema to extract defaults from
 * @returns An object containing the default values, or undefined if none found
 */
export function extractDefaultValues(
  schema: JSONSchema,
  fullSchema: JSONSchema = schema,
): FabricValue {
  const extracted = extractDefaultValuesInternal(
    schema,
    fullSchema,
    new WeakMap(),
  );
  return extracted === NO_SCHEMA_DEFAULT ? undefined : extracted;
}

/** Whether extraction found a default, including an explicit `undefined`. */
export function schemaHasDefaultValue(
  schema: JSONSchema,
  fullSchema: JSONSchema = schema,
): boolean {
  return extractDefaultValuesInternal(schema, fullSchema, new WeakMap()) !==
    NO_SCHEMA_DEFAULT;
}

const NO_SCHEMA_DEFAULT = Symbol("no-schema-default");

function extractDefaultValuesInternal(
  schema: JSONSchema,
  fullSchema: JSONSchema,
  activeSchemasByRoot: WeakMap<object, WeakSet<object>>,
): FabricValue | typeof NO_SCHEMA_DEFAULT {
  if (typeof schema !== "object" || schema === null) {
    return NO_SCHEMA_DEFAULT;
  }

  const schemaRoot = cfcSchemaChildRoot(schema, fullSchema);
  const resolved = schema.$ref
    ? resolveCfcSchemaRefs(schema, schemaRoot)
    : schema;
  if (typeof resolved !== "object" || resolved === null) {
    return NO_SCHEMA_DEFAULT;
  }
  const resolvedRoot = cfcSchemaChildRoot(
    resolved,
    schema.$ref ? resolveCfcSchemaRefRoot(schema, schemaRoot) : schemaRoot,
  );

  const canonical = internSchema(resolved);
  const rootKey = typeof resolvedRoot === "object" && resolvedRoot !== null
    ? resolvedRoot
    : canonical;
  let activeSchemas = activeSchemasByRoot.get(rootKey);
  if (activeSchemas?.has(canonical)) return NO_SCHEMA_DEFAULT;
  if (!activeSchemas) {
    activeSchemas = new WeakSet();
    activeSchemasByRoot.set(rootKey, activeSchemas);
  }
  activeSchemas.add(canonical);

  try {
    const unionConstraints = [canonical.anyOf, canonical.oneOf].filter(
      (branches): branches is JSONSchema[] => Array.isArray(branches),
    );
    if (unionConstraints.length > 0) {
      if (Object.hasOwn(canonical, "default")) {
        return validateSchemaValue(
            canonical,
            canonical.default,
            resolvedRoot,
          ) === undefined
          ? canonical.default
          : NO_SCHEMA_DEFAULT;
      }

      const {
        anyOf: _anyOf,
        oneOf: _oneOf,
        default: _default,
        ...baseSchema
      } = canonical;
      type DefaultCandidate = {
        value: FabricValue | typeof NO_SCHEMA_DEFAULT;
        selectedBranches: JSONSchema[];
      };
      let candidates: DefaultCandidate[] = [{
        value: extractDefaultValuesInternal(
          baseSchema,
          resolvedRoot,
          activeSchemasByRoot,
        ),
        selectedBranches: [],
      }];
      for (const branches of unionConstraints) {
        const expanded: DefaultCandidate[] = [];
        for (const candidate of candidates) {
          for (const branch of branches) {
            const branchDefault = extractDefaultValuesInternal(
              branch,
              resolvedRoot,
              activeSchemasByRoot,
            );
            let value = candidate.value;
            if (value === NO_SCHEMA_DEFAULT) {
              value = branchDefault;
            } else if (
              branchDefault !== NO_SCHEMA_DEFAULT &&
              isFabricPlainObject(value) && !isCellLink(value) &&
              isFabricPlainObject(branchDefault) &&
              !isCellLink(branchDefault)
            ) {
              value = mergeDefaultCandidateObjects(value, branchDefault);
            }
            expanded.push({
              value,
              selectedBranches: [...candidate.selectedBranches, branch],
            });
          }
        }
        candidates = expanded;
      }
      const validCandidates = candidates.filter((candidate) =>
        candidate.value !== NO_SCHEMA_DEFAULT &&
        candidate.selectedBranches.every((branch) =>
          validateSchemaValue(branch, candidate.value, resolvedRoot) ===
            undefined
        ) &&
        validateSchemaValue(canonical, candidate.value, resolvedRoot) ===
          undefined
      ).map((candidate) => candidate.value as FabricValue);
      return validCandidates.length > 0 &&
          validCandidates.every((candidate) =>
            schemaDefaultValueEqual(candidate, validCandidates[0])
          )
        ? validCandidates[0]
        : NO_SCHEMA_DEFAULT;
    }

    if (
      (canonical.type === "object" ||
        Array.isArray(canonical.type) && canonical.type.includes("object")) &&
      canonical.properties &&
      isRecord(canonical.properties)
    ) {
      if (
        Object.hasOwn(canonical, "default") &&
        !isRecord(canonical.default)
      ) {
        return canonical.default;
      }
      const hasObjectDefault = Object.hasOwn(canonical, "default") &&
        isRecord(canonical.default);
      // Mutable top-level copy of the schema default, so injecting top-level
      // property defaults below doesn't mutate the schema's own default object.
      // Only top-level keys are written here, and the result is normalized
      // downstream by `fabricFromNativeValue` (which rebuilds a fresh tree), so a
      // shallow copy would suffice for correctness; we deep-freeze the bound
      // children as inexpensive defense-in-depth against accidental deeper
      // mutation of the shared default.
      const obj = shallowMutableClone(
        (isRecord(canonical.default) ? canonical.default : {}) as FabricValue,
      ) as Record<string, FabricValue>;
      for (
        const [propKey, propSchema] of Object.entries(canonical.properties)
      ) {
        const value = extractDefaultValuesInternal(
          propSchema,
          resolvedRoot,
          activeSchemasByRoot,
        );
        if (value !== NO_SCHEMA_DEFAULT) {
          obj[propKey] = value;
        }
      }

      // Freeze the assembled defaults. Safe (consumers only read the result) and
      // nearly free, and it feeds the system's deep-freeze discipline: this
      // function is recursive, so the per-level freeze composes into a
      // deep-frozen result wherever the schema's own defaults are already frozen
      // -- which a downstream `cloneIfNecessary(_, { frozen: true })` can then
      // reuse by identity instead of re-cloning.
      return Object.keys(obj).length > 0 || hasObjectDefault
        ? Object.freeze(obj)
        : NO_SCHEMA_DEFAULT;
    }

    return Object.hasOwn(canonical, "default")
      ? canonical.default
      : NO_SCHEMA_DEFAULT;
  } finally {
    activeSchemas.delete(canonical);
  }
}

/**
 * Merges objects into a single object, preferring values from later objects.
 * Recursively calls itself for nested objects, passing on any objects that
 * matching properties.
 * @param objects - Objects to merge
 * @returns A merged object, or undefined if no objects provided
 */
export function mergeObjects<T>(
  ...objects: (Partial<T> | undefined)[]
): T {
  objects = objects.filter((obj) => obj !== undefined);
  if (objects.length === 0) return {} as T;
  if (objects.length === 1) return objects[0] as T;

  const seen = new Set<PropertyKey>();
  const result: Record<string, unknown> = {};

  for (const obj of objects) {
    if (!isRecord(obj) || Array.isArray(obj) || isCellLink(obj)) {
      return obj as T;
    }

    for (const key of Object.keys(obj)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const merged = mergeObjects<T[keyof T]>(
        ...objects.map((entry) =>
          isRecord(entry) && Object.hasOwn(entry, key)
            ? (entry as Record<string, unknown>)[key] as T[keyof T]
            : undefined
        ),
      );
      if (merged !== undefined) {
        Object.defineProperty(result, key, {
          value: merged,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
  }

  return result as T;
}

/**
 * Merge schema defaults into an existing argument while avoiding optional
 * object defaults that would create an invalid partial value on their own.
 */
export function mergeSchemaDefaults<T>(
  value: T | undefined,
  defaults: unknown,
  schema: JSONSchema,
  options: {
    mergeMaterializedLinks?: boolean;
    valuePresent?: boolean;
    acceptOpaqueValue?: (
      value: unknown,
      schema: JSONSchema,
      fullSchema: JSONSchema,
    ) => boolean;
    /** Disambiguate otherwise-valid top-level union default candidates. */
    acceptUnionCandidate?: (candidate: unknown) => boolean;
  } = {},
): T {
  return mergeSchemaDefaultsInternal(
    value,
    defaults,
    schema,
    schema,
    options.valuePresent ?? value !== undefined,
    options.mergeMaterializedLinks === true,
    options.acceptOpaqueValue,
    options.acceptUnionCandidate,
    new WeakMap(),
  ) as T;
}

function mergeSchemaDefaultsInternal(
  value: unknown,
  defaults: unknown,
  schema: JSONSchema,
  fullSchema: JSONSchema,
  valuePresent: boolean,
  mergeMaterializedLinks: boolean,
  acceptOpaqueValue:
    | ((
      value: unknown,
      schema: JSONSchema,
      fullSchema: JSONSchema,
    ) => boolean)
    | undefined,
  acceptUnionCandidate: ((candidate: unknown) => boolean) | undefined,
  activePairs: ActiveDefaultMergePairs,
): unknown {
  const schemaRoot = cfcSchemaChildRoot(schema, fullSchema);
  const resolved = typeof schema === "object" && schema !== null && schema.$ref
    ? resolveCfcSchemaRefs(schema, schemaRoot)
    : schema;
  const resolvedRoot = cfcSchemaChildRoot(
    resolved ?? schema,
    typeof schema === "object" && schema !== null && schema.$ref
      ? resolveCfcSchemaRefRoot(schema, schemaRoot)
      : schemaRoot,
  );

  const trackedValue = valuePresent && value !== null &&
      typeof value === "object"
    ? value as object
    : undefined;
  const trackedSchema = typeof resolved === "object" && resolved !== null
    ? internSchema(resolved)
    : undefined;
  const trackedRoot = typeof resolvedRoot === "object" && resolvedRoot !== null
    ? resolvedRoot
    : trackedSchema;
  let activeSchemas: WeakSet<object> | undefined;
  if (
    trackedValue !== undefined && trackedSchema !== undefined &&
    trackedRoot !== undefined
  ) {
    let byRoot = activePairs.get(trackedValue);
    if (!byRoot) {
      byRoot = new WeakMap();
      activePairs.set(trackedValue, byRoot);
    }
    activeSchemas = byRoot.get(trackedRoot);
    if (!activeSchemas) {
      activeSchemas = new WeakSet();
      byRoot.set(trackedRoot, activeSchemas);
    }
    if (activeSchemas.has(trackedSchema)) return value;
    activeSchemas.add(trackedSchema);
  }

  try {
    if (
      valuePresent &&
      (isFabricPlainObject(value as FabricValue) || Array.isArray(value)) &&
      typeof resolved === "object" && resolved !== null &&
      (Array.isArray(resolved.anyOf) || Array.isArray(resolved.oneOf))
    ) {
      const {
        anyOf,
        oneOf,
        default: _unionDefault,
        ...baseSchema
      } = resolved;
      const baseDefaults = extractDefaultValues(baseSchema, resolvedRoot);
      type UnionCandidate = {
        value: unknown;
        selectedBranches: JSONSchema[];
      };
      const unionDefaultValue = mergeSchemaDefaultsInternal(
        value,
        defaults,
        baseSchema,
        resolvedRoot,
        true,
        mergeMaterializedLinks,
        acceptOpaqueValue,
        undefined,
        activePairs,
      );
      let candidates: UnionCandidate[] = [{
        value: mergeSchemaDefaultsInternal(
          unionDefaultValue,
          baseDefaults,
          baseSchema,
          resolvedRoot,
          true,
          mergeMaterializedLinks,
          acceptOpaqueValue,
          undefined,
          activePairs,
        ),
        selectedBranches: [],
      }];
      const unionConstraints = [anyOf, oneOf].filter(
        (branches): branches is JSONSchema[] => Array.isArray(branches),
      );
      for (const branches of unionConstraints) {
        const expanded: UnionCandidate[] = [];
        for (const candidate of candidates) {
          for (const branch of branches) {
            const branchDefaults = extractDefaultValues(branch, resolvedRoot);
            expanded.push({
              value: mergeSchemaDefaultsInternal(
                candidate.value,
                branchDefaults,
                branch,
                resolvedRoot,
                true,
                mergeMaterializedLinks,
                acceptOpaqueValue,
                undefined,
                activePairs,
              ),
              selectedBranches: [...candidate.selectedBranches, branch],
            });
          }
        }
        candidates = expanded;
      }
      const validCandidates = candidates.filter((candidate) =>
        candidate.selectedBranches.every((branch) =>
          validateSchemaValue(branch, candidate.value, resolvedRoot, {
            acceptOpaqueValue,
          }) === undefined
        ) &&
        validateSchemaValue(resolved, candidate.value, resolvedRoot, {
            acceptOpaqueValue,
          }) === undefined
      ).map((candidate) => candidate.value);
      const acceptedCandidates = acceptUnionCandidate === undefined
        ? validCandidates
        : validCandidates.filter(acceptUnionCandidate);
      if (
        acceptedCandidates.length > 0 &&
        acceptedCandidates.every((candidate) =>
          schemaDefaultValueEqual(candidate, acceptedCandidates[0])
        )
      ) {
        return acceptedCandidates[0];
      }
      return value;
    }

    if (
      valuePresent && isFabricPlainObject(value as FabricValue) &&
      typeof resolved === "object" && resolved !== null &&
      Array.isArray(resolved.type) && resolved.type.includes("object")
    ) {
      const { default: _unionDefault, ...objectSchema } = resolved;
      const objectDefaults = extractDefaultValues(
        { ...objectSchema, type: "object" },
        resolvedRoot,
      );
      const unionDefaultValue = mergeSchemaDefaultsInternal(
        value,
        defaults,
        { ...objectSchema, type: "object" },
        resolvedRoot,
        true,
        mergeMaterializedLinks,
        acceptOpaqueValue,
        undefined,
        activePairs,
      );
      return mergeSchemaDefaultsInternal(
        unionDefaultValue,
        objectDefaults,
        { ...objectSchema, type: "object" },
        resolvedRoot,
        true,
        mergeMaterializedLinks,
        acceptOpaqueValue,
        undefined,
        activePairs,
      );
    }

    if (
      valuePresent && Array.isArray(value) &&
      typeof resolved === "object" && resolved !== null &&
      Array.isArray(resolved.type) && resolved.type.includes("array")
    ) {
      const { default: _unionDefault, ...arraySchema } = resolved;
      return mergeSchemaDefaultsInternal(
        value,
        extractDefaultValues(
          { ...arraySchema, type: "array" },
          resolvedRoot,
        ),
        { ...arraySchema, type: "array" },
        resolvedRoot,
        true,
        mergeMaterializedLinks,
        acceptOpaqueValue,
        undefined,
        activePairs,
      );
    }

    if (
      valuePresent && Array.isArray(value) &&
      typeof resolved === "object" && resolved !== null &&
      (resolved.type === "array" || resolved.items !== undefined ||
        resolved.prefixItems !== undefined)
    ) {
      const result = value.slice();
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) continue;
        const itemSchema = Array.isArray(resolved.prefixItems) &&
            index < resolved.prefixItems.length
          ? resolved.prefixItems[index]!
          : resolved.items ?? true;
        result[index] = mergeSchemaDefaultsInternal(
          value[index],
          extractDefaultValues(itemSchema, resolvedRoot),
          itemSchema,
          resolvedRoot,
          true,
          mergeMaterializedLinks,
          acceptOpaqueValue,
          undefined,
          activePairs,
        );
      }
      return schemaDefaultValueEqual(result, value) ? value : result;
    }

    const objectSchema = typeof resolved === "object" && resolved !== null &&
        (resolved.type === undefined || resolved.type === "object" ||
          (Array.isArray(resolved.type) && resolved.type.includes("object")))
      ? resolved
      : undefined;
    const traversesPresentObject = valuePresent &&
      isFabricPlainObject(value as FabricValue) && objectSchema !== undefined;

    if (defaults === undefined && !traversesPresentObject) return value;
    if (
      defaults !== undefined &&
      (!isFabricPlainObject(defaults) || isCellLink(defaults))
    ) {
      return valuePresent ? value : defaults;
    }
    // Defaults only fill absent values or recursively merge plain records. A
    // defined scalar, sparse array, Fabric special object, or sigil link is
    // durable user state, not an empty object to replace with defaults.
    if (
      valuePresent &&
      (!isFabricPlainObject(value as FabricValue) ||
        (isCellLink(value) && !mergeMaterializedLinks))
    ) {
      return value;
    }

    const existing = valuePresent ? value as Record<string, unknown> : {};
    const result: Record<string, unknown> = { ...existing };
    // Object-shaped unions (including Common Fabric's non-standard
    // `type: ["object", "undefined"]`) still need presence-aware merging. A
    // generic merge cannot distinguish an absent property from an own property
    // whose durable value is explicitly undefined.
    const required = new Set(objectSchema?.required ?? []);
    const defaultObject = (defaults ?? {}) as Record<string, unknown>;
    const keys = new Set([
      ...Object.keys(existing),
      ...Object.keys(defaultObject),
    ]);
    for (const key of keys) {
      const hasExistingValue = Object.hasOwn(existing, key);
      const hasDefaultValue = Object.hasOwn(defaultObject, key);
      const propertySchemas = schemasForObjectProperty(objectSchema, key);
      let merged = existing[key];
      let mergedValuePresent = hasExistingValue;
      for (let index = 0; index < propertySchemas.length; index++) {
        const propertySchema = propertySchemas[index]!;
        const propertyDefaults = index === 0 && hasDefaultValue
          ? defaultObject[key]
          : extractDefaultValues(propertySchema, resolvedRoot);
        merged = mergeSchemaDefaultsInternal(
          merged,
          propertyDefaults,
          propertySchema,
          resolvedRoot,
          mergedValuePresent,
          mergeMaterializedLinks,
          acceptOpaqueValue,
          undefined,
          activePairs,
        );
        if (
          !mergedValuePresent &&
          schemaHasDefaultValue(propertySchema, resolvedRoot)
        ) {
          mergedValuePresent = true;
        }
      }
      if (
        hasExistingValue || required.has(key) ||
        propertySchemas.every((propertySchema) =>
          validateSchemaValue(propertySchema, merged, resolvedRoot, {
            acceptOpaqueValue,
          }) === undefined
        )
      ) {
        Object.defineProperty(result, key, {
          value: merged,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return valuePresent && schemaDefaultValueEqual(result, value)
      ? value
      : result;
  } finally {
    if (trackedSchema !== undefined) activeSchemas?.delete(trackedSchema);
  }
}

function schemasForObjectProperty(
  schema: Exclude<JSONSchema, boolean> | undefined,
  property: string,
): JSONSchema[] {
  if (schema === undefined) return [true];
  const schemas: JSONSchema[] = [];
  if (
    schema.properties !== undefined &&
    Object.hasOwn(schema.properties, property)
  ) {
    schemas.push(schema.properties[property]!);
  }
  for (
    const [source, patternSchema] of Object.entries(
      schema.patternProperties ?? {},
    )
  ) {
    if (new RegExp(source).test(property)) schemas.push(patternSchema);
  }
  if (schemas.length === 0) {
    schemas.push(schema.additionalProperties ?? true);
  }
  return schemas;
}
