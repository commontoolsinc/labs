import type { ImmutableJSONValue, JSONSchema } from "@commonfabric/api";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  cloneIfNecessary,
  type FabricPlainObject,
  type FabricValue,
  isFabricPlainObject,
  valueEqual,
} from "@commonfabric/data-model/fabric-value";
import { deepFrozenCloneAndInternSchema } from "@commonfabric/data-model/schema-hash";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";
import { uniqueCfcAtoms } from "./observation.ts";
import {
  cfcSchemaChildRoot,
  resolveCfcSchemaRef,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
} from "./schema-refs.ts";
import {
  DEFAULT_EXCHANGE_FUEL,
  evaluateExchangeRules,
} from "./exchange-eval.ts";
import { buildCfcPolicySnapshot } from "./policy.ts";
import { clauseAlternatives, isOrClause } from "./clause.ts";
import {
  MATERIAL_RISK_DISCHARGE_KINDS,
  MATERIAL_RISK_DISCHARGE_POLICY,
} from "./standard-profile.ts";

export const INJECTION_SAFE_ATOM = {
  type: CFC_ATOM_TYPE.InjectionSafe,
} as const satisfies ImmutableJSONValue;

const PROMPT_INJECTION_RISK_KINDS = new Set(MATERIAL_RISK_DISCHARGE_KINDS);

// The material-risk discharge rules, built once. The sanitizer runs them over
// an instruction-inert path's observed confidentiality with its freshly-minted
// InjectionSafe — the discharge is now an ordinary exchange-rule firing (Epic
// B6), not a hardcoded strip. Trusted, local, and unconditional (independent of
// the global cfcPolicyEvaluation dial): §10.1 sanctions the trusted-schema
// sanitizer's InjectionSafe mint + discharge as the profile's own transition
// rule. This uses the SANITIZER-only policy, not the deployment profile:
// bare-InjectionSafe discharge is value-local here (one path, that path's
// evidence) but would be cross-value at a tx-wide boundary.
const MATERIAL_RISK_SNAPSHOT = buildCfcPolicySnapshot(
  MATERIAL_RISK_DISCHARGE_POLICY,
);

type AnnotationResult = {
  schema: JSONSchema;
  instructionInert: boolean;
};

interface AnnotationRefVisit {
  root: object;
  ref: string;
  parent?: AnnotationRefVisit;
}

const asTypeArray = (type: unknown): string[] =>
  Array.isArray(type)
    ? type.filter((entry): entry is string => typeof entry === "string")
    : typeof type === "string"
    ? [type]
    : [];

const isFabricPlainObjectValue = (
  value: unknown,
): value is FabricPlainObject => isFabricPlainObject(value as FabricValue);

export const isPrimitiveJsonValue = (value: unknown): boolean =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

const cloneJson = <T>(value: T): T =>
  cloneIfNecessary(value as FabricValue, { frozen: true }) as T;

const uniqueAtoms = (
  atoms: Iterable<unknown>,
): ImmutableJSONValue[] => uniqueCfcAtoms(atoms).map((atom) => cloneJson(atom));

export const isPromptInjectionMaterialRiskAtom = (atom: unknown): boolean => {
  if (typeof atom === "string") {
    return PROMPT_INJECTION_RISK_KINDS.has(atom);
  }
  return isRecord(atom) &&
    atom.type === CFC_ATOM_TYPE.Caveat &&
    typeof atom.kind === "string" &&
    PROMPT_INJECTION_RISK_KINDS.has(atom.kind);
};

// Discharge material-risk caveats from an instruction-inert path's
// confidentiality by running the standard §10.1 profile's material-risk
// discharge rules with the path's minted InjectionSafe as integrity evidence
// (Epic B6 — this REPLACES the old hardcoded `filterMaterialRiskAtoms` strip
// with an ordinary exchange-rule firing; `cfc-standard-profile.test.ts` proves
// byte-for-byte equivalence). A dropClause rule removes a bare material-risk
// atom AND a material-risk alternative nested inside an OR-clause
// (`{anyOf:[risk, A]}` → `A`) — descending is load-bearing: a hidden caveat
// alternative is not more-restrictive when preserved (a ceiling naming the
// sibling subsumes the whole clause), so it must be discharged, not left.
// Legacy §4.7.3 bare-STRING material-risk atoms — e.g. the raw string
// "prompt-injection-risk" rather than a `{type:Caveat,kind}` record — predate
// the caveat-record form. The discharge rules all match `{type:Caveat,kind}`,
// so a bare string never fires one and would survive, regressing the old
// strip's byte-for-byte reach (which classified the string form too). Normalize
// any bare-string material-risk atom — top-level or nested as an OR-clause
// alternative — into its canonical caveat-record form (§10.1 SHOULD-normalize
// aliases before evaluation) so the ordinary rule then drops it. Non-risk
// strings are left untouched (no rule matches them, exactly as before). This
// keeps discharge a single rule-driven mechanism rather than reintroducing a
// hardcoded strip (codex P2 on #4567).
const normalizeMaterialRiskStringForms = (clause: unknown): unknown => {
  if (typeof clause === "string") {
    return PROMPT_INJECTION_RISK_KINDS.has(clause)
      ? { type: CFC_ATOM_TYPE.Caveat, kind: clause }
      : clause;
  }
  if (isOrClause(clause)) {
    return {
      anyOf: clause.anyOf.map((alternative) =>
        typeof alternative === "string" &&
          PROMPT_INJECTION_RISK_KINDS.has(alternative)
          ? { type: CFC_ATOM_TYPE.Caveat, kind: alternative }
          : alternative
      ),
    };
  }
  return clause;
};

export const dischargeMaterialRiskAtoms = (
  atoms: readonly unknown[],
): ImmutableJSONValue[] => {
  // Fuel budget scaled to the label (cubic P2 on #4567): the default 64 would
  // exhaust on a label with more than ~64 droppable alternatives, and the
  // sanitizer would then keep every material-risk caveat — a regression from
  // the old strip, which removed ALL of them. This rule set is add-free (only
  // drops), so it terminates in at most one firing per material-risk
  // alternative; budgeting one per alternative plus the default headroom
  // covers any label without ever risking a real (add/drop-cycle) runaway,
  // which this set cannot have.
  const normalized = atoms.map(normalizeMaterialRiskStringForms);
  const alternativeCount = normalized.reduce(
    (total: number, clause) => total + clauseAlternatives(clause).length,
    0,
  );
  const result = evaluateExchangeRules(
    { confidentiality: normalized },
    MATERIAL_RISK_SNAPSHOT,
    { integrity: [INJECTION_SAFE_ATOM] },
    alternativeCount + DEFAULT_EXCHANGE_FUEL,
  );
  // Fixpoint over the finite add-free discharge rule set cannot exhaust with
  // the budget above, but fail safe if it ever did: keep the un-discharged
  // (more-restrictive) label.
  return uniqueAtoms(
    result.exhausted ? atoms : result.label.confidentiality ?? [],
  );
};

const mergeIfc = (
  schema: Record<string, unknown>,
  {
    observedConfidentiality,
    instructionInert,
  }: {
    observedConfidentiality: readonly unknown[];
    instructionInert: boolean;
  },
): Record<string, unknown> => {
  const existingIfc = isRecord(schema.ifc) ? schema.ifc : {};
  const retainedConfidentiality = instructionInert
    ? dischargeMaterialRiskAtoms(observedConfidentiality)
    : uniqueAtoms(observedConfidentiality);
  const nextIfc: Record<string, unknown> = { ...existingIfc };

  const confidentiality = uniqueAtoms([
    ...(Array.isArray(existingIfc.confidentiality)
      ? existingIfc.confidentiality
      : []),
    ...retainedConfidentiality,
  ]);
  if (confidentiality.length > 0) {
    nextIfc.confidentiality = confidentiality;
  }

  if (instructionInert) {
    nextIfc.addIntegrity = uniqueAtoms([
      ...(Array.isArray(existingIfc.addIntegrity)
        ? existingIfc.addIntegrity
        : []),
      INJECTION_SAFE_ATOM,
    ]);
  }

  return Object.keys(nextIfc).length > 0 ? { ...schema, ifc: nextIfc } : schema;
};

const schemaHasSafeEnum = (schema: Record<string, unknown>): boolean =>
  Array.isArray(schema.enum) && schema.enum.length > 0 &&
  schema.enum.every(isPrimitiveJsonValue);

const schemaHasSafeConst = (schema: Record<string, unknown>): boolean =>
  Object.hasOwn(schema, "const") && isPrimitiveJsonValue(schema.const);

const primitiveTypeIsInstructionInert = (
  schema: Record<string, unknown>,
): boolean => {
  if (schemaHasSafeEnum(schema) || schemaHasSafeConst(schema)) {
    return true;
  }
  const types = asTypeArray(schema.type);
  return types.length > 0 &&
    types.every((type) =>
      type === "number" ||
      type === "integer" ||
      type === "boolean" ||
      type === "null" ||
      type === "undefined"
    );
};

const schemaDeclaresObjectShape = (schema: Record<string, unknown>): boolean =>
  asTypeArray(schema.type).includes("object") ||
  schema.properties !== undefined ||
  schema.required !== undefined ||
  schema.additionalProperties !== undefined;

// Deliberate deviation from JSON Schema defaults: standard JSON Schema treats
// missing `additionalProperties` as permissive (effectively `true`). For
// instruction-inertness analysis we treat it as closed unless explicitly
// declared open, so authors must opt in to free-form properties before we'll
// allow taint to escape through them. Don't "fix" this back to spec defaults
// without revisiting the sanitizer's caller assumptions.
export const cfcObjectSchemaIsClosed = (
  schema: Record<string, unknown>,
): boolean =>
  schemaDeclaresObjectShape(schema) &&
  schema.additionalProperties !== true &&
  typeof schema.additionalProperties !== "object";

export const resolveSchemaForValidation = (
  schema: JSONSchema,
  fullSchema: JSONSchema,
): JSONSchema =>
  isRecord(schema) && typeof schema.$ref === "string"
    ? resolveCfcSchemaRefs(schema, fullSchema) ?? false
    : schema;

const annotateSchema = (
  schema: JSONSchema,
  observedConfidentiality: readonly unknown[],
  fullSchema: JSONSchema,
  visitedRef?: AnnotationRefVisit,
): AnnotationResult => {
  if (typeof schema === "boolean") {
    return { schema, instructionInert: false };
  }

  const schemaRoot = cfcSchemaChildRoot(schema, fullSchema);
  const rootKey = isRecord(schemaRoot) ? schemaRoot : schema;

  // $ref cycle guard: resolveSchemaRefs only detects cycles within a single
  // call, but annotateSchema recurses across resolutions. A local ref string
  // is only meaningful together with its owning root.
  const directRef = typeof schema.$ref === "string" ? schema.$ref : undefined;
  let cursor = visitedRef;
  while (directRef !== undefined && cursor !== undefined) {
    if (cursor.root === rootKey && cursor.ref === directRef) {
      return {
        schema: observedConfidentiality.length > 0
          ? mergeIfc({ ...schema }, {
            observedConfidentiality,
            instructionInert: false,
          }) as JSONSchema
          : schema,
        instructionInert: false,
      };
    }
    cursor = cursor.parent;
  }
  const nextVisited = directRef !== undefined
    ? { root: rootKey, ref: directRef, parent: visitedRef }
    : visitedRef;

  const resolved = resolveSchemaForValidation(schema, schemaRoot);
  if (resolved !== schema) {
    const resolvedRoot = cfcSchemaChildRoot(
      resolved,
      resolveCfcSchemaRefRoot(schema, schemaRoot),
    );
    const annotated = annotateSchema(
      resolved,
      observedConfidentiality,
      resolvedRoot,
      nextVisited,
    );
    return {
      schema: mergeIfc({ ...schema }, {
        observedConfidentiality,
        instructionInert: annotated.instructionInert,
      }) as JSONSchema,
      instructionInert: annotated.instructionInert,
    };
  }

  const types = asTypeArray(schema.type);
  const typeSet = new Set(types);

  if (primitiveTypeIsInstructionInert(schema)) {
    return {
      schema: mergeIfc({ ...schema }, {
        observedConfidentiality,
        instructionInert: true,
      }) as JSONSchema,
      instructionInert: true,
    };
  }

  if (
    Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf) ||
    Array.isArray(schema.allOf)
  ) {
    const branches = [
      ...(schema.anyOf ?? []),
      ...(schema.oneOf ?? []),
      ...(schema.allOf ?? []),
    ];
    const annotatedBranches = branches.map((branch) =>
      annotateSchema(branch, observedConfidentiality, schemaRoot, nextVisited)
    );
    const instructionInert = annotatedBranches.length > 0 &&
      annotatedBranches.every((branch) => branch.instructionInert);
    return {
      schema: mergeIfc({
        ...schema,
        ...(schema.anyOf
          ? {
            anyOf: annotatedBranches.slice(0, schema.anyOf.length).map((
              branch,
            ) => branch.schema),
          }
          : {}),
        ...(schema.oneOf
          ? {
            oneOf: annotatedBranches.slice(
              schema.anyOf?.length ?? 0,
              (schema.anyOf?.length ?? 0) + schema.oneOf.length,
            ).map((branch) => branch.schema),
          }
          : {}),
        ...(schema.allOf
          ? {
            allOf: annotatedBranches.slice(
              (schema.anyOf?.length ?? 0) + (schema.oneOf?.length ?? 0),
            ).map((branch) => branch.schema),
          }
          : {}),
      }, { observedConfidentiality, instructionInert }) as JSONSchema,
      instructionInert,
    };
  }

  if (typeSet.has("object") || schema.properties !== undefined) {
    const annotatedProperties: Record<string, JSONSchema> = {};
    const childResults = Object.entries(schema.properties ?? {}).map((
      [key, child],
    ) => {
      const annotated = annotateSchema(
        child,
        observedConfidentiality,
        schemaRoot,
        nextVisited,
      );
      annotatedProperties[key] = annotated.schema;
      return annotated;
    });
    const closedObject = cfcObjectSchemaIsClosed(schema);
    const allChildrenInert = childResults.every((child) =>
      child.instructionInert
    );
    const instructionInert = closedObject && allChildrenInert;
    const shouldTaintRoot = observedConfidentiality.length > 0 &&
      !instructionInert &&
      !closedObject;
    const next = {
      ...schema,
      ...(schema.properties !== undefined
        ? { properties: annotatedProperties }
        : {}),
    };
    return {
      schema: mergeIfc(next, {
        observedConfidentiality: shouldTaintRoot ? observedConfidentiality : [],
        instructionInert,
      }) as JSONSchema,
      instructionInert,
    };
  }

  if (typeSet.has("array") && typeof schema.items === "object") {
    const child = annotateSchema(
      schema.items,
      observedConfidentiality,
      schemaRoot,
      nextVisited,
    );
    const instructionInert = child.instructionInert;
    return {
      schema: mergeIfc({
        ...schema,
        items: child.schema,
      }, { observedConfidentiality, instructionInert }) as JSONSchema,
      instructionInert,
    };
  }

  return {
    schema: observedConfidentiality.length > 0
      ? mergeIfc({ ...schema }, {
        observedConfidentiality,
        instructionInert: false,
      }) as JSONSchema
      : schema,
    instructionInert: false,
  };
};

export const schemaWithInjectionSafeAnnotations = (
  schema: JSONSchema,
  observedConfidentiality: readonly unknown[] = [],
): JSONSchema => {
  const clone = cloneJson(schema);
  return stripRequiredFields(
    annotateSchema(clone, observedConfidentiality, clone).schema,
  );
};

const stripRequiredFields = (schema: JSONSchema): JSONSchema => {
  if (typeof schema === "boolean") {
    return schema;
  }

  const { required: _required, ...rest } = schema as any;
  const result: Record<string, unknown> = { ...rest };

  if (isRecord(result.properties)) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([key, value]) => [
        key,
        stripRequiredFields(value as JSONSchema),
      ]),
    );
  }
  if (typeof result.items === "object" && result.items !== null) {
    result.items = stripRequiredFields(result.items as JSONSchema);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as JSONSchema[]).map(stripRequiredFields);
    }
  }
  if (typeof result.not === "object" && result.not !== null) {
    result.not = stripRequiredFields(result.not as JSONSchema);
  }

  return result as JSONSchema;
};

const typeMatches = (
  value: unknown,
  type: string,
  rejectUnknownType: boolean,
): boolean => {
  switch (type) {
    case "unknown":
      return true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "undefined":
      return value === undefined;
    case "array":
      return Array.isArray(value);
    case "object":
      return isFabricPlainObjectValue(value);
    default:
      return !rejectUnknownType;
  }
};

const schemaValueEqual = (left: unknown, right: unknown): boolean => {
  try {
    return valueEqual(left as FabricValue, right as FabricValue);
  } catch {
    return deepEqual(left, right);
  }
};

const SUPPORTED_SCHEMA_TYPES = new Set([
  "unknown",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
  "undefined",
  "array",
  "object",
]);

const SUPPORTED_SCHEMA_FORMATS = new Set([
  "email",
  "uri",
  "date",
  "date-time",
]);

const isDenseArray = (value: readonly unknown[]): boolean => {
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
};

const schemaTypeDefinitionIssue = (type: unknown): string | undefined => {
  if (type === undefined) return undefined;
  const types = typeof type === "string"
    ? [type]
    : Array.isArray(type)
    ? type
    : undefined;
  if (types === undefined || types.length === 0) {
    return "schema type must be a non-empty string or string array";
  }
  if (!isDenseArray(types)) {
    return "schema type array must not contain holes";
  }
  if (!types.every((entry) => typeof entry === "string")) {
    return "schema type array contains a non-string entry";
  }
  if (new Set(types).size !== types.length) {
    return "schema type array contains duplicate entries";
  }
  const unsupported = types.find((entry) =>
    !SUPPORTED_SCHEMA_TYPES.has(entry as string)
  );
  return unsupported === undefined
    ? undefined
    : `unsupported schema type ${unsupported}`;
};

const strictConstraintDefinitionIssue = (
  schema: Exclude<JSONSchema, boolean>,
): string | undefined => {
  const record = schema as Record<string, unknown>;
  for (
    const key of [
      "minimum",
      "exclusiveMinimum",
      "maximum",
      "exclusiveMaximum",
    ]
  ) {
    if (
      Object.hasOwn(record, key) &&
      (typeof record[key] !== "number" || !Number.isFinite(record[key]))
    ) {
      return `schema ${key} must be a finite number`;
    }
  }
  if (
    Object.hasOwn(record, "multipleOf") &&
    (typeof record.multipleOf !== "number" ||
      !Number.isFinite(record.multipleOf) || record.multipleOf <= 0)
  ) {
    return "schema multipleOf must be a positive finite number";
  }
  for (
    const key of [
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "minProperties",
      "maxProperties",
      "minContains",
      "maxContains",
    ]
  ) {
    if (
      Object.hasOwn(record, key) &&
      (typeof record[key] !== "number" ||
        !Number.isInteger(record[key]) || (record[key] as number) < 0)
    ) {
      return `schema ${key} must be a non-negative integer`;
    }
  }
  if (Object.hasOwn(record, "pattern")) {
    if (typeof record.pattern !== "string") {
      return "schema pattern must be a string";
    }
    try {
      new RegExp(record.pattern);
    } catch {
      return `schema has invalid pattern ${record.pattern}`;
    }
  }
  if (Object.hasOwn(record, "format")) {
    if (
      typeof record.format !== "string" ||
      !SUPPORTED_SCHEMA_FORMATS.has(record.format)
    ) {
      return `schema has unsupported format ${String(record.format)}`;
    }
  }
  for (const source of Object.keys(schema.patternProperties ?? {})) {
    try {
      new RegExp(source);
    } catch {
      return `schema has invalid property pattern ${source}`;
    }
  }
  return undefined;
};

interface SchemaDefinitionContext {
  activeByRoot: WeakMap<object, WeakSet<object>>;
  activeRefsByRoot: WeakMap<object, Set<string>>;
}

/** Validate the schema language understood by strict Fabric migration checks. */
export const validateSchemaDefinition = (
  schema: JSONSchema,
  fullSchema: JSONSchema = schema,
): string | undefined => {
  // Compatibility later interns schemas for root-aware identity tracking.
  // Prove that normalization is safe up front so malformed literal payloads,
  // typed arrays, and raw object-identity cycles become ordinary validation
  // diagnostics instead of escaping as hash/freeze errors.
  try {
    deepFrozenCloneAndInternSchema(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `$: schema cannot be normalized: ${message}`;
  }
  return validateSchemaDefinitionInternal(schema, fullSchema, "$", {
    activeByRoot: new WeakMap(),
    activeRefsByRoot: new WeakMap(),
  });
};

const validateSchemaDefinitionInternal = (
  schema: JSONSchema,
  fullSchema: JSONSchema,
  path: string,
  context: SchemaDefinitionContext,
): string | undefined => {
  if (typeof schema === "boolean") return undefined;
  if (!isRecord(schema) || Array.isArray(schema)) {
    return `${path}: schema must be an object or boolean`;
  }

  const schemaRoot = cfcSchemaChildRoot(schema, fullSchema);
  const rootKey = isRecord(schemaRoot) ? schemaRoot : schema;
  let active = context.activeByRoot.get(rootKey);
  if (active?.has(schema)) return undefined;
  if (!active) {
    active = new WeakSet();
    context.activeByRoot.set(rootKey, active);
  }
  active.add(schema);

  try {
    if (Object.hasOwn(schema, "$ref")) {
      if (typeof schema.$ref !== "string" || schema.$ref.length === 0) {
        return `${path}: schema $ref must be a non-empty string`;
      }
      let activeRefs = context.activeRefsByRoot.get(rootKey);
      if (activeRefs?.has(schema.$ref)) return undefined;
      if (!activeRefs) {
        activeRefs = new Set();
        context.activeRefsByRoot.set(rootKey, activeRefs);
      }
      activeRefs.add(schema.$ref);
      const resolved = resolveCfcSchemaRef(schemaRoot, schema.$ref);
      if (resolved === undefined) {
        activeRefs.delete(schema.$ref);
        return `${path}: cannot resolve schema reference ${schema.$ref}`;
      }
      const resolvedRoot = cfcSchemaChildRoot(
        resolved,
        resolveCfcSchemaRefRoot(schema, schemaRoot),
      );
      const issue = validateSchemaDefinitionInternal(
        resolved,
        resolvedRoot,
        `${path}.$ref`,
        context,
      );
      activeRefs.delete(schema.$ref);
      if (issue !== undefined) return issue;
    }

    const typeIssue = schemaTypeDefinitionIssue(schema.type);
    if (typeIssue !== undefined) return `${path}: ${typeIssue}`;

    for (
      const key of [
        "properties",
        "patternProperties",
        "$defs",
        "definitions",
        "dependentSchemas",
      ] as const
    ) {
      const value = schema[key];
      if (value === undefined) continue;
      if (!isRecord(value) || Array.isArray(value)) {
        return `${path}.${key}: must be an object of schemas`;
      }
    }

    const constraintIssue = strictConstraintDefinitionIssue(schema);
    if (constraintIssue !== undefined) return `${path}: ${constraintIssue}`;

    if (schema.required !== undefined) {
      if (
        !Array.isArray(schema.required) ||
        !isDenseArray(schema.required) ||
        !schema.required.every((entry) => typeof entry === "string") ||
        new Set(schema.required).size !== schema.required.length
      ) {
        return `${path}.required: must be an array of unique strings`;
      }
    }
    if (schema.dependentRequired !== undefined) {
      if (!isRecord(schema.dependentRequired)) {
        return `${path}.dependentRequired: must be an object`;
      }
      for (
        const [key, dependencies] of Object.entries(
          schema.dependentRequired,
        )
      ) {
        if (
          !Array.isArray(dependencies) ||
          !isDenseArray(dependencies) ||
          !dependencies.every((entry) => typeof entry === "string") ||
          new Set(dependencies).size !== dependencies.length
        ) {
          return `${path}.dependentRequired.${key}: must be an array of unique strings`;
        }
      }
    }
    if (
      schema.uniqueItems !== undefined &&
      typeof schema.uniqueItems !== "boolean"
    ) {
      return `${path}.uniqueItems: must be a boolean`;
    }
    if (schema.enum !== undefined) {
      if (
        !Array.isArray(schema.enum) || schema.enum.length === 0 ||
        !isDenseArray(schema.enum)
      ) {
        return `${path}.enum: must be a non-empty array`;
      }
      for (let index = 0; index < schema.enum.length; index++) {
        if (
          schema.enum.slice(0, index).some((entry) =>
            schemaValueEqual(entry, schema.enum![index])
          )
        ) {
          return `${path}.enum: values must be unique`;
        }
      }
    }

    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      const children = schema[key];
      if (children === undefined) continue;
      if (
        !Array.isArray(children) || children.length === 0 ||
        !isDenseArray(children)
      ) {
        return `${path}.${key}: must be a non-empty schema array`;
      }
      for (let index = 0; index < children.length; index++) {
        const issue = validateSchemaDefinitionInternal(
          children[index],
          schemaRoot,
          `${path}.${key}[${index}]`,
          context,
        );
        if (issue !== undefined) return issue;
      }
    }
    if (schema.prefixItems !== undefined) {
      if (
        !Array.isArray(schema.prefixItems) ||
        !isDenseArray(schema.prefixItems)
      ) {
        return `${path}.prefixItems: must be a schema array`;
      }
      for (let index = 0; index < schema.prefixItems.length; index++) {
        const issue = validateSchemaDefinitionInternal(
          schema.prefixItems[index],
          schemaRoot,
          `${path}.prefixItems[${index}]`,
          context,
        );
        if (issue !== undefined) return issue;
      }
    }

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
      ] as const
    ) {
      const child = schema[key];
      if (child === undefined) continue;
      const issue = validateSchemaDefinitionInternal(
        child,
        schemaRoot,
        `${path}.${key}`,
        context,
      );
      if (issue !== undefined) return issue;
    }

    for (
      const key of [
        "properties",
        "patternProperties",
        "$defs",
        "definitions",
        "dependentSchemas",
      ] as const
    ) {
      const children = schema[key];
      if (children === undefined) continue;
      for (const [name, child] of Object.entries(children)) {
        const issue = validateSchemaDefinitionInternal(
          child,
          schemaRoot,
          `${path}.${key}.${name}`,
          context,
        );
        if (issue !== undefined) return issue;
      }
    }

    return undefined;
  } finally {
    active.delete(schema);
  }
};

interface SchemaValidationOptions {
  strictConstraints: boolean;
  implicitAdditionalPropertiesOpen: boolean;
  acceptOpaqueValue?: (
    value: unknown,
    schema: JSONSchema,
    fullSchema: JSONSchema,
  ) => boolean;
}

export interface SchemaValueValidationOptions {
  /**
   * Accept runtime materializations such as Cell handles whose schema was
   * already proven by canonical traversal, without treating the handle object
   * itself as the schema's underlying value.
   */
  acceptOpaqueValue?: (
    value: unknown,
    schema: JSONSchema,
    fullSchema: JSONSchema,
  ) => boolean;
}

const SANITIZATION_VALIDATION: SchemaValidationOptions = {
  strictConstraints: false,
  implicitAdditionalPropertiesOpen: false,
};

const VALUE_VALIDATION: SchemaValidationOptions = {
  strictConstraints: true,
  implicitAdditionalPropertiesOpen: true,
};

interface SchemaValidationContext {
  activeByRoot: WeakMap<object, SchemaRootValidationActivity>;
}

interface SchemaRootValidationActivity {
  activeObjectValues: WeakMap<object, WeakSet<object>>;
  activePrimitiveValues: WeakMap<object, Set<string>>;
}

interface SchemaValidationFailure {
  kind: "mismatch" | "indeterminate";
  message: string;
}

const mismatch = (message: string): SchemaValidationFailure => ({
  kind: "mismatch",
  message,
});

const indeterminate = (message: string): SchemaValidationFailure => ({
  kind: "indeterminate",
  message,
});

const atValidationPath = (
  path: string | number,
  failure: SchemaValidationFailure,
): SchemaValidationFailure => ({
  ...failure,
  message: `${path}: ${failure.message}`,
});

const createSchemaValidationContext = (): SchemaValidationContext => ({
  activeByRoot: new WeakMap(),
});

const primitiveValidationKey = (value: unknown): string =>
  `${typeof value}:${String(value)}`;

const markSchemaValueActive = (
  root: object,
  schema: object,
  value: unknown,
  context: SchemaValidationContext,
): boolean => {
  let activity = context.activeByRoot.get(root);
  if (!activity) {
    activity = {
      activeObjectValues: new WeakMap(),
      activePrimitiveValues: new WeakMap(),
    };
    context.activeByRoot.set(root, activity);
  }
  if (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) {
    const objectValue = value as object;
    let active = activity.activeObjectValues.get(schema);
    if (active?.has(objectValue)) return false;
    if (!active) {
      active = new WeakSet();
      activity.activeObjectValues.set(schema, active);
    }
    active.add(objectValue);
    return true;
  }
  const key = primitiveValidationKey(value);
  let active = activity.activePrimitiveValues.get(schema);
  if (active?.has(key)) return false;
  if (!active) {
    active = new Set();
    activity.activePrimitiveValues.set(schema, active);
  }
  active.add(key);
  return true;
};

const unmarkSchemaValueActive = (
  root: object,
  schema: object,
  value: unknown,
  context: SchemaValidationContext,
): void => {
  const activity = context.activeByRoot.get(root);
  if (!activity) return;
  if (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) {
    activity.activeObjectValues.get(schema)?.delete(value as object);
    return;
  }
  activity.activePrimitiveValues.get(schema)?.delete(
    primitiveValidationKey(value),
  );
};

export const validateSchemaValue = (
  schema: JSONSchema,
  value: unknown,
  fullSchema: JSONSchema = schema,
  validationOptions: SchemaValueValidationOptions = {},
): string | undefined =>
  validateAgainstSchemaInternal(
    schema,
    value,
    fullSchema,
    { ...VALUE_VALIDATION, ...validationOptions },
    createSchemaValidationContext(),
  )?.message;

export const validateAgainstSchema = (
  schema: JSONSchema,
  value: unknown,
  fullSchema: JSONSchema = schema,
  options: SchemaValidationOptions = SANITIZATION_VALIDATION,
): string | undefined =>
  validateAgainstSchemaInternal(
    schema,
    value,
    fullSchema,
    options,
    createSchemaValidationContext(),
  )?.message;

const validateAgainstSchemaInternal = (
  schema: JSONSchema,
  value: unknown,
  fullSchema: JSONSchema,
  options: SchemaValidationOptions,
  context: SchemaValidationContext,
): SchemaValidationFailure | undefined => {
  if (schema === true) return undefined;
  if (schema === false) return mismatch("schema rejects all values");
  if (!isRecord(schema) || Array.isArray(schema)) {
    return indeterminate("schema must be an object or boolean");
  }
  const schemaRoot = cfcSchemaChildRoot(schema, fullSchema);
  const rootKey = isRecord(schemaRoot) ? schemaRoot : schema;
  if (!markSchemaValueActive(rootKey, schema, value, context)) {
    return indeterminate("recursive schema validation made no progress");
  }

  try {
    const resolved = typeof schema.$ref === "string"
      ? resolveCfcSchemaRefs(schema, schemaRoot)
      : schema;
    if (resolved === undefined) {
      return indeterminate(`cannot resolve schema reference ${schema.$ref}`);
    }
    if (resolved !== schema) {
      // Keep the original root as `fullSchema` so nested $refs in the resolved
      // branch can still find sibling $defs entries, except when an embedded
      // external ref deliberately changes the owning root.
      const resolvedRoot = typeof resolved === "object" && resolved !== null
        ? resolveCfcSchemaRefRoot(schema, schemaRoot)
        : schemaRoot;
      return validateAgainstSchemaInternal(
        resolved,
        value,
        resolvedRoot,
        options,
        context,
      );
    }
    if (options.acceptOpaqueValue?.(value, schema, schemaRoot)) {
      return undefined;
    }

    if (Array.isArray(schema.allOf)) {
      for (const branch of schema.allOf) {
        const failure = validateAgainstSchemaInternal(
          branch,
          value,
          schemaRoot,
          options,
          context,
        );
        if (failure !== undefined) return failure;
      }
    }
    if (Array.isArray(schema.anyOf)) {
      let matched = false;
      let schemaFailure: SchemaValidationFailure | undefined;
      for (const branch of schema.anyOf) {
        const failure = validateAgainstSchemaInternal(
          branch,
          value,
          schemaRoot,
          options,
          context,
        );
        if (failure === undefined) {
          matched = true;
          break;
        }
        if (failure.kind === "indeterminate") schemaFailure ??= failure;
      }
      if (!matched) {
        return schemaFailure ?? mismatch("value does not match anyOf");
      }
    }
    if (Array.isArray(schema.oneOf)) {
      let matches = 0;
      let schemaFailure: SchemaValidationFailure | undefined;
      for (const branch of schema.oneOf) {
        const failure = validateAgainstSchemaInternal(
          branch,
          value,
          schemaRoot,
          options,
          context,
        );
        if (failure === undefined) matches++;
        else if (failure.kind === "indeterminate") schemaFailure ??= failure;
      }
      if (matches <= 1 && schemaFailure !== undefined) return schemaFailure;
      if (matches !== 1) {
        return mismatch("value does not match exactly one oneOf branch");
      }
    }

    if (
      Array.isArray(schema.enum) &&
      !schema.enum.some((entry) => schemaValueEqual(entry, value))
    ) {
      return mismatch("value is not in enum");
    }
    if (
      Object.hasOwn(schema, "const") &&
      !schemaValueEqual(schema.const, value)
    ) {
      return mismatch("value does not match const");
    }

    const typeDefinitionIssue = options.strictConstraints
      ? schemaTypeDefinitionIssue(schema.type)
      : undefined;
    if (typeDefinitionIssue !== undefined) {
      return indeterminate(typeDefinitionIssue);
    }
    const types = asTypeArray(schema.type);
    if (
      types.length > 0 &&
      !types.some((type) => typeMatches(value, type, options.strictConstraints))
    ) {
      return mismatch(`value does not match type ${types.join("|")}`);
    }

    if (options.strictConstraints) {
      const failure = validateStrictSchemaConstraints(
        schema,
        value,
        schemaRoot,
        options,
        context,
      );
      if (failure !== undefined) return failure;
    }

    if (isFabricPlainObjectValue(value)) {
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key)) {
          return mismatch(`missing required property ${key}`);
        }
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (Object.hasOwn(value, key)) {
          const failure = validateAgainstSchemaInternal(
            child,
            value[key],
            schemaRoot,
            options,
            context,
          );
          if (failure !== undefined) return atValidationPath(key, failure);
        }
      }
      const closesAdditionalProperties = options
          .implicitAdditionalPropertiesOpen
        ? schema.additionalProperties === false
        : cfcObjectSchemaIsClosed(schema);
      if (closesAdditionalProperties) {
        const known = new Set(Object.keys(schema.properties ?? {}));
        const patterns = options.strictConstraints
          ? Object.keys(schema.patternProperties ?? {}).map((pattern) =>
            new RegExp(pattern)
          )
          : [];
        const extra = Object.keys(value).find((key) =>
          !known.has(key) && !patterns.some((pattern) => pattern.test(key))
        );
        if (extra !== undefined) {
          return mismatch(`additional property ${extra}`);
        }
      } else if (typeof schema.additionalProperties === "object") {
        const known = new Set(Object.keys(schema.properties ?? {}));
        const patterns = options.strictConstraints
          ? Object.keys(schema.patternProperties ?? {}).map((pattern) =>
            new RegExp(pattern)
          )
          : [];
        for (const key of Object.keys(value)) {
          if (
            !known.has(key) && !patterns.some((pattern) => pattern.test(key))
          ) {
            const failure = validateAgainstSchemaInternal(
              schema.additionalProperties,
              value[key],
              schemaRoot,
              options,
              context,
            );
            if (failure !== undefined) return atValidationPath(key, failure);
          }
        }
      }
    }

    if (
      !options.strictConstraints && Array.isArray(value) &&
      typeof schema.items === "object"
    ) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) continue;
        const failure = validateAgainstSchemaInternal(
          schema.items,
          value[index],
          schemaRoot,
          options,
          context,
        );
        if (failure !== undefined) return atValidationPath(index, failure);
      }
    }

    return undefined;
  } finally {
    unmarkSchemaValueActive(rootKey, schema, value, context);
  }
};

function validateStrictSchemaConstraints(
  schema: Exclude<JSONSchema, boolean>,
  value: unknown,
  fullSchema: JSONSchema,
  options: SchemaValidationOptions,
  context: SchemaValidationContext,
): SchemaValidationFailure | undefined {
  const definitionIssue = strictConstraintDefinitionIssue(schema);
  if (definitionIssue !== undefined) return indeterminate(definitionIssue);

  if (schema.not !== undefined) {
    const failure = validateAgainstSchemaInternal(
      schema.not,
      value,
      fullSchema,
      options,
      context,
    );
    if (failure === undefined) {
      return mismatch("value matches disallowed not schema");
    }
    if (failure.kind === "indeterminate") return failure;
  }
  if (schema.if !== undefined) {
    const conditionFailure = validateAgainstSchemaInternal(
      schema.if,
      value,
      fullSchema,
      options,
      context,
    );
    if (conditionFailure?.kind === "indeterminate") return conditionFailure;
    const conditionMatches = conditionFailure === undefined;
    const selected = conditionMatches ? schema.then : schema.else;
    if (selected !== undefined) {
      const failure = validateAgainstSchemaInternal(
        selected,
        value,
        fullSchema,
        options,
        context,
      );
      if (failure !== undefined) return failure;
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return mismatch(`value is below minimum ${schema.minimum}`);
    }
    if (
      schema.exclusiveMinimum !== undefined &&
      value <= schema.exclusiveMinimum
    ) {
      return mismatch(
        `value is not above exclusiveMinimum ${schema.exclusiveMinimum}`,
      );
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return mismatch(`value is above maximum ${schema.maximum}`);
    }
    if (
      schema.exclusiveMaximum !== undefined &&
      value >= schema.exclusiveMaximum
    ) {
      return mismatch(
        `value is not below exclusiveMaximum ${schema.exclusiveMaximum}`,
      );
    }
    if (schema.multipleOf !== undefined) {
      const quotient = value / schema.multipleOf;
      const tolerance = Number.EPSILON * Math.max(1, Math.abs(quotient)) * 4;
      if (
        schema.multipleOf <= 0 ||
        Math.abs(quotient - Math.round(quotient)) > tolerance
      ) {
        return mismatch(`value is not a multiple of ${schema.multipleOf}`);
      }
    }
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      return mismatch(`value is shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      return mismatch(`value is longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined) {
      // strictConstraintDefinitionIssue() compiled this expression above.
      const pattern = new RegExp(schema.pattern);
      if (!pattern.test(value)) return mismatch(`value does not match pattern`);
    }
    if (schema.format !== undefined) {
      if (!valueMatchesFormat(value, schema.format)) {
        return mismatch(`value does not match format ${schema.format}`);
      }
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return mismatch(`array has fewer than minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return mismatch(`array has more than maxItems ${schema.maxItems}`);
    }
    if (schema.uniqueItems === true) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) continue;
        if (
          value.slice(0, index).some((entry) =>
            schemaValueEqual(entry, value[index])
          )
        ) {
          return mismatch("array items are not unique");
        }
      }
    }
    for (let index = 0; index < (schema.prefixItems?.length ?? 0); index++) {
      if (index >= value.length) break;
      if (!Object.hasOwn(value, index)) continue;
      const failure = validateAgainstSchemaInternal(
        schema.prefixItems![index],
        value[index],
        fullSchema,
        options,
        context,
      );
      if (failure !== undefined) return atValidationPath(index, failure);
    }
    if (schema.items !== undefined) {
      const start = schema.prefixItems?.length ?? 0;
      for (let index = start; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) continue;
        const failure = validateAgainstSchemaInternal(
          schema.items,
          value[index],
          fullSchema,
          options,
          context,
        );
        if (failure !== undefined) return atValidationPath(index, failure);
      }
    }
    if (schema.contains !== undefined) {
      let matches = 0;
      let indeterminateMatches = 0;
      let schemaFailure: SchemaValidationFailure | undefined;
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) continue;
        const failure = validateAgainstSchemaInternal(
          schema.contains,
          value[index],
          fullSchema,
          options,
          context,
        );
        if (failure === undefined) matches++;
        else if (failure.kind === "indeterminate") {
          indeterminateMatches++;
          schemaFailure ??= failure;
        }
      }
      const minimum = schema.minContains ?? 1;
      if (matches + indeterminateMatches < minimum) {
        return mismatch(`array has fewer than ${minimum} matches`);
      }
      if (schema.maxContains !== undefined && matches > schema.maxContains) {
        return mismatch(`array has more than ${schema.maxContains} matches`);
      }
      if (
        schemaFailure !== undefined &&
        (matches < minimum ||
          (schema.maxContains !== undefined &&
            matches + indeterminateMatches > schema.maxContains))
      ) {
        return schemaFailure;
      }
    }
  }

  if (isFabricPlainObjectValue(value)) {
    const propertyCount = Object.keys(value).length;
    if (
      schema.minProperties !== undefined &&
      propertyCount < schema.minProperties
    ) {
      return mismatch(
        `object has fewer than minProperties ${schema.minProperties}`,
      );
    }
    if (
      schema.maxProperties !== undefined &&
      propertyCount > schema.maxProperties
    ) {
      return mismatch(
        `object has more than maxProperties ${schema.maxProperties}`,
      );
    }
    for (
      const [key, dependencies] of Object.entries(
        schema.dependentRequired ?? {},
      )
    ) {
      if (Object.hasOwn(value, key)) {
        const missing = dependencies.find((dependency) =>
          !Object.hasOwn(value, dependency)
        );
        if (missing !== undefined) {
          return mismatch(`${key}: missing dependent property ${missing}`);
        }
      }
    }
    for (
      const [key, dependentSchema] of Object.entries(
        schema.dependentSchemas ?? {},
      )
    ) {
      if (Object.hasOwn(value, key)) {
        const failure = validateAgainstSchemaInternal(
          dependentSchema,
          value,
          fullSchema,
          options,
          context,
        );
        if (failure !== undefined) return atValidationPath(key, failure);
      }
    }
    if (schema.propertyNames !== undefined) {
      for (const key of Object.keys(value)) {
        const failure = validateAgainstSchemaInternal(
          schema.propertyNames,
          key,
          fullSchema,
          options,
          context,
        );
        if (failure !== undefined) return atValidationPath(key, failure);
      }
    }
    for (
      const [source, childSchema] of Object.entries(
        schema.patternProperties ?? {},
      )
    ) {
      // strictConstraintDefinitionIssue() compiled this expression above.
      const pattern = new RegExp(source);
      for (const [key, child] of Object.entries(value)) {
        if (pattern.test(key)) {
          const failure = validateAgainstSchemaInternal(
            childSchema,
            child,
            fullSchema,
            options,
            context,
          );
          if (failure !== undefined) return atValidationPath(key, failure);
        }
      }
    }
  }

  if (
    schema.contentEncoding !== undefined ||
    schema.contentMediaType !== undefined ||
    schema.contentSchema !== undefined
  ) {
    return indeterminate("content validation is not supported");
  }
  return undefined;
}

function valueMatchesFormat(value: string, format: string): boolean {
  switch (format) {
    case "email": {
      const separator = value.lastIndexOf("@");
      if (separator <= 0 || separator === value.length - 1) return false;
      const local = value.slice(0, separator);
      const domain = value.slice(separator + 1);
      const dotAtom = !local.startsWith(".") && !local.endsWith(".") &&
        !local.includes("..") &&
        /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local);
      const quoted = /^"(?:[\x20-\x21\x23-\x5B\x5D-\x7E]|\\[\x20-\x7E])*"$/
        .test(
          local,
        );
      if (
        local.length === 0 || local.length > 64 || domain.length === 0 ||
        domain.length > 255 || (!dotAtom && !quoted) || domain.includes("..")
      ) {
        return false;
      }
      const labels = domain.split(".");
      return labels.every((label) =>
        label.length > 0 && label.length <= 63 &&
        !label.startsWith("-") && !label.endsWith("-") &&
        /^[A-Za-z0-9-]+$/.test(label)
      );
    }
    case "uri":
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    case "date":
      return valueMatchesDate(value);
    case "date-time": {
      const match =
        /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/
          .exec(value);
      if (!match || !valueMatchesDate(match[1])) return false;
      const hour = Number(match[2]);
      const minute = Number(match[3]);
      const second = Number(match[4]);
      const offsetHour = match[6] === undefined ? 0 : Number(match[6]);
      const offsetMinute = match[7] === undefined ? 0 : Number(match[7]);
      return hour <= 23 && minute <= 59 && second <= 60 &&
        offsetHour <= 23 && offsetMinute <= 59;
    }
    default:
      return false;
  }
}

function valueMatchesDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value;
}
