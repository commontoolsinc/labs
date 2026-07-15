import {
  deepEqual,
  extractDefaultValues,
  type JSONSchema,
  type Pattern,
} from "@commonfabric/runner";
import {
  cfcSchemaChildRoot,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
  validateSchemaDefinition,
  validateSchemaValue,
} from "@commonfabric/runner/cfc";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import {
  type FabricValue,
  valueEqual,
} from "@commonfabric/data-model/fabric-value";

type SchemaObject = Exclude<JSONSchema, boolean>;
type SchemaRole = "argument" | "result";

interface CompatibilityContext {
  sourceRoot: JSONSchema;
  targetRoot: JSONSchema;
  role: SchemaRole;
  activePairs: ActivePairsByRoot;
}

type ActivePairsByRoot = WeakMap<
  object,
  WeakMap<object, WeakMap<object, WeakSet<object>>>
>;

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

const fabricAwareEqual = (left: unknown, right: unknown): boolean => {
  try {
    return valueEqual(left as FabricValue, right as FabricValue);
  } catch {
    return deepEqual(left, right);
  }
};

/**
 * Reject a piece update unless its argument and result schemas preserve the
 * contracts of the currently running pattern.
 *
 * Arguments are contravariant and results are covariant. Open argument objects
 * may still gain optional/defaulted named fields as the piece-evolution policy;
 * the runner validates the piece's merged durable arguments against the new
 * schema transactionally before committing such an update.
 */
export function assertPatternSchemasBackwardCompatible(
  previous: Pattern,
  candidate: Pattern,
): void {
  const issues: string[] = [];
  for (
    const [label, schema] of [
      ["previous argument", previous.argumentSchema],
      ["candidate argument", candidate.argumentSchema],
      ["previous result", previous.resultSchema],
      ["candidate result", candidate.resultSchema],
    ] as const
  ) {
    const issue = validateSchemaDefinition(schema);
    if (issue !== undefined) {
      issues.push(`${label} has an invalid schema: ${issue}`);
    }
  }
  if (issues.length > 0) {
    throw new Error(
      `Pattern schemas are not backward compatible:\n${
        issues.map((issue) => `- ${issue}`).join("\n")
      }`,
    );
  }

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
  const sourceResolution = resolveSchema(sourceInput, context.sourceRoot);
  const targetResolution = resolveSchema(targetInput, context.targetRoot);
  if (
    sourceResolution.schema === undefined ||
    targetResolution.schema === undefined
  ) {
    return `${path}: cannot resolve a local schema reference`;
  }
  const source = sourceResolution.schema;
  const target = targetResolution.schema;
  context = {
    ...context,
    sourceRoot: sourceResolution.root,
    targetRoot: targetResolution.root,
  };
  if (schemasResolveEqually(source, target, context)) return undefined;

  if (source === false || target === true) return undefined;
  if (source === true) {
    return target === false
      ? `${path}: the candidate schema rejects values accepted previously`
      : `${path}: an unconstrained schema is no longer accepted`;
  }
  if (target === false) {
    return `${path}: the candidate schema rejects values accepted previously`;
  }

  if (pairIsActive(source, target, context)) return undefined;
  markPairActive(source, target, context);
  try {
    const sourceAlternatives = schemaAlternatives(source);
    const targetAlternatives = schemaAlternatives(target);
    if (sourceAlternatives || targetAlternatives) {
      const sources = sourceAlternatives ?? [[source]];
      const targets = targetAlternatives ?? [[target]];
      for (const sourceAlternative of sources) {
        const accepted = targets.some((targetAlternative) =>
          schemaConjunctionSubsetIssue(
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
      if (!fabricAwareEqual(source[key], target[key])) {
        return `${path}: ${key} changed`;
      }
    }

    for (const key of COMPLEX_CONSTRAINT_KEYS) {
      if (
        !schemasResolveEqually(
          { [key]: source[key] },
          { [key]: target[key] },
          context,
        )
      ) {
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
    unmarkPairActive(source, target, context);
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
  const previousPatternProperties = context.role === "argument"
    ? source.patternProperties
    : target.patternProperties;

  for (const property of Object.keys(previousProperties)) {
    if (!Object.hasOwn(candidateProperties, property)) {
      return `${path}.${property}: existing ${context.role} field was removed`;
    }
  }

  const sourceRequired = new Set(source.required ?? []);
  const targetRequired = new Set(target.required ?? []);
  if (context.role === "argument") {
    for (const property of targetRequired) {
      if (
        !sourceRequired.has(property) &&
        !schemaProvidesValidDefault(
          targetProperties[property],
          context.targetRoot,
        )
      ) {
        return `${path}.${property}: newly required argument field has no default`;
      }
    }

    const previousAdditional = source.additionalProperties ?? true;
    for (const property of Object.keys(candidateProperties)) {
      const matchedPatterns = matchingPatternPropertySchemas(
        previousPatternProperties,
        property,
      );
      if (typeof matchedPatterns === "string") {
        return `${path}: ${matchedPatterns}`;
      }
      for (const patternSchema of matchedPatterns) {
        const issue = schemaSubsetIssue(
          patternSchema,
          targetProperties[property],
          `${path}.${property}`,
          context,
        );
        if (issue) return issue;
      }
      // Open objects remain evolvable by adding optional/defaulted fields.
      // A typed index signature is different: it promised that every unknown
      // property accepted values of that type, including this newly named one.
      if (
        Object.hasOwn(previousProperties, property) ||
        matchedPatterns.length > 0 ||
        typeof previousAdditional === "boolean"
      ) {
        continue;
      }
      const issue = schemaSubsetIssue(
        previousAdditional,
        targetProperties[property],
        `${path}.${property}`,
        context,
      );
      if (issue) return issue;
    }
  } else {
    for (const property of targetRequired) {
      if (!sourceRequired.has(property)) {
        return `${path}.${property}: result field is no longer required`;
      }
    }
    for (const property of sourceRequired) {
      if (
        !Object.hasOwn(targetProperties, property) &&
        !schemaProvidesValidDefault(
          sourceProperties[property],
          context.sourceRoot,
        )
      ) {
        return `${path}.${property}: newly required result field has no default`;
      }
    }

    const previousAdditional = target.additionalProperties ?? true;
    for (const property of Object.keys(candidateProperties)) {
      const matchedPatterns = matchingPatternPropertySchemas(
        previousPatternProperties,
        property,
      );
      if (typeof matchedPatterns === "string") {
        return `${path}: ${matchedPatterns}`;
      }
      for (const patternSchema of matchedPatterns) {
        const issue = schemaSubsetIssue(
          sourceProperties[property],
          patternSchema,
          `${path}.${property}`,
          context,
        );
        if (issue) return issue;
      }
      if (
        Object.hasOwn(previousProperties, property) ||
        matchedPatterns.length > 0 ||
        previousAdditional === true
      ) {
        continue;
      }
      if (previousAdditional === false) {
        return `${path}.${property}: new result field is rejected by the previous additionalProperties contract`;
      }
      const issue = schemaSubsetIssue(
        sourceProperties[property],
        previousAdditional,
        `${path}.${property}`,
        context,
      );
      if (issue) return issue;
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

function matchingPatternPropertySchemas(
  patternProperties: Record<string, JSONSchema> | undefined,
  property: string,
): JSONSchema[] | string {
  const matches: JSONSchema[] = [];
  for (const [source, schema] of Object.entries(patternProperties ?? {})) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(source);
    } catch {
      return `invalid patternProperties expression ${source}`;
    }
    if (pattern.test(property)) matches.push(schema);
  }
  return matches;
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
      !targetValues.some((targetValue) =>
        fabricAwareEqual(sourceValue, targetValue)
      )
    )
  ) {
    return `${path}: enum/const no longer accepts every previous value`;
  }
  return undefined;
}

function allowedLiteralValues(
  schema: SchemaObject,
): readonly unknown[] | undefined {
  if (Object.hasOwn(schema, "const")) {
    return schema.enum === undefined ||
        schema.enum.some((value) => fabricAwareEqual(value, schema.const))
      ? [schema.const]
      : [];
  }
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

function schemaAlternatives(
  schema: SchemaObject,
): JSONSchema[][] | undefined {
  if (schema.anyOf) {
    const { anyOf, ...base } = schema;
    return anyOf.map((branch) => [base, branch]);
  }
  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => [{ ...schema, type }]);
  }
  return undefined;
}

/**
 * Prove that one schema conjunction is a subset of another. Each target
 * constraint must be implied by at least one source constraint. This is
 * deliberately conservative: two source constraints might jointly imply a
 * target constraint that neither proves alone, in which case we reject the
 * update rather than risk accepting an incompatible one.
 */
function schemaConjunctionSubsetIssue(
  source: readonly JSONSchema[],
  target: readonly JSONSchema[],
  path: string,
  context: CompatibilityContext,
): string | undefined {
  for (const targetConstraint of target) {
    const implied = source.some((sourceConstraint) =>
      schemaSubsetIssue(
        sourceConstraint,
        targetConstraint,
        path,
        context,
      ) === undefined
    );
    if (!implied) {
      return `${path}: a schema alternative accepted previously is not accepted by the candidate`;
    }
  }
  return undefined;
}

function schemaTypes(schema: SchemaObject): readonly string[] | undefined {
  if (schema.type === undefined) return undefined;
  return typeof schema.type === "string" ? [schema.type] : schema.type;
}

function schemasResolveEqually(
  source: unknown,
  target: unknown,
  context: CompatibilityContext,
): boolean {
  if (!fabricAwareEqual(source, target)) return false;

  const refs = new Set<string>();
  collectSchemaReferences(source, refs, new WeakSet());
  for (const ref of refs) {
    const sourceResolved = resolveCfcSchemaRefs(
      { $ref: ref },
      context.sourceRoot,
    );
    const targetResolved = resolveCfcSchemaRefs(
      { $ref: ref },
      context.targetRoot,
    );
    if (
      sourceResolved === undefined || targetResolved === undefined ||
      !fabricAwareEqual(sourceResolved, targetResolved)
    ) {
      return false;
    }
  }
  return true;
}

function collectSchemaReferences(
  value: unknown,
  refs: Set<string>,
  seen: WeakSet<object>,
): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string") refs.add(record.$ref);

  for (
    const key of [
      "additionalProperties",
      "contains",
      "contentSchema",
      "else",
      "if",
      "items",
      "not",
      "propertyNames",
      "then",
    ]
  ) {
    collectSchemaReferences(record[key], refs, seen);
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const children = record[key];
    if (Array.isArray(children)) {
      for (const child of children) {
        collectSchemaReferences(child, refs, seen);
      }
    }
  }
  for (
    const key of [
      "$defs",
      "definitions",
      "dependentSchemas",
      "patternProperties",
      "properties",
    ]
  ) {
    const children = record[key];
    if (children !== null && typeof children === "object") {
      for (const child of Object.values(children)) {
        collectSchemaReferences(child, refs, seen);
      }
    }
  }
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

function schemaProvidesValidDefault(
  schema: JSONSchema | undefined,
  fullSchema: JSONSchema,
): boolean {
  if (schema === undefined) return false;
  const value = extractDefaultValues(schema, fullSchema);
  return value !== undefined &&
    validateSchemaValue(schema, value, fullSchema) === undefined;
}

function resolveSchema(
  schema: JSONSchema,
  root: JSONSchema,
): { schema: JSONSchema | undefined; root: JSONSchema } {
  const schemaRoot = cfcSchemaChildRoot(schema, root);
  const hasRef = typeof schema === "object" && schema !== null &&
    typeof schema.$ref === "string";
  const owningRoot = hasRef
    ? resolveCfcSchemaRefRoot(schema, schemaRoot)
    : schemaRoot;
  const resolved = hasRef ? resolveCfcSchemaRefs(schema, schemaRoot) : schema;
  return {
    schema: resolved === undefined ? undefined : internSchema(resolved),
    root: resolved === undefined
      ? owningRoot
      : cfcSchemaChildRoot(resolved, owningRoot),
  };
}

function pairIsActive(
  source: object,
  target: object,
  context: CompatibilityContext,
): boolean {
  const sourceRoot = compatibilityRootKey(context.sourceRoot, source);
  const targetRoot = compatibilityRootKey(context.targetRoot, target);
  return context.activePairs.get(sourceRoot)?.get(targetRoot)?.get(source)?.has(
    target,
  ) === true;
}

function markPairActive(
  source: object,
  target: object,
  context: CompatibilityContext,
): void {
  const sourceRoot = compatibilityRootKey(context.sourceRoot, source);
  const targetRoot = compatibilityRootKey(context.targetRoot, target);
  let byTargetRoot = context.activePairs.get(sourceRoot);
  if (!byTargetRoot) {
    byTargetRoot = new WeakMap();
    context.activePairs.set(sourceRoot, byTargetRoot);
  }
  let bySource = byTargetRoot.get(targetRoot);
  if (!bySource) {
    bySource = new WeakMap();
    byTargetRoot.set(targetRoot, bySource);
  }
  let targets = bySource.get(source);
  if (!targets) {
    targets = new WeakSet();
    bySource.set(source, targets);
  }
  targets.add(target);
}

function unmarkPairActive(
  source: object,
  target: object,
  context: CompatibilityContext,
): void {
  const sourceRoot = compatibilityRootKey(context.sourceRoot, source);
  const targetRoot = compatibilityRootKey(context.targetRoot, target);
  context.activePairs.get(sourceRoot)?.get(targetRoot)?.get(source)?.delete(
    target,
  );
}

function compatibilityRootKey(
  root: JSONSchema,
  fallback: object,
): object {
  return typeof root === "object" && root !== null ? root : fallback;
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
      !fabricAwareEqual(sourceRecord[key], targetRecord[key])
    ) {
      return `${path}: ${key} changed in a way compatibility checking cannot prove safe`;
    }
  }
  return undefined;
}
