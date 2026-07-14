import { deepEqual, type JSONSchema, type Pattern } from "@commonfabric/runner";

type SchemaObject = Exclude<JSONSchema, boolean>;
type SchemaRole = "argument" | "result";

interface CompatibilityContext {
  sourceRoot: JSONSchema;
  targetRoot: JSONSchema;
  role: SchemaRole;
  activePairs: WeakMap<object, WeakSet<object>>;
}

const ANNOTATION_KEYS = new Set([
  "$comment",
  "$defs",
  "$id",
  "$schema",
  "default",
  "definitions",
  "description",
  "examples",
  "tags",
  "title",
]);

const COMPLEX_CONSTRAINT_KEYS = [
  "allOf",
  "contains",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "if",
  "maxContains",
  "minContains",
  "not",
  "oneOf",
  "patternProperties",
  "prefixItems",
  "propertyNames",
  "then",
] as const;

const SEMANTIC_EXTENSION_KEYS = [
  "asCell",
  "ifc",
  "readOnly",
  "scope",
  "writeOnly",
] as const;

/**
 * Reject a piece update unless its argument and result schemas preserve the
 * contracts of the currently running pattern.
 *
 * Arguments are contravariant: every value accepted by the old pattern must
 * still be accepted by the new pattern. Results are covariant: every value the
 * new pattern can produce must still be accepted by the old result schema.
 */
export function assertPatternSchemasBackwardCompatible(
  previous: Pattern,
  candidate: Pattern,
): void {
  const issues: string[] = [];
  const argumentIssue = schemaSubsetIssue(
    previous.argumentSchema,
    candidate.argumentSchema,
    "argument",
    {
      sourceRoot: previous.argumentSchema,
      targetRoot: candidate.argumentSchema,
      role: "argument",
      activePairs: new WeakMap(),
    },
  );
  if (argumentIssue) issues.push(argumentIssue);

  const resultIssue = schemaSubsetIssue(
    candidate.resultSchema,
    previous.resultSchema,
    "result",
    {
      sourceRoot: candidate.resultSchema,
      targetRoot: previous.resultSchema,
      role: "result",
      activePairs: new WeakMap(),
    },
  );
  if (resultIssue) issues.push(resultIssue);

  if (issues.length > 0) {
    throw new Error(
      `Pattern schemas are not backward compatible:\n${
        issues.map((issue) => `- ${issue}`).join("\n")
      }`,
    );
  }
}

function schemaSubsetIssue(
  sourceInput: JSONSchema,
  targetInput: JSONSchema,
  path: string,
  context: CompatibilityContext,
): string | undefined {
  if (deepEqual(sourceInput, targetInput)) return undefined;

  const source = resolveSchema(sourceInput, context.sourceRoot);
  const target = resolveSchema(targetInput, context.targetRoot);
  if (source === undefined || target === undefined) {
    return `${path}: cannot resolve a local schema reference`;
  }
  if (deepEqual(source, target)) return undefined;

  if (source === false || target === true) return undefined;
  if (source === true) {
    return target === false
      ? `${path}: the candidate schema rejects values accepted previously`
      : `${path}: an unconstrained schema is no longer accepted`;
  }
  if (target === false) {
    return `${path}: the candidate schema rejects values accepted previously`;
  }

  if (pairIsActive(source, target, context.activePairs)) return undefined;
  markPairActive(source, target, context.activePairs);
  try {
    const sourceAlternatives = schemaAlternatives(source);
    const targetAlternatives = schemaAlternatives(target);
    if (sourceAlternatives || targetAlternatives) {
      const sources = sourceAlternatives ?? [source];
      const targets = targetAlternatives ?? [target];
      for (const sourceAlternative of sources) {
        const accepted = targets.some((targetAlternative) =>
          schemaSubsetIssue(
            sourceAlternative,
            targetAlternative,
            path,
            context,
          ) === undefined
        );
        if (!accepted) {
          return `${path}: a schema alternative accepted previously is not accepted by the candidate`;
        }
      }
      return undefined;
    }

    const literalIssue = literalSubsetIssue(source, target, path);
    if (literalIssue) return literalIssue;

    const typeIssue = typeSubsetIssue(source, target, path);
    if (typeIssue) return typeIssue;

    const constraintIssue = scalarConstraintSubsetIssue(source, target, path);
    if (constraintIssue) return constraintIssue;

    for (const key of SEMANTIC_EXTENSION_KEYS) {
      if (!deepEqual(source[key], target[key])) {
        return `${path}: ${key} changed`;
      }
    }

    for (const key of COMPLEX_CONSTRAINT_KEYS) {
      if (!deepEqual(source[key], target[key])) {
        return `${path}: ${key} changed in a way compatibility checking cannot prove safe`;
      }
    }

    if (declaresObjectShape(source) || declaresObjectShape(target)) {
      const objectIssue = objectSubsetIssue(source, target, path, context);
      if (objectIssue) return objectIssue;
    }

    if (declaresArrayShape(source) || declaresArrayShape(target)) {
      const arrayIssue = arraySubsetIssue(source, target, path, context);
      if (arrayIssue) return arrayIssue;
    }

    return unknownKeywordIssue(source, target, path);
  } finally {
    unmarkPairActive(source, target, context.activePairs);
  }
}

function objectSubsetIssue(
  source: SchemaObject,
  target: SchemaObject,
  path: string,
  context: CompatibilityContext,
): string | undefined {
  const sourceProperties = source.properties ?? {};
  const targetProperties = target.properties ?? {};
  const previousProperties = context.role === "argument"
    ? sourceProperties
    : targetProperties;
  const candidateProperties = context.role === "argument"
    ? targetProperties
    : sourceProperties;

  for (const property of Object.keys(previousProperties)) {
    if (!(property in candidateProperties)) {
      return `${path}.${property}: existing ${context.role} field was removed`;
    }
  }

  const sourceRequired = new Set(source.required ?? []);
  const targetRequired = new Set(target.required ?? []);
  if (context.role === "argument") {
    for (const property of targetRequired) {
      if (
        !sourceRequired.has(property) &&
        !schemaProvidesDefault(targetProperties[property])
      ) {
        return `${path}.${property}: newly required argument field has no default`;
      }
    }
  } else {
    for (const property of targetRequired) {
      if (!sourceRequired.has(property)) {
        return `${path}.${property}: result field is no longer required`;
      }
    }
    for (const property of sourceRequired) {
      if (
        !(property in targetProperties) &&
        !schemaProvidesDefault(sourceProperties[property])
      ) {
        return `${path}.${property}: newly required result field has no default`;
      }
    }
  }

  for (const property of Object.keys(previousProperties)) {
    const issue = schemaSubsetIssue(
      sourceProperties[property],
      targetProperties[property],
      `${path}.${property}`,
      context,
    );
    if (issue) return issue;
  }

  return additionalPropertiesSubsetIssue(source, target, path, context);
}

function additionalPropertiesSubsetIssue(
  source: SchemaObject,
  target: SchemaObject,
  path: string,
  context: CompatibilityContext,
): string | undefined {
  const sourceAdditional = source.additionalProperties ?? true;
  const targetAdditional = target.additionalProperties ?? true;
  if (sourceAdditional === false || targetAdditional === true) return undefined;
  if (sourceAdditional === true && targetAdditional === false) {
    return `${path}: additional properties accepted previously would now be rejected`;
  }
  if (targetAdditional === false) {
    return `${path}: additional properties accepted previously would now be rejected`;
  }
  if (sourceAdditional === true) {
    return `${path}: additional properties are now constrained`;
  }
  return schemaSubsetIssue(
    sourceAdditional,
    targetAdditional,
    `${path}.*`,
    context,
  );
}

function arraySubsetIssue(
  source: SchemaObject,
  target: SchemaObject,
  path: string,
  context: CompatibilityContext,
): string | undefined {
  const sourceItems = source.items ?? true;
  const targetItems = target.items ?? true;
  return schemaSubsetIssue(sourceItems, targetItems, `${path}[]`, context);
}

function literalSubsetIssue(
  source: SchemaObject,
  target: SchemaObject,
  path: string,
): string | undefined {
  const sourceValues = allowedLiteralValues(source);
  const targetValues = allowedLiteralValues(target);
  if (!targetValues) return undefined;
  if (!sourceValues) {
    return `${path}: enum/const became more restrictive`;
  }
  if (
    sourceValues.some((sourceValue) =>
      !targetValues.some((targetValue) => deepEqual(sourceValue, targetValue))
    )
  ) {
    return `${path}: enum/const no longer accepts every previous value`;
  }
  return undefined;
}

function allowedLiteralValues(
  schema: SchemaObject,
): readonly unknown[] | undefined {
  if (Object.hasOwn(schema, "const")) return [schema.const];
  return schema.enum;
}

function typeSubsetIssue(
  source: SchemaObject,
  target: SchemaObject,
  path: string,
): string | undefined {
  const sourceTypes = schemaTypes(source);
  const targetTypes = schemaTypes(target);
  if (targetTypes === undefined || targetTypes.includes("unknown")) {
    return undefined;
  }
  if (sourceTypes === undefined || sourceTypes.includes("unknown")) {
    return `${path}: the candidate no longer accepts every previous type`;
  }
  const rejected = sourceTypes.find((sourceType) =>
    !targetTypes.some((targetType) =>
      sourceType === targetType ||
      (sourceType === "integer" && targetType === "number")
    )
  );
  return rejected === undefined
    ? undefined
    : `${path}: type ${rejected} is not accepted by the candidate schema`;
}

function scalarConstraintSubsetIssue(
  source: SchemaObject,
  target: SchemaObject,
  path: string,
): string | undefined {
  const lowerBounds = [
    "minimum",
    "exclusiveMinimum",
    "minLength",
    "minItems",
    "minProperties",
  ] as const;
  for (const key of lowerBounds) {
    const sourceValue = source[key];
    const targetValue = target[key];
    if (
      targetValue !== undefined &&
      (sourceValue === undefined || sourceValue < targetValue)
    ) {
      return `${path}: ${key} became more restrictive`;
    }
  }

  const upperBounds = [
    "maximum",
    "exclusiveMaximum",
    "maxLength",
    "maxItems",
    "maxProperties",
  ] as const;
  for (const key of upperBounds) {
    const sourceValue = source[key];
    const targetValue = target[key];
    if (
      targetValue !== undefined &&
      (sourceValue === undefined || sourceValue > targetValue)
    ) {
      return `${path}: ${key} became more restrictive`;
    }
  }

  if (target.uniqueItems === true && source.uniqueItems !== true) {
    return `${path}: uniqueItems became more restrictive`;
  }
  if (target.pattern !== undefined && source.pattern !== target.pattern) {
    return `${path}: pattern changed in a way compatibility checking cannot prove safe`;
  }
  if (target.format !== undefined && source.format !== target.format) {
    return `${path}: format changed in a way compatibility checking cannot prove safe`;
  }
  if (target.multipleOf !== undefined) {
    if (
      source.multipleOf === undefined ||
      source.multipleOf % target.multipleOf !== 0
    ) {
      return `${path}: multipleOf became more restrictive`;
    }
  }
  return undefined;
}

function schemaAlternatives(schema: SchemaObject): JSONSchema[] | undefined {
  if (schema.anyOf) return [...schema.anyOf];
  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => ({ ...schema, type }));
  }
  return undefined;
}

function schemaTypes(schema: SchemaObject): readonly string[] | undefined {
  if (schema.type === undefined) return undefined;
  return typeof schema.type === "string" ? [schema.type] : schema.type;
}

function declaresObjectShape(schema: SchemaObject): boolean {
  return schemaTypes(schema)?.includes("object") === true ||
    schema.properties !== undefined || schema.required !== undefined ||
    schema.additionalProperties !== undefined;
}

function declaresArrayShape(schema: SchemaObject): boolean {
  return schemaTypes(schema)?.includes("array") === true ||
    schema.items !== undefined;
}

function schemaProvidesDefault(schema: JSONSchema | undefined): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  if (Object.hasOwn(schema, "default")) return true;
  return schema.type === "object" && schema.properties !== undefined &&
    Object.values(schema.properties).some(schemaProvidesDefault);
}

function resolveSchema(
  schema: JSONSchema,
  root: JSONSchema,
): JSONSchema | undefined {
  if (typeof schema !== "object" || schema === null || !schema.$ref) {
    return schema;
  }
  if (!schema.$ref.startsWith("#/")) return undefined;
  let value: unknown = root;
  for (const encodedSegment of schema.$ref.slice(2).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof value !== "object" || value === null || !(segment in value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === "boolean" ||
      (typeof value === "object" && value !== null)
    ? value as JSONSchema
    : undefined;
}

function pairIsActive(
  source: object,
  target: object,
  activePairs: WeakMap<object, WeakSet<object>>,
): boolean {
  return activePairs.get(source)?.has(target) === true;
}

function markPairActive(
  source: object,
  target: object,
  activePairs: WeakMap<object, WeakSet<object>>,
): void {
  let targets = activePairs.get(source);
  if (!targets) {
    targets = new WeakSet();
    activePairs.set(source, targets);
  }
  targets.add(target);
}

function unmarkPairActive(
  source: object,
  target: object,
  activePairs: WeakMap<object, WeakSet<object>>,
): void {
  activePairs.get(source)?.delete(target);
}

function unknownKeywordIssue(
  source: SchemaObject,
  target: SchemaObject,
  path: string,
): string | undefined {
  const handled = new Set([
    ...ANNOTATION_KEYS,
    ...COMPLEX_CONSTRAINT_KEYS,
    ...SEMANTIC_EXTENSION_KEYS,
    "$ref",
    "additionalProperties",
    "anyOf",
    "const",
    "enum",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "format",
    "items",
    "maxItems",
    "maxLength",
    "maxProperties",
    "maximum",
    "minItems",
    "minLength",
    "minProperties",
    "minimum",
    "multipleOf",
    "oneOf",
    "pattern",
    "properties",
    "required",
    "type",
    "uniqueItems",
  ]);
  const keys = new Set([...Object.keys(source), ...Object.keys(target)]);
  const sourceRecord = source as Record<string, unknown>;
  const targetRecord = target as Record<string, unknown>;
  for (const key of keys) {
    if (
      !handled.has(key) &&
      !deepEqual(sourceRecord[key], targetRecord[key])
    ) {
      return `${path}: ${key} changed in a way compatibility checking cannot prove safe`;
    }
  }
  return undefined;
}
