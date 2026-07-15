import type { ImmutableJSONValue, JSONSchema } from "@commonfabric/api";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  cloneIfNecessary,
  type FabricValue,
} from "@commonfabric/data-model/fabric-value";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";
import { uniqueCfcAtoms } from "./observation.ts";
import { resolveCfcSchemaRefs } from "./schema-refs.ts";
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

/** JSON Schema compares numbers by mathematical value, so 0 and -0 are equal. */
const schemaValueEqual = (left: unknown, right: unknown): boolean => {
  if (typeof left === "number" && typeof right === "number") {
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => schemaValueEqual(entry, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    return leftKeys.length === Object.keys(right).length &&
      leftKeys.every((key) =>
        Object.hasOwn(right, key) && schemaValueEqual(left[key], right[key])
      );
  }
  return deepEqual(left, right);
};

const decimalAsScaledInteger = (
  value: number,
): { coefficient: bigint; scale: number } => {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(
    value.toString(),
  );
  if (match === null) {
    throw new Error(`Cannot represent finite number ${value} as a decimal`);
  }
  const fraction = match[3] ?? "";
  let coefficient = BigInt(`${match[1]}${match[2]}${fraction}`);
  let scale = fraction.length - Number(match[4] ?? 0);
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
};

const isExactMultiple = (value: number, multiple: number): boolean => {
  const left = decimalAsScaledInteger(value);
  const right = decimalAsScaledInteger(multiple);
  const commonScale = Math.max(left.scale, right.scale);
  const scaledValue = left.coefficient *
    10n ** BigInt(commonScale - left.scale);
  const scaledMultiple = right.coefficient *
    10n ** BigInt(commonScale - right.scale);
  return scaledValue % scaledMultiple === 0n;
};

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

const typeMatches = (value: unknown, type: string): boolean => {
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
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value) && !Array.isArray(value);
    default:
      return true;
  }
};

/**
 * Return a copy whose object-shaped schemas use standard JSON Schema's open
 * default unless they explicitly declare `additionalProperties`.
 *
 * {@link validateAgainstSchema} also serves CFC sanitization, where an omitted
 * `additionalProperties` is intentionally treated as closed. External response
 * validation must call this helper first so that authored fetch/generation
 * schemas retain ordinary JSON Schema semantics.
 */
export const schemaWithOpenObjects = (schema: JSONSchema): JSONSchema => {
  if (typeof schema === "boolean") return schema;
  const result: Record<string, unknown> = { ...schema };

  for (const key of ["not", "additionalProperties"]) {
    if (typeof result[key] === "object" && result[key] !== null) {
      result[key] = schemaWithOpenObjects(result[key] as JSONSchema);
    }
  }
  if (Array.isArray(result.items)) {
    result.items = result.items.map((item) =>
      schemaWithOpenObjects(item as JSONSchema)
    );
  } else if (typeof result.items === "object" && result.items !== null) {
    result.items = schemaWithOpenObjects(result.items as JSONSchema);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as JSONSchema[]).map(schemaWithOpenObjects);
    }
  }
  for (const key of ["properties", "$defs"]) {
    if (typeof result[key] === "object" && result[key] !== null) {
      result[key] = Object.fromEntries(
        Object.entries(result[key] as Record<string, JSONSchema>).map(
          ([name, child]) => [name, schemaWithOpenObjects(child)],
        ),
      );
    }
  }

  const declaresObjectShape = asTypeArray(result.type).includes("object") ||
    result.properties !== undefined || result.required !== undefined;
  if (declaresObjectShape && result.additionalProperties === undefined) {
    result.additionalProperties = true;
  }
  return result as JSONSchema;
};

export const validateAgainstSchema = (
  schema: JSONSchema,
  value: unknown,
  fullSchema: JSONSchema = schema,
): string | undefined => {
  if (schema === true) return undefined;
  if (schema === false) return "schema rejects all values";

  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (resolved !== schema) {
    // Keep the original root as `fullSchema` so nested $refs in the resolved
    // branch can still find sibling $defs entries.
    return validateAgainstSchema(resolved, value, fullSchema);
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const failure = validateAgainstSchema(branch, value, fullSchema);
      if (failure !== undefined) return failure;
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some((branch) =>
      validateAgainstSchema(branch, value, fullSchema) === undefined
    );
    if (!ok) return "value does not match anyOf";
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) =>
      validateAgainstSchema(branch, value, fullSchema) === undefined
    ).length;
    if (matches !== 1) {
      return "value does not match exactly one oneOf branch";
    }
  }

  // TODO(danfuzz): Latent — the enum/const equality arm here compares a runtime
  // value against a schema constraint with `schemaValueEqual`; schemas don't admit
  // `Fabric*` values today but will, at which point this mishandles a
  // `FabricValue` (same-class `FabricPrimitive`s compare equal regardless of
  // value). Use a Fabric-aware equality when the path becomes live. (The
  // property-walk in this same function is already marked.)
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
  if (types.length > 0 && !types.some((type) => typeMatches(value, type))) {
    return `value does not match type ${types.join("|")}`;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
      if (!isExactMultiple(value, schema.multipleOf)) {
        return `number is not a multiple of ${schema.multipleOf}`;
      }
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `number is greater than maximum ${schema.maximum}`;
    }
    if (
      typeof schema.exclusiveMaximum === "number" &&
      value >= schema.exclusiveMaximum
    ) {
      return `number is not less than exclusiveMaximum ${schema.exclusiveMaximum}`;
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `number is less than minimum ${schema.minimum}`;
    }
    if (
      typeof schema.exclusiveMinimum === "number" &&
      value <= schema.exclusiveMinimum
    ) {
      return `number is not greater than exclusiveMinimum ${schema.exclusiveMinimum}`;
    }
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.maxLength === "number" && length > schema.maxLength) {
      return `string is longer than maxLength ${schema.maxLength}`;
    }
    if (typeof schema.minLength === "number" && length < schema.minLength) {
      return `string is shorter than minLength ${schema.minLength}`;
    }
    if (typeof schema.pattern === "string") {
      let pattern: RegExp;
      try {
        pattern = new RegExp(schema.pattern, "u");
      } catch {
        return `schema has invalid pattern ${schema.pattern}`;
      }
      if (!pattern.test(value)) {
        return `string does not match pattern ${schema.pattern}`;
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `array has more than maxItems ${schema.maxItems}`;
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return `array has fewer than minItems ${schema.minItems}`;
    }
    if (schema.uniqueItems === true) {
      for (let index = 0; index < value.length; index++) {
        if (
          value.slice(0, index).some((entry) =>
            schemaValueEqual(entry, value[index])
          )
        ) {
          return `array item ${index} is not unique`;
        }
      }
    }
  }

  // TODO(danfuzz): Latent — schemas don't admit `Fabric*` values on this path
  // today, but will in the not-too-distant future; at that point this guard-less
  // `isRecord`-walk fails (a `FabricPrimitive` is decomposed, a `FabricInstance`
  // is walked by internal slots rather than codec contents). Mark ahead of that.
  if (isRecord(value) && !Array.isArray(value)) {
    const propertyCount = Object.keys(value).length;
    if (
      typeof schema.maxProperties === "number" &&
      propertyCount > schema.maxProperties
    ) {
      return `object has more than maxProperties ${schema.maxProperties}`;
    }
    if (
      typeof schema.minProperties === "number" &&
      propertyCount < schema.minProperties
    ) {
      return `object has fewer than minProperties ${schema.minProperties}`;
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        return `missing required property ${key}`;
      }
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
          return `property ${key} requires property ${missing}`;
        }
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        const failure = validateAgainstSchema(child, value[key], fullSchema);
        if (failure !== undefined) return `${key}: ${failure}`;
      }
    }
    if (cfcObjectSchemaIsClosed(schema)) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      const extra = Object.keys(value).find((key) => !known.has(key));
      if (extra !== undefined) return `additional property ${extra}`;
    } else if (typeof schema.additionalProperties === "object") {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) {
          const failure = validateAgainstSchema(
            schema.additionalProperties,
            value[key],
            fullSchema,
          );
          if (failure !== undefined) return `${key}: ${failure}`;
        }
      }
    }
  }

  if (Array.isArray(value) && typeof schema.items === "object") {
    for (let index = 0; index < value.length; index++) {
      const failure = validateAgainstSchema(
        schema.items,
        value[index],
        fullSchema,
      );
      if (failure !== undefined) return `${index}: ${failure}`;
    }
  }

  return undefined;
};
