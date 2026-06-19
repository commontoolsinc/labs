import {
  type FabricValue,
  shallowMutableClone,
} from "@commonfabric/data-model/fabric-value";
import { cellRefFrom } from "@commonfabric/data-model/cell-rep";
import { isRecord } from "@commonfabric/utils/types";
import {
  isModule,
  isOpaqueRef,
  type JSONSchema,
  type Module,
  type Pattern,
} from "./builder/types.ts";
import { isCellLink } from "./link-utils.ts";
import { type SigilLink, type URI } from "./sigil-types.ts";

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
  return cellRefFrom({ id });
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

/**
 * Validates an action result and checks if it contains opaque refs.
 * Throws if result contains invalid types (Map, Set, functions, etc.).
 * Returns true if the result contains any OpaqueRefs.
 */
export function validateAndCheckOpaqueRefs(
  value: unknown,
  actionName?: string,
  path: string[] = [],
): boolean {
  if (value === null || value === undefined) return false;
  if (isOpaqueRef(value)) return true;
  if (isCellLink(value)) return false;

  const formatError = (typeName: string, hint?: string) => {
    const pathStr = path.length > 0 ? ` at path "${path.join(".")}"` : "";
    const actionStr = actionName ? `\n  in action: ${actionName}` : "";
    const hintStr = hint ? ` ${hint}` : "";
    return `Action returned a ${typeName}${pathStr}.${actionStr}\nActions must return JSON-serializable values, OpaqueRefs, or Cells.${hintStr}`;
  };

  if (typeof value === "function") {
    throw new Error(formatError("function"));
  }

  if (typeof value === "symbol") {
    throw new Error(formatError("Symbol", "Consider removing this property."));
  }

  if (typeof value === "bigint") {
    throw new Error(
      formatError("BigInt", "Consider converting to number or string."),
    );
  }

  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      throw new Error(
        formatError("NaN", "Check your inputs or return null instead."),
      );
    }
    if (!Number.isFinite(value)) {
      throw new Error(
        formatError("Infinity", "Check your inputs or return null instead."),
      );
    }
    return false;
  }

  if (typeof value !== "object") return false;

  const obj = value as object;

  if (obj instanceof Map) {
    throw new Error(
      formatError("Map", "Consider using a plain object instead."),
    );
  }

  if (obj instanceof Set) {
    throw new Error(formatError("Set", "Consider using an array instead."));
  }

  if (Array.isArray(obj)) {
    return obj.some((item: unknown, index: number) =>
      validateAndCheckOpaqueRefs(item, actionName, [...path, `[${index}]`])
    );
  }

  const proto = Object.getPrototypeOf(obj);
  if (proto !== null && proto !== Object.prototype) {
    const typeName = obj.constructor?.name ?? "unknown type";
    throw new Error(formatError(typeName));
  }

  return Object.entries(obj as Record<string, unknown>).some(
    ([key, val]) => validateAndCheckOpaqueRefs(val, actionName, [...path, key]),
  );
}

/**
 * Extracts default values from a JSON schema object.
 * @param schema - The JSON schema to extract defaults from
 * @returns An object containing the default values, or undefined if none found
 */
export function extractDefaultValues(
  schema: JSONSchema,
): FabricValue {
  if (typeof schema !== "object" || schema === null) return undefined;

  if (
    schema.type === "object" && schema.properties && isRecord(schema.properties)
  ) {
    // Mutable top-level copy of the schema default, so injecting top-level
    // property defaults below doesn't mutate the schema's own default object.
    // Only top-level keys are written here, and the result is normalized
    // downstream by `fabricFromNativeValue` (which rebuilds a fresh tree), so a
    // shallow copy would suffice for correctness; we deep-freeze the bound
    // children as inexpensive defense-in-depth against accidental deeper
    // mutation of the shared default.
    const obj = shallowMutableClone(
      (isRecord(schema.default) ? schema.default : {}) as FabricValue,
    ) as Record<string, FabricValue>;
    for (const [propKey, propSchema] of Object.entries(schema.properties)) {
      const value = extractDefaultValues(propSchema);
      if (value !== undefined) {
        obj[propKey] = value;
      }
    }

    // Freeze the assembled defaults. Safe (consumers only read the result) and
    // nearly free, and it feeds the system's deep-freeze discipline: this
    // function is recursive, so the per-level freeze composes into a
    // deep-frozen result wherever the schema's own defaults are already frozen
    // -- which a downstream `cloneIfNecessary(_, { frozen: true })` can then
    // reuse by identity instead of re-cloning.
    return Object.keys(obj).length > 0 ? Object.freeze(obj) : undefined;
  }

  return schema.default;
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
          (entry as Record<string, unknown>)?.[key] as T[keyof T]
        ),
      );
      if (merged !== undefined) result[key] = merged;
    }
  }

  return result as T;
}
