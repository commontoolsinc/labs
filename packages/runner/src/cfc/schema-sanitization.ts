import type { ImmutableJSONValue, JSONSchema } from "@commonfabric/api";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  cloneIfNecessary,
  type FabricValue,
} from "@commonfabric/data-model/fabric-value";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";
import { uniqueCfcAtoms } from "./observation.ts";
import { isOrClause, normalizeClause } from "./clause.ts";
import { resolveCfcSchemaRefs } from "./schema-refs.ts";

export const INJECTION_SAFE_ATOM = {
  type: CFC_ATOM_TYPE.InjectionSafe,
} as const satisfies ImmutableJSONValue;

const PROMPT_INJECTION_RISK_KINDS = new Set([
  "https://commonfabric.org/cfc/concepts/prompt-injection-risk",
  "https://commonfabric.org/cfc/concepts/prompt-injection-risk-unscreened",
  "https://commonfabric.org/cfc/concepts/prompt-injection-risk-ingress-screened",
  "https://commonfabric.org/cfc/concepts/prompt-injection-risk-value-screened",
  "prompt-injection-risk",
  "prompt-injection-risk-unscreened",
  "prompt-injection-risk-ingress-screened",
  "prompt-injection-risk-value-screened",
]);

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

// Strip material-risk caveats from ONE confidentiality clause. A bare
// material-risk atom is dropped; inside an OR-clause the scan descends into
// alternatives and removes the material-risk ones (unwrapping/dropping the
// clause if it collapses). Descending is load-bearing: a material-risk caveat
// hidden as an alternative (`{anyOf:[risk, A]}`) is NOT more-restrictive when
// preserved — a ceiling naming the sibling `A` subsumes the whole clause
// (clause-subsumption fit), so the caveat would neither gate nor get stripped.
// Returns undefined when the clause is entirely material-risk (fully
// discharged for this instruction-inert path).
const stripMaterialRiskFromClause = (clause: unknown): unknown | undefined => {
  if (!isOrClause(clause)) {
    return isPromptInjectionMaterialRiskAtom(clause) ? undefined : clause;
  }
  const kept = clause.anyOf.filter(
    (alternative) => !isPromptInjectionMaterialRiskAtom(alternative),
  );
  return kept.length === 0 ? undefined : normalizeClause({ anyOf: kept });
};

const filterMaterialRiskAtoms = (
  atoms: readonly unknown[],
): ImmutableJSONValue[] =>
  uniqueAtoms(
    atoms
      .map(stripMaterialRiskFromClause)
      .filter((clause) => clause !== undefined),
  );

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
    ? filterMaterialRiskAtoms(observedConfidentiality)
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
  // value against a schema constraint with `deepEqual`; schemas don't admit
  // `Fabric*` values today but will, at which point this mishandles a
  // `FabricValue` (same-class `FabricPrimitive`s compare equal regardless of
  // value). Use a Fabric-aware equality when the path becomes live. (The
  // property-walk in this same function is already marked.)
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((entry) => deepEqual(entry, value))
  ) {
    return "value is not in enum";
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    return "value does not match const";
  }

  const types = asTypeArray(schema.type);
  if (types.length > 0 && !types.some((type) => typeMatches(value, type))) {
    return `value does not match type ${types.join("|")}`;
  }

  // TODO(danfuzz): Latent — schemas don't admit `Fabric*` values on this path
  // today, but will in the not-too-distant future; at that point this guard-less
  // `isRecord`-walk fails (a `FabricPrimitive` is decomposed, a `FabricInstance`
  // is walked by internal slots rather than codec contents). Mark ahead of that.
  if (isRecord(value) && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) {
        return `missing required property ${key}`;
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) {
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
