import type { JSONSchema } from "@commonfabric/api";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { cfcOpaqueLinkForPath } from "./observation.ts";
import {
  cfcObjectSchemaIsClosed,
  isPrimitiveJsonValue,
  resolveSchemaForValidation,
  validateAgainstSchemaForSanitization,
} from "./schema-sanitization.ts";

export interface SchemaOpaqueLinkSanitizationResult {
  value: unknown;
  linkedStringCount: number;
}

const NO_RESERVED_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * Property names excused from the unmodeled-key rules at the ROOT of one
 * sanitization: the reserved keys of whatever produced the value, whose
 * spellings are fixed by a framework rather than chosen by the value's author.
 * A reserved key the schema models is measured normally; a reserved key it
 * does not model neither fails validation nor seals the object — it is simply
 * dropped from the sanitized value, because a key the schema never asked for
 * carries nothing the caller can read.
 *
 * The exemption is the root's alone. The framework fixes the spelling of the
 * keys it puts on the value it produced, and of nothing inside that value: a
 * nested object carrying an unmodeled `$NAME` is an object with an unmodeled
 * key, and it seals like any other, because a key nobody modeled is a key
 * whose name may itself be data. Excusing it at depth would drop the name and
 * release the object's modeled siblings — author data leaving on the strength
 * of a spelling the author chose.
 */
export interface StructuredResultReservedKeys {
  reservedKeys?: readonly string[];
}

const reservedKeySet = (
  options: StructuredResultReservedKeys,
): ReadonlySet<string> =>
  options.reservedKeys === undefined || options.reservedKeys.length === 0
    ? NO_RESERVED_KEYS
    : new Set(options.reservedKeys);

export const validateStructuredResultValue = (
  options: {
    schema: JSONSchema;
    value: unknown;
  } & StructuredResultReservedKeys,
): void => {
  const failure = validateAgainstSchemaForSanitization(
    options.schema,
    options.value,
    options.schema,
    reservedKeySet(options),
  );
  if (failure !== undefined) {
    throw new Error(failure);
  }
};

const schemaAllowsRawString = (
  schema: JSONSchema,
  value: string,
  fullSchema: JSONSchema,
  reserved: ReadonlySet<string>,
): boolean => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (!isObjectOrArray(resolved)) {
    return false;
  }
  if (Array.isArray(resolved.enum)) {
    return resolved.enum.some((entry) => entry === value);
  }
  if (
    "const" in resolved && resolved.const === value &&
    isPrimitiveJsonValue(resolved.const)
  ) {
    return true;
  }
  if (Array.isArray(resolved.allOf)) {
    return resolved.allOf.some((branch) =>
      schemaAllowsRawString(branch, value, fullSchema, reserved)
    );
  }
  const oneOf = matchingBranch(resolved.oneOf, value, fullSchema, reserved);
  if (oneOf !== undefined) {
    return schemaAllowsRawString(oneOf, value, fullSchema, reserved);
  }
  if (Array.isArray(resolved.anyOf)) {
    return resolved.anyOf.some((branch) =>
      validateAgainstSchemaForSanitization(
          branch,
          value,
          fullSchema,
          reserved,
        ) === undefined &&
      schemaAllowsRawString(branch, value, fullSchema, reserved)
    );
  }
  return false;
};

const schemaDirectlyDeclaresOpaqueLinkObject = (
  schema: Record<string, unknown>,
): boolean =>
  isObjectOrArray(schema.properties) &&
  isObjectOrArray(schema.properties["@link"]) &&
  schema.properties["@link"].type === "string" &&
  Array.isArray(schema.required) &&
  schema.required.includes("@link") &&
  cfcObjectSchemaIsClosed(schema);

const matchingBranches = (
  branches: unknown,
  value: unknown,
  fullSchema: JSONSchema,
  reserved: ReadonlySet<string>,
): JSONSchema[] => {
  if (!Array.isArray(branches)) {
    return [];
  }
  return branches
    .filter((branch): branch is JSONSchema =>
      (typeof branch === "boolean" || isObjectOrArray(branch)) &&
      validateAgainstSchemaForSanitization(
          branch,
          value,
          fullSchema,
          reserved,
        ) === undefined
    )
    .map((branch) => resolveSchemaForValidation(branch, fullSchema));
};

const schemaAcceptsOpaqueLinkObject = (
  schema: JSONSchema,
  value: { "@link": string },
  fullSchema: JSONSchema,
  reserved: ReadonlySet<string>,
): boolean => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (!isObjectOrArray(resolved)) {
    return false;
  }
  if (
    validateAgainstSchemaForSanitization(
      resolved,
      value,
      fullSchema,
      reserved,
    ) !== undefined
  ) {
    return false;
  }
  if (schemaDirectlyDeclaresOpaqueLinkObject(resolved)) {
    return true;
  }
  if (Array.isArray(resolved.allOf)) {
    return resolved.allOf.some((branch) =>
      schemaAcceptsOpaqueLinkObject(branch, value, fullSchema, reserved)
    );
  }
  const oneOfBranches = matchingBranches(
    resolved.oneOf,
    value,
    fullSchema,
    reserved,
  );
  if (oneOfBranches.length > 0) {
    return oneOfBranches.some((branch) =>
      schemaAcceptsOpaqueLinkObject(branch, value, fullSchema, reserved)
    );
  }
  return matchingBranches(resolved.anyOf, value, fullSchema, reserved).some((
    branch,
  ) => schemaAcceptsOpaqueLinkObject(branch, value, fullSchema, reserved));
};

const valueIsOpaqueLinkObject = (
  value: unknown,
): value is { "@link": string } =>
  isObjectOrArray(value) &&
  typeof value["@link"] === "string" &&
  Object.keys(value).length === 1;

const matchingBranch = (
  branches: unknown,
  value: unknown,
  fullSchema: JSONSchema,
  reserved: ReadonlySet<string>,
): JSONSchema | undefined => {
  if (!Array.isArray(branches)) {
    return undefined;
  }
  const branch = branches.find((branch): branch is JSONSchema =>
    (typeof branch === "boolean" || isObjectOrArray(branch)) &&
    validateAgainstSchemaForSanitization(
        branch,
        value,
        fullSchema,
        reserved,
      ) === undefined
  );
  return branch === undefined
    ? undefined
    : resolveSchemaForValidation(branch, fullSchema);
};

const isEmptySchemaObject = (schema: JSONSchema): boolean =>
  isObjectOrArray(schema) && Object.keys(schema).length === 0;

const combineAllOf = (schemas: readonly JSONSchema[]): JSONSchema => {
  const constrained = schemas.filter((schema) =>
    schema !== true && !isEmptySchemaObject(schema)
  );
  if (constrained.some((schema) => schema === false)) {
    return false;
  }
  if (constrained.length === 0) {
    return true;
  }
  if (constrained.length === 1) {
    return constrained[0]!;
  }
  return { allOf: constrained };
};

const schemaWithoutBranchKeyword = (
  schema: Record<string, unknown>,
  keyword: "anyOf" | "oneOf",
): JSONSchema => {
  const { [keyword]: _ignored, ...rest } = schema;
  return rest as JSONSchema;
};

const schemaForValue = (
  schema: JSONSchema,
  value: unknown,
  fullSchema: JSONSchema,
  reserved: ReadonlySet<string>,
): JSONSchema => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (!isObjectOrArray(resolved)) {
    return resolved;
  }
  let base: JSONSchema = resolved;
  const branches: JSONSchema[] = [];
  const oneOf = matchingBranch(resolved.oneOf, value, fullSchema, reserved);
  if (oneOf !== undefined) {
    base = schemaWithoutBranchKeyword(base as Record<string, unknown>, "oneOf");
    branches.push(oneOf);
  }
  const anyOf = matchingBranch(resolved.anyOf, value, fullSchema, reserved);
  if (anyOf !== undefined) {
    base = schemaWithoutBranchKeyword(base as Record<string, unknown>, "anyOf");
    branches.push(anyOf);
  }
  return branches.length === 0 ? resolved : combineAllOf([base, ...branches]);
};

const childSchemaForKey = (
  schema: JSONSchema,
  key: string,
  fullSchema: JSONSchema,
): JSONSchema => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (!isObjectOrArray(resolved)) {
    return true;
  }
  const childSchemas: JSONSchema[] = [];
  if (isObjectOrArray(resolved.properties)) {
    const child = resolved.properties[key];
    if (typeof child === "boolean" || isObjectOrArray(child)) {
      childSchemas.push(child);
    }
  }
  if (
    !(isObjectOrArray(resolved.properties) && key in resolved.properties) &&
    (typeof resolved.additionalProperties === "boolean" ||
      isObjectOrArray(resolved.additionalProperties))
  ) {
    childSchemas.push(resolved.additionalProperties);
  }
  if (Array.isArray(resolved.allOf)) {
    for (const branch of resolved.allOf) {
      const child = childSchemaForKey(branch, key, fullSchema);
      if (child !== true) {
        childSchemas.push(child);
      }
    }
  }
  return combineAllOf(childSchemas);
};

/**
 * Every property name the schema models for one object: the names on the node
 * itself and the names its `allOf`/`anyOf`/`oneOf` branches declare, merged.
 * This decides which of a value's keys are unmodeled, and an unmodeled key
 * seals the object — so a name this misses costs the caller the whole object.
 *
 * The walk is a worklist rather than a recursion, and carries the same two
 * guards as the sanitizer's own combinator walk: `activeRefs` is PATH-scoped,
 * so a self-recursive union terminates while two sibling branches naming one
 * `$ref` under different constraints each still contribute their names, and
 * `visited` is walk-wide over resolved nodes, so a shared tail is walked once
 * however many paths reach it. Depth costs heap, not call stack.
 */
const knownPropertyNames = (
  schema: JSONSchema,
  fullSchema: JSONSchema,
): Set<string> => {
  const known = new Set<string>();
  const activeRefs = new Set<string>();
  const visited = new Set<object>();

  type NameStep =
    | { kind: "node"; raw: JSONSchema }
    | { kind: "leave"; ref: string };

  const stack: NameStep[] = [{ kind: "node", raw: schema }];
  while (stack.length > 0) {
    const step = stack.pop()!;
    if (step.kind === "leave") {
      activeRefs.delete(step.ref);
      continue;
    }
    const raw = step.raw;
    const ref = isObjectOrArray(raw) && typeof raw.$ref === "string"
      ? raw.$ref
      : undefined;
    if (ref !== undefined && activeRefs.has(ref)) continue;
    const resolved = resolveSchemaForValidation(raw, fullSchema);
    if (!isObjectOrArray(resolved) || visited.has(resolved)) continue;
    visited.add(resolved);
    if (isObjectOrArray(resolved.properties)) {
      for (const key of Object.keys(resolved.properties)) {
        known.add(key);
      }
    }
    if (ref !== undefined) {
      activeRefs.add(ref);
      stack.push({ kind: "leave", ref });
    }
    for (
      const branches of [
        resolved.allOf,
        resolved.anyOf,
        resolved.oneOf,
      ] as const
    ) {
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) stack.push({ kind: "node", raw: branch });
    }
  }
  return known;
};

const itemSchemaForIndex = (
  schema: JSONSchema,
  fullSchema: JSONSchema,
  index: number,
): JSONSchema => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  const itemSchemas: JSONSchema[] = [];
  if (isObjectOrArray(resolved)) {
    // 2020-12 array semantics: a tuple slot governs its exact index; the
    // uniform `items` schema governs only the indices past the slots.
    // Collecting only `items` let tuple elements sanitize against an
    // unconstrained schema, dodging the opaque-link/raw-string gate.
    const prefixItems = Array.isArray(resolved.prefixItems)
      ? resolved.prefixItems
      : undefined;
    if (prefixItems !== undefined && index < prefixItems.length) {
      const slot = prefixItems[index];
      if (typeof slot === "boolean" || isObjectOrArray(slot)) {
        itemSchemas.push(slot);
      }
    } else if (
      typeof resolved.items === "boolean" || isObjectOrArray(resolved.items)
    ) {
      itemSchemas.push(resolved.items);
    }
    if (Array.isArray(resolved.allOf)) {
      for (const branch of resolved.allOf) {
        const item = itemSchemaForIndex(branch, fullSchema, index);
        if (item !== true) {
          itemSchemas.push(item);
        }
      }
    }
  }
  return combineAllOf(itemSchemas);
};

// TODO(danfuzz): Latent — schemas don't admit `Fabric*` values on this path
// today, but will in the not-too-distant future; at that point this guard-less
// `isObjectOrArray`-walk fails (a `FabricPrimitive` is decomposed, a `FabricInstance`
// is walked by internal slots rather than codec contents). Mark ahead of that.
const sanitizeValueWithOpaqueLinks = (
  value: unknown,
  schema: JSONSchema,
  fullSchema: JSONSchema,
  opaqueHandleId: string,
  path: readonly (string | number)[],
  reserved: ReadonlySet<string>,
): SchemaOpaqueLinkSanitizationResult => {
  const effectiveSchema = schemaForValue(schema, value, fullSchema, reserved);
  if (typeof value === "string") {
    if (schemaAllowsRawString(effectiveSchema, value, fullSchema, reserved)) {
      return { value, linkedStringCount: 0 };
    }
    return {
      value: cfcOpaqueLinkForPath(opaqueHandleId, path),
      linkedStringCount: 1,
    };
  }
  if (Array.isArray(value)) {
    let linkedStringCount = 0;
    const items = value.map((item, index) => {
      const sanitized = sanitizeValueWithOpaqueLinks(
        item,
        itemSchemaForIndex(effectiveSchema, fullSchema, index),
        fullSchema,
        opaqueHandleId,
        [...path, index],
        // Reserved names are the root's exemption; an item is not the root.
        NO_RESERVED_KEYS,
      );
      linkedStringCount += sanitized.linkedStringCount;
      return sanitized.value;
    });
    return { value: items, linkedStringCount };
  }
  if (isObjectOrArray(value)) {
    if (
      valueIsOpaqueLinkObject(value) &&
      schemaAcceptsOpaqueLinkObject(schema, value, fullSchema, reserved)
    ) {
      return { value, linkedStringCount: 0 };
    }
    // The unmodeled-key policy: one key the schema does not model seals the
    // whole object, because a key it cannot model is a key whose NAME may
    // itself be data. A RESERVED unmodeled key is the exception — its
    // spelling is the framework's, not the value author's — and it is dropped
    // rather than shown, so nothing about it reaches the reader either way.
    const knownKeys = knownPropertyNames(effectiveSchema, fullSchema);
    const unmodeled = Object.keys(value).filter((key) => !knownKeys.has(key));
    if (unmodeled.some((key) => !reserved.has(key))) {
      return {
        value: cfcOpaqueLinkForPath(opaqueHandleId, path),
        linkedStringCount: 0,
      };
    }
    const dropped = new Set(unmodeled);
    let linkedStringCount = 0;
    const entries = Object.entries(value).filter(([key]) => !dropped.has(key))
      .map(([key, child]) => {
        const sanitized = sanitizeValueWithOpaqueLinks(
          child,
          childSchemaForKey(effectiveSchema, key, fullSchema),
          fullSchema,
          opaqueHandleId,
          [...path, key],
          // Reserved names are the root's exemption; a property of the root
          // holds whatever its author put there, reserved-looking or not.
          NO_RESERVED_KEYS,
        );
        linkedStringCount += sanitized.linkedStringCount;
        return [key, sanitized.value] as const;
      });
    return { value: Object.fromEntries(entries), linkedStringCount };
  }
  return { value, linkedStringCount: 0 };
};

export const validateAndSanitizeSchemaValueWithOpaqueLinks = (
  options: {
    schema: JSONSchema;
    value: unknown;
    opaqueHandleId: string;
  } & StructuredResultReservedKeys,
): SchemaOpaqueLinkSanitizationResult => {
  // The value validated is the value as it arrived. Projecting reserved keys
  // out first would change what the schema is measuring: a value a `oneOf`
  // branch refuses BECAUSE of what it carries under a reserved name would be
  // handed to that branch with the offending key already gone, and accepted.
  validateStructuredResultValue(options);
  return sanitizeValueWithOpaqueLinks(
    options.value,
    options.schema,
    options.schema,
    options.opaqueHandleId,
    [],
    reservedKeySet(options),
  );
};

export const validateAndSanitizeStructuredResultValue =
  validateAndSanitizeSchemaValueWithOpaqueLinks;
