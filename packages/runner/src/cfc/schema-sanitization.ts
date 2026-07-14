import type { ImmutableJSONValue, JSONSchema } from "@commonfabric/api";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  cloneIfNecessary,
  type FabricPlainObject,
  type FabricValue,
  isFabricPlainObject,
  valueEqual,
} from "@commonfabric/data-model/fabric-value";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";
import { uniqueCfcAtoms } from "./observation.ts";
import {
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
  "const" in schema && isPrimitiveJsonValue(schema.const);

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
      type === "null"
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
  visitedRefs: ReadonlySet<string> = new Set(),
): AnnotationResult => {
  if (typeof schema === "boolean") {
    return { schema, instructionInert: false };
  }

  // $ref cycle guard: resolveSchemaRefs only detects cycles within a single
  // call, but annotateSchema recurses across resolutions. Track the chain of
  // refs visited in this annotation pass and break the cycle by returning
  // the unresolved ref schema (still tainted with observed confidentiality
  // if present, but not recursed into again).
  const directRef = typeof schema.$ref === "string" ? schema.$ref : undefined;
  if (directRef !== undefined && visitedRefs.has(directRef)) {
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
  const nextVisited: ReadonlySet<string> = directRef !== undefined
    ? new Set([...visitedRefs, directRef])
    : visitedRefs;

  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (resolved !== schema) {
    const annotated = annotateSchema(
      resolved,
      observedConfidentiality,
      resolved,
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
      annotateSchema(branch, observedConfidentiality, fullSchema, nextVisited)
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
        fullSchema,
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
      fullSchema,
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

interface SchemaValidationOptions {
  strictConstraints: boolean;
  implicitAdditionalPropertiesOpen: boolean;
  acceptOpaqueValue?: (value: unknown) => boolean;
}

export interface SchemaValueValidationOptions {
  /**
   * Accept runtime materializations such as Cell handles whose schema was
   * already proven by canonical traversal, without treating the handle object
   * itself as the schema's underlying value.
   */
  acceptOpaqueValue?: (value: unknown) => boolean;
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
  activeObjectValues: WeakMap<object, WeakSet<object>>;
  activePrimitiveValues: WeakMap<object, Set<string>>;
}

const createSchemaValidationContext = (): SchemaValidationContext => ({
  activeObjectValues: new WeakMap(),
  activePrimitiveValues: new WeakMap(),
});

const primitiveValidationKey = (value: unknown): string =>
  `${typeof value}:${String(value)}`;

const markSchemaValueActive = (
  schema: object,
  value: unknown,
  context: SchemaValidationContext,
): boolean => {
  if (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) {
    const objectValue = value as object;
    let active = context.activeObjectValues.get(schema);
    if (active?.has(objectValue)) return false;
    if (!active) {
      active = new WeakSet();
      context.activeObjectValues.set(schema, active);
    }
    active.add(objectValue);
    return true;
  }
  const key = primitiveValidationKey(value);
  let active = context.activePrimitiveValues.get(schema);
  if (active?.has(key)) return false;
  if (!active) {
    active = new Set();
    context.activePrimitiveValues.set(schema, active);
  }
  active.add(key);
  return true;
};

const unmarkSchemaValueActive = (
  schema: object,
  value: unknown,
  context: SchemaValidationContext,
): void => {
  if (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) {
    context.activeObjectValues.get(schema)?.delete(value as object);
    return;
  }
  context.activePrimitiveValues.get(schema)?.delete(
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
  );

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
  );

const validateAgainstSchemaInternal = (
  schema: JSONSchema,
  value: unknown,
  fullSchema: JSONSchema,
  options: SchemaValidationOptions,
  context: SchemaValidationContext,
): string | undefined => {
  if (schema === true) return undefined;
  if (schema === false) return "schema rejects all values";
  if (!markSchemaValueActive(schema, value, context)) {
    return "recursive schema validation made no progress";
  }

  try {
    const resolved = resolveSchemaForValidation(schema, fullSchema);
    if (resolved !== schema) {
      // Keep the original root as `fullSchema` so nested $refs in the resolved
      // branch can still find sibling $defs entries, except when an embedded
      // external ref deliberately changes the owning root.
      const resolvedRoot = typeof resolved === "object" && resolved !== null
        ? resolveCfcSchemaRefRoot(schema, fullSchema)
        : fullSchema;
      return validateAgainstSchemaInternal(
        resolved,
        value,
        resolvedRoot,
        options,
        context,
      );
    }
    if (options.acceptOpaqueValue?.(value)) return undefined;

    if (Array.isArray(schema.allOf)) {
      for (const branch of schema.allOf) {
        const failure = validateAgainstSchemaInternal(
          branch,
          value,
          fullSchema,
          options,
          context,
        );
        if (failure !== undefined) return failure;
      }
    }
    if (Array.isArray(schema.anyOf)) {
      const ok = schema.anyOf.some((branch) =>
        validateAgainstSchemaInternal(
          branch,
          value,
          fullSchema,
          options,
          context,
        ) === undefined
      );
      if (!ok) return "value does not match anyOf";
    }
    if (Array.isArray(schema.oneOf)) {
      const matches = schema.oneOf.filter((branch) =>
        validateAgainstSchemaInternal(
          branch,
          value,
          fullSchema,
          options,
          context,
        ) === undefined
      ).length;
      if (matches !== 1) {
        return "value does not match exactly one oneOf branch";
      }
    }

    if (
      Array.isArray(schema.enum) &&
      !schema.enum.some((entry) => schemaValueEqual(entry, value))
    ) {
      return "value is not in enum";
    }
    if ("const" in schema && !schemaValueEqual(schema.const, value)) {
      return "value does not match const";
    }

    const types = asTypeArray(schema.type);
    const unknownType = options.strictConstraints
      ? types.find((type) =>
        ![
          "unknown",
          "string",
          "number",
          "integer",
          "boolean",
          "null",
          "undefined",
          "array",
          "object",
        ].includes(type)
      )
      : undefined;
    if (unknownType !== undefined) {
      return `unsupported schema type ${unknownType}`;
    }
    if (
      types.length > 0 &&
      !types.some((type) => typeMatches(value, type, options.strictConstraints))
    ) {
      return `value does not match type ${types.join("|")}`;
    }

    if (options.strictConstraints) {
      const failure = validateStrictSchemaConstraints(
        schema,
        value,
        fullSchema,
        options,
        context,
      );
      if (failure !== undefined) return failure;
    }

    if (isFabricPlainObjectValue(value)) {
      for (const key of schema.required ?? []) {
        if (!(key in value)) {
          return `missing required property ${key}`;
        }
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (key in value) {
          const failure = validateAgainstSchemaInternal(
            child,
            value[key],
            fullSchema,
            options,
            context,
          );
          if (failure !== undefined) return `${key}: ${failure}`;
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
        if (extra !== undefined) return `additional property ${extra}`;
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
              fullSchema,
              options,
              context,
            );
            if (failure !== undefined) return `${key}: ${failure}`;
          }
        }
      }
    }

    if (
      !options.strictConstraints && Array.isArray(value) &&
      typeof schema.items === "object"
    ) {
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) continue;
        const failure = validateAgainstSchemaInternal(
          schema.items,
          value[index],
          fullSchema,
          options,
          context,
        );
        if (failure !== undefined) return `${index}: ${failure}`;
      }
    }

    return undefined;
  } finally {
    unmarkSchemaValueActive(schema, value, context);
  }
};

function validateStrictSchemaConstraints(
  schema: Exclude<JSONSchema, boolean>,
  value: unknown,
  fullSchema: JSONSchema,
  options: SchemaValidationOptions,
  context: SchemaValidationContext,
): string | undefined {
  if (
    schema.not !== undefined &&
    validateAgainstSchemaInternal(
        schema.not,
        value,
        fullSchema,
        options,
        context,
      ) === undefined
  ) {
    return "value matches disallowed not schema";
  }
  if (schema.if !== undefined) {
    const conditionMatches = validateAgainstSchemaInternal(
      schema.if,
      value,
      fullSchema,
      options,
      context,
    ) === undefined;
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
      return `value is below minimum ${schema.minimum}`;
    }
    if (
      schema.exclusiveMinimum !== undefined &&
      value <= schema.exclusiveMinimum
    ) {
      return `value is not above exclusiveMinimum ${schema.exclusiveMinimum}`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `value is above maximum ${schema.maximum}`;
    }
    if (
      schema.exclusiveMaximum !== undefined &&
      value >= schema.exclusiveMaximum
    ) {
      return `value is not below exclusiveMaximum ${schema.exclusiveMaximum}`;
    }
    if (schema.multipleOf !== undefined) {
      const quotient = value / schema.multipleOf;
      const tolerance = Number.EPSILON * Math.max(1, Math.abs(quotient)) * 4;
      if (
        schema.multipleOf <= 0 ||
        Math.abs(quotient - Math.round(quotient)) > tolerance
      ) {
        return `value is not a multiple of ${schema.multipleOf}`;
      }
    }
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      return `value is shorter than minLength ${schema.minLength}`;
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      return `value is longer than maxLength ${schema.maxLength}`;
    }
    if (schema.pattern !== undefined) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(schema.pattern);
      } catch {
        return `schema has invalid pattern ${schema.pattern}`;
      }
      if (!pattern.test(value)) return `value does not match pattern`;
    }
    if (
      schema.format !== undefined && !valueMatchesFormat(value, schema.format)
    ) {
      return `value does not match format ${schema.format}`;
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return `array has fewer than minItems ${schema.minItems}`;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `array has more than maxItems ${schema.maxItems}`;
    }
    if (schema.uniqueItems === true) {
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) continue;
        if (
          value.slice(0, index).some((entry) =>
            schemaValueEqual(entry, value[index])
          )
        ) {
          return "array items are not unique";
        }
      }
    }
    for (let index = 0; index < (schema.prefixItems?.length ?? 0); index++) {
      if (index >= value.length) break;
      if (!(index in value)) continue;
      const failure = validateAgainstSchemaInternal(
        schema.prefixItems![index],
        value[index],
        fullSchema,
        options,
        context,
      );
      if (failure !== undefined) return `${index}: ${failure}`;
    }
    if (schema.items !== undefined) {
      const start = schema.prefixItems?.length ?? 0;
      for (let index = start; index < value.length; index++) {
        if (!(index in value)) continue;
        const failure = validateAgainstSchemaInternal(
          schema.items,
          value[index],
          fullSchema,
          options,
          context,
        );
        if (failure !== undefined) return `${index}: ${failure}`;
      }
    }
    if (schema.contains !== undefined) {
      const matches = value.filter((entry) =>
        validateAgainstSchemaInternal(
          schema.contains!,
          entry,
          fullSchema,
          options,
          context,
        ) === undefined
      ).length;
      const minimum = schema.minContains ?? 1;
      if (matches < minimum) return `array has fewer than ${minimum} matches`;
      if (schema.maxContains !== undefined && matches > schema.maxContains) {
        return `array has more than ${schema.maxContains} matches`;
      }
    }
  }

  if (isFabricPlainObjectValue(value)) {
    const propertyCount = Object.keys(value).length;
    if (
      schema.minProperties !== undefined &&
      propertyCount < schema.minProperties
    ) {
      return `object has fewer than minProperties ${schema.minProperties}`;
    }
    if (
      schema.maxProperties !== undefined &&
      propertyCount > schema.maxProperties
    ) {
      return `object has more than maxProperties ${schema.maxProperties}`;
    }
    for (
      const [key, dependencies] of Object.entries(
        schema.dependentRequired ?? {},
      )
    ) {
      if (key in value) {
        const missing = dependencies.find((dependency) =>
          !(dependency in value)
        );
        if (missing !== undefined) {
          return `${key}: missing dependent property ${missing}`;
        }
      }
    }
    for (
      const [key, dependentSchema] of Object.entries(
        schema.dependentSchemas ?? {},
      )
    ) {
      if (key in value) {
        const failure = validateAgainstSchemaInternal(
          dependentSchema,
          value,
          fullSchema,
          options,
          context,
        );
        if (failure !== undefined) return `${key}: ${failure}`;
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
        if (failure !== undefined) return `${key}: ${failure}`;
      }
    }
    for (
      const [source, childSchema] of Object.entries(
        schema.patternProperties ?? {},
      )
    ) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(source);
      } catch {
        return `schema has invalid property pattern ${source}`;
      }
      for (const [key, child] of Object.entries(value)) {
        if (pattern.test(key)) {
          const failure = validateAgainstSchemaInternal(
            childSchema,
            child,
            fullSchema,
            options,
            context,
          );
          if (failure !== undefined) return `${key}: ${failure}`;
        }
      }
    }
  }

  if (
    schema.contentEncoding !== undefined ||
    schema.contentMediaType !== undefined ||
    schema.contentSchema !== undefined
  ) {
    return "content validation is not supported";
  }
  return undefined;
}

function valueMatchesFormat(value: string, format: string): boolean {
  switch (format) {
    case "email": {
      const parts = value.split("@");
      if (parts.length !== 2) return false;
      const [local, domain] = parts;
      if (
        local.length === 0 || local.length > 64 || domain.length === 0 ||
        domain.length > 255 || local.startsWith(".") || local.endsWith(".") ||
        local.includes("..") || domain.includes("..") ||
        !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
      ) {
        return false;
      }
      const labels = domain.split(".");
      return labels.length >= 2 &&
        labels.every((label) =>
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
        /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/
          .exec(value);
      if (!match || !valueMatchesDate(match[1])) return false;
      const hour = Number(match[2]);
      const minute = Number(match[3]);
      const second = Number(match[4]);
      const offsetHour = match[6] === undefined ? 0 : Number(match[6]);
      const offsetMinute = match[7] === undefined ? 0 : Number(match[7]);
      return hour <= 23 && minute <= 59 && second <= 59 &&
        offsetHour <= 23 && offsetMinute <= 59 &&
        !Number.isNaN(Date.parse(value));
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
