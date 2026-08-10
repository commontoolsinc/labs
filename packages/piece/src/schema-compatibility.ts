import {
  deepEqual,
  extractDefaultValues,
  type JSONSchema,
  type Pattern,
  schemaHasDefaultValue,
} from "@commonfabric/runner";
import {
  cfcSchemaChildRoot,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
  validateSchemaDefinition,
  validateSchemaValue,
} from "@commonfabric/runner/cfc";
import {
  FABRIC_SPECIAL_OBJECT_BRAND,
  type FabricPrimitiveSchemaType,
  isFabricPrimitiveSchemaType,
} from "@commonfabric/api";
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
  /**
   * Piece evolution deliberately permits a small set of non-subset changes
   * (for example, naming a previously-uncontracted field on an open argument
   * object). Those allowances are only sound at a whole contract boundary;
   * they must never be used as proof that one conjunct implies another.
   */
  allowEvolutionPolicy: boolean;
  /** Whether default-backed evolution remains safe through every ancestor. */
  allowEvolutionDefaults: boolean;
  /** Link materialization fills valid target defaults before validation. */
  allowTargetDefaults: boolean;
  /** Whether defaults describe a pattern migration or link materialization. */
  defaultComparison: "evolution" | "target";
  /**
   * True below a node both contracts mark `asCell: ["stream"]` — a verb, so
   * everything beneath is the verb's EVENT schema. There, a boolean
   * `additionalProperties` is an enforcement dial rather than a data
   * contract: the runtime schema-strips undeclared event fields before any
   * handler runs, so an open event's "acceptance" of extras was never
   * observable behavior (accepted-and-STRIPPED was never contract — verb
   * contract WS-C, decided 2026-08-03), and closing one surfaces the silent
   * loss as the typed rejection rule 1 requires. The reverse transition is
   * equally free: rejection of undeclared fields is not a capability a
   * caller can depend on, and generator cleanup of `never`-derived closures
   * must not read as a contract break.
   */
  verbEvent?: boolean;
}

export interface SchemaSubsetOptions {
  sourceRoot?: JSONSchema;
  targetRoot?: JSONSchema;
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
  // Standard JSON Schema annotation. The generator emits it from
  // `@deprecated` JSDoc so `cf piece verbs` can hide legacy streams by
  // default; it is validation-neutral by spec, so it must add and remove
  // freely across pattern updates (verb contract WS-F listing marks — the
  // C3 append-only lesson is why this is classified BEFORE the generator
  // emits it).
  "deprecated",
  "description",
  "examples",
  "tags",
  // Listing-tier extension (`tier: "wrapper"`): a UI affordance outside the
  // headless contract, inferred from session-scoped handler bindings.
  // Validation-neutral by construction — it shapes only what `cf piece
  // verbs` shows by default; `cf piece call` never consults it.
  "tier",
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

const COMPLEX_CONSTRAINT_TYPES: Partial<
  Record<(typeof COMPLEX_CONSTRAINT_KEYS)[number], readonly string[]>
> = {
  contains: ["array"],
  dependentRequired: ["object"],
  dependentSchemas: ["object"],
  maxContains: ["array"],
  minContains: ["array"],
  patternProperties: ["object"],
  prefixItems: ["array"],
  propertyNames: ["object"],
};

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
 * may still gain optional/defaulted named fields as the piece-evolution policy.
 * What keeps that allowance sound is a second check at update time rather than
 * anything provable here: pattern setup re-stages the piece's stored argument
 * against the incoming schema and validates it inside the setup transaction, so
 * an update whose durable argument the new schema cannot read is refused
 * instead of landing over unreadable state. Two sites do the checking, and the
 * line between them is whether the caller will (re)instantiate the graph, not
 * whether the piece happens to be running: `Runner.applySetupState` re-points
 * and validates the argument for a cold root and for the watcher's hot-swap,
 * both of which then instantiate; `Runner.validateStoredArgument` checks a
 * piece that is being REUSED — its nodes stay as they are — and moves nothing
 * (`packages/runner/test/pattern-update-argument-validation.test.ts`).
 *
 * That check defers two cases, and the waiver is only as strong as they allow:
 *
 * - A slot whose stored value is a link that cannot be dereferenced in the
 *   transaction validates as opaque, because "the target has not synced" is
 *   indistinguishable from "the value is invalid" at that moment (CT-1917). A
 *   plain value of the wrong type is refused.
 * - A root carrying no `patternSetupIdentity` marker gets one unvalidated
 *   setup, because absence cannot be told from a pending update. The marker is
 *   recent, so this currently exempts most stored roots rather than a rare
 *   tail, and it is aged roots — the ones likeliest to hold a value a new
 *   schema cannot read — that the exemption covers.
 *
 * So this waiver is not a proof; it is a decision to accept those two cases.
 * Neither is covered elsewhere either — in particular Tier 2's vintage replay
 * cannot reach the markerless one, since its captures run setup through the
 * current runner and are therefore always marked. Both are pinned as decisions
 * in `packages/runner/test/pattern-update-argument-validation.test.ts` rather
 * than left to be rediscovered.
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
      allowEvolutionPolicy: true,
      allowEvolutionDefaults: true,
      allowTargetDefaults: false,
      defaultComparison: "evolution",
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
      allowEvolutionPolicy: true,
      allowEvolutionDefaults: true,
      allowTargetDefaults: false,
      defaultComparison: "evolution",
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

/**
 * Conservatively prove that every value described by `source` is accepted by
 * `target`. This is used for durable links: validating only their current
 * materialization is insufficient because the linked cell can change later.
 */
export function assertSchemaSubset(
  source: JSONSchema,
  target: JSONSchema,
  label: string = "value",
  options: SchemaSubsetOptions = {},
): void {
  for (
    const [schemaLabel, schema, root] of [
      ["source", source, options.sourceRoot ?? source],
      ["target", target, options.targetRoot ?? target],
    ] as const
  ) {
    const issue = validateSchemaDefinition(schema, root);
    if (issue !== undefined) {
      throw new Error(
        `${label} schema is not compatible: ${schemaLabel} schema is invalid: ${issue}`,
      );
    }
  }
  const issue = schemaSubsetIssue(source, target, label, {
    sourceRoot: options.sourceRoot ?? source,
    targetRoot: options.targetRoot ?? target,
    // Argument variance follows the needed source-subset-target direction for
    // object fields. Link materialization may also fill valid target defaults.
    role: "argument",
    activePairs: new WeakMap(),
    allowEvolutionPolicy: false,
    allowEvolutionDefaults: true,
    allowTargetDefaults: true,
    defaultComparison: "target",
  });
  if (issue !== undefined) {
    throw new Error(`${label} schema is not compatible: ${issue}`);
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
  // The stream marker rides the REFERENCING node (`{$ref, asCell:["stream"]}`),
  // so test the pre-resolution inputs as well as the resolved schemas. Both
  // contracts must agree the node is a verb: a one-sided marker is a shape
  // change the ordinary rules judge, not an exemption.
  const entersVerbEvent = !context.verbEvent &&
    (declaresVerbStream(sourceInput) || declaresVerbStream(source)) &&
    (declaresVerbStream(targetInput) || declaresVerbStream(target));
  context = {
    ...context,
    sourceRoot: sourceResolution.root,
    targetRoot: targetResolution.root,
    ...(entersVerbEvent ? { verbEvent: true } : {}),
  };
  if (
    context.defaultComparison === "target" &&
    schemaHasUnsafeMaterializedDefault(target, context.targetRoot)
  ) {
    return `${path}: defaults changed below a constraint that is not stable under default insertion`;
  }
  // A target default changes the materialized value before validation. That is
  // a sound link proof only while every ancestor is stable under recursive
  // default insertion. Whole-value constraints such as maxProperties,
  // dependentRequired, enum/const, conditionals, and uniqueItems can be broken
  // even when both schemas carry the same constraint.
  if (
    !schemaIsStableUnderDescendantDefaults(source) ||
    !schemaIsStableUnderDescendantDefaults(target)
  ) {
    context = {
      ...context,
      allowEvolutionDefaults: false,
      allowTargetDefaults: false,
    };
  }
  if (
    !context.allowEvolutionDefaults &&
    context.defaultComparison === "evolution" &&
    !schemaDefaultsResolveEqually(source, target, context)
  ) {
    return `${path}: defaults changed below a constraint that is not stable under default insertion`;
  }
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

    if (
      context.allowEvolutionPolicy &&
      fabricPrimitiveEvolutionAccepts(source, target)
    ) {
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
      const applicableTypes = COMPLEX_CONSTRAINT_TYPES[key];
      if (
        applicableTypes !== undefined &&
        !schemaMayProduceType(source, applicableTypes)
      ) {
        continue;
      }
      // A closed source with no patterns has a finite set of possible field
      // names. objectSubsetIssue() can prove each named field against changed
      // target patternProperties directly, while open or pattern-generated
      // source fields still require exact pattern equality below.
      if (
        key === "patternProperties" && source.additionalProperties === false &&
        Object.keys(source.patternProperties ?? {}).length === 0
      ) {
        continue;
      }
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

    if (
      schemaMayProduceType(source, ["object"]) &&
      (declaresObjectShape(source) || declaresObjectShape(target))
    ) {
      const objectIssue = objectSubsetIssue(source, target, path, context);
      if (objectIssue) return objectIssue;
    }

    if (
      schemaMayProduceType(source, ["array"]) &&
      (declaresArrayShape(source) || declaresArrayShape(target))
    ) {
      const arrayIssue = arraySubsetIssue(source, target, path, context);
      if (arrayIssue) return arrayIssue;
    }

    return unknownKeywordIssue(source, target, path);
  } finally {
    unmarkPairActive(source, target, context);
  }
}

const DEFAULT_STABLE_SCHEMA_KEYS = new Set([
  ...ANNOTATION_KEYS,
  "$ref",
  "additionalProperties",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "pattern",
  "properties",
  "required",
  "type",
]);

/** Whether inserting defaults below this schema leaves its own constraints true. */
function schemaIsStableUnderDescendantDefaults(schema: JSONSchema): boolean {
  if (typeof schema !== "object" || schema === null) return true;
  return Object.keys(schema).every((key) =>
    DEFAULT_STABLE_SCHEMA_KEYS.has(key)
  );
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

  // Pattern evolution preserves named fields as part of the public contract,
  // even when the candidate object is otherwise open. A durable-link subset
  // proof is different: a source may name additional fields that an open
  // target accepts through patternProperties/additionalProperties. Treating
  // those fields as "removed" rejects valid Fabric projections such as $FS.
  if (context.defaultComparison === "evolution") {
    for (const property of Object.keys(previousProperties)) {
      if (Object.hasOwn(candidateProperties, property)) continue;
      return `${path}.${property}: existing ${context.role} field was removed`;
    }
  }

  const sourceRequired = new Set(source.required ?? []);
  const targetRequired = new Set(target.required ?? []);
  const allowEvolutionPolicy = context.allowEvolutionPolicy &&
    !hasComplexSameInstanceConstraints(source) &&
    !hasComplexSameInstanceConstraints(target);
  const allowEvolutionDefaults = allowEvolutionPolicy &&
    context.allowEvolutionDefaults;
  if (context.role === "argument") {
    for (const property of targetRequired) {
      if (
        !sourceRequired.has(property) &&
        (!(context.allowTargetDefaults || allowEvolutionDefaults) ||
          !schemaProvidesValidDefault(
            targetProperties[property],
            context.targetRoot,
          ))
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
        allowEvolutionPolicy && !sourceRequired.has(property) &&
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
    // The candidate pattern produces its result. A newly required field does
    // not need a migration default: the new graph materializes that output when
    // it runs. Existing required-result guarantees above still cannot weaken,
    // and existing field types remain checked covariantly below.

    const previousAdditional = target.additionalProperties ?? true;
    for (const property of Object.keys(candidateProperties)) {
      const matchedPatterns = matchingPatternPropertySchemas(
        previousPatternProperties,
        property,
      );
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
    const propertyPath = `${path}.${property}`;
    const sourceDirect = sourceProperties[property];
    const sourceContracts = [
      sourceDirect,
      ...matchingPatternPropertySchemas(source.patternProperties, property),
    ];

    // Keep the ordinary named-property proof on the detailed path. When a
    // source pattern also applies, its conjunct may be the stronger fact that
    // proves the target constraint, but a failed proof should still report the
    // useful leaf-level reason from the named property.
    if (Object.hasOwn(targetProperties, property)) {
      const directIssue = schemaSubsetIssue(
        sourceDirect,
        targetProperties[property],
        propertyPath,
        context,
      );
      if (
        directIssue !== undefined &&
        !sourceContracts.slice(1).some((sourceContract) =>
          schemaSubsetIssue(
            sourceContract,
            targetProperties[property],
            propertyPath,
            { ...context, allowEvolutionPolicy: false },
          ) === undefined
        )
      ) {
        return directIssue;
      }
    }

    const targetPatternContracts = matchingPatternPropertySchemas(
      target.patternProperties,
      property,
    );
    for (const targetContract of targetPatternContracts) {
      const directIssue = schemaSubsetIssue(
        sourceDirect,
        targetContract,
        propertyPath,
        { ...context, allowEvolutionPolicy: false },
      );
      if (
        directIssue !== undefined &&
        !sourceContracts.slice(1).some((sourceContract) =>
          schemaSubsetIssue(
            sourceContract,
            targetContract,
            propertyPath,
            { ...context, allowEvolutionPolicy: false },
          ) === undefined
        )
      ) {
        return directIssue;
      }
    }

    if (
      !Object.hasOwn(targetProperties, property) &&
      targetPatternContracts.length === 0
    ) {
      const targetAdditional = target.additionalProperties ?? true;
      if (targetAdditional === true) continue;
      if (targetAdditional === false) {
        return `${path}.${property}: source field is rejected by the target object`;
      }
      const directIssue = schemaSubsetIssue(
        sourceDirect,
        targetAdditional,
        propertyPath,
        { ...context, allowEvolutionPolicy: false },
      );
      // A matching source pattern would have an exact-equal matching target
      // pattern (proved above), so this no-target-pattern branch cannot borrow
      // a source-pattern conjunct as an additionalProperties proof.
      if (directIssue !== undefined) return directIssue;
    }
  }

  return additionalPropertiesSubsetIssue(source, target, path, context);
}

function matchingPatternPropertySchemas(
  patternProperties: Record<string, JSONSchema> | undefined,
  property: string,
): JSONSchema[] {
  const matches: JSONSchema[] = [];
  for (const [source, schema] of Object.entries(patternProperties ?? {})) {
    // Schema preflight has already compiled every patternProperties key.
    const pattern = new RegExp(source);
    if (pattern.test(property)) matches.push(schema);
  }
  return matches;
}

function declaresVerbStream(schema: JSONSchema): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const asCell = (schema as SchemaObject).asCell;
  return Array.isArray(asCell) && asCell.includes("stream");
}

function additionalPropertiesSubsetIssue(
  source: SchemaObject,
  target: SchemaObject,
  path: string,
  context: CompatibilityContext,
): string | undefined {
  const sourceAdditional = source.additionalProperties ?? true;
  const targetAdditional = target.additionalProperties ?? true;
  // Verb events: a boolean↔boolean additionalProperties transition is free
  // in both directions (see CompatibilityContext.verbEvent). Schema-valued
  // additionalProperties on either side still compares — a constraint on the
  // extras' SHAPE is a data contract even on an event.
  if (
    context.verbEvent &&
    typeof sourceAdditional === "boolean" &&
    typeof targetAdditional === "boolean"
  ) {
    return undefined;
  }
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

/**
 * Structural data members of each fabric-primitive class, mirroring the
 * declarations in `packages/api/index.ts`. Used only by
 * {@link fabricPrimitiveEvolutionAccepts} to check that a structural schema
 * (which was generated by enumerating those declarations) describes the class
 * a candidate schema names by type.
 */
const FABRIC_PRIMITIVE_MEMBERS: Record<
  FabricPrimitiveSchemaType,
  ReadonlySet<string>
> = {
  FabricBytes: new Set(["length"]),
  FabricEpochDays: new Set(["value"]),
  FabricEpochNsec: new Set(["value"]),
  FabricHash: new Set(["bytes", "hashString", "length", "tag"]),
  FabricRegExp: new Set(["flags", "flavor", "source", "value"]),
};

const FABRIC_EVOLUTION_SOURCE_KEYS = new Set([
  ...ANNOTATION_KEYS,
  "type",
  "properties",
  "required",
]);

const FABRIC_EVOLUTION_TARGET_KEYS = new Set([
  ...ANNOTATION_KEYS,
  "type",
]);

/**
 * Whether `source` is a structural emission for a fabric special object -- an
 * object schema whose `required` carries the `FabricSpecialObject` nominal
 * brand key -- that a fabric-primitive-typed `target` accepts.
 *
 * Schemas of that shape come from compilations that predate the
 * fabric-primitive schema vocabulary: the generator enumerated the class's
 * declared members, brand included. No runtime value has the brand key, and
 * the runner's required-presence exemption confines such a schema's value
 * population to fabric special objects carrying the other required members --
 * which is what `{ type: "<FabricPrimitive class>" }`, the current emission
 * for the same authored type, describes by prototype. So a pattern update
 * whose recompiled contract makes exactly that transition is not a narrowing,
 * and refusing it would strand every deployed piece holding such a field.
 *
 * The proof is only as strong as the shapes involved, so it is deliberately
 * narrow: both sides must carry nothing beyond the generator emissions the
 * transition is about (no `asCell`, no `ifc`, no nested combinators), every
 * member the source requires must exist on the class the target names, and
 * the caller gates it to pattern evolution (`allowEvolutionPolicy`) --
 * durable-link subset proofs stay strict.
 *
 * The member check cannot distinguish every class pair (the legacy shapes do
 * not either -- a required `length` is satisfied by `FabricHash` as well as
 * `FabricBytes`, and the epoch types are structurally identical), so a
 * cross-class transition can pass here. That acceptance is backstopped at the
 * value level: pattern setup re-validates the piece's stored argument against
 * the incoming schema (see {@link assertPatternSchemasBackwardCompatible}),
 * and a stored primitive of the wrong class fails its prototype check there.
 */
function fabricPrimitiveEvolutionAccepts(
  source: SchemaObject,
  target: SchemaObject,
): boolean {
  if (
    !Object.keys(source).every((key) => FABRIC_EVOLUTION_SOURCE_KEYS.has(key))
  ) {
    return false;
  }
  if (
    !Object.keys(target).every((key) => FABRIC_EVOLUTION_TARGET_KEYS.has(key))
  ) {
    return false;
  }

  const sourceTypes = schemaTypes(source);
  if (sourceTypes?.length !== 1 || sourceTypes[0] !== "object") return false;
  const required = source.required;
  if (
    !Array.isArray(required) || !required.includes(FABRIC_SPECIAL_OBJECT_BRAND)
  ) {
    return false;
  }

  const targetTypes = schemaTypes(target);
  if (targetTypes === undefined) return false;
  return targetTypes.some((targetType) =>
    isFabricPrimitiveSchemaType(targetType) &&
    required.every((key) =>
      key === FABRIC_SPECIAL_OBJECT_BRAND ||
      FABRIC_PRIMITIVE_MEMBERS[targetType].has(key)
    )
  );
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
      (sourceType === "integer" && targetType === "number") ||
      // Each fabric-primitive type is a subtype of "object" (mirrors
      // schemaTypeMatchesValueType in the runner's traverse).
      (isFabricPrimitiveSchemaType(sourceType) && targetType === "object")
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
  if (schemaMayProduceType(source, ["number", "integer"])) {
    const sourceLower = effectiveNumericBound(source, "lower");
    const targetLower = effectiveNumericBound(target, "lower");
    if (
      targetLower !== undefined &&
      (sourceLower === undefined || targetLower.value > sourceLower.value ||
        targetLower.value === sourceLower.value && targetLower.exclusive &&
          !sourceLower.exclusive)
    ) {
      return `${path}: numeric lower bound became more restrictive`;
    }

    const sourceUpper = effectiveNumericBound(source, "upper");
    const targetUpper = effectiveNumericBound(target, "upper");
    if (
      targetUpper !== undefined &&
      (sourceUpper === undefined || targetUpper.value < sourceUpper.value ||
        targetUpper.value === sourceUpper.value && targetUpper.exclusive &&
          !sourceUpper.exclusive)
    ) {
      return `${path}: numeric upper bound became more restrictive`;
    }
  }

  const lowerBounds = [
    ["minLength", ["string"]],
    ["minItems", ["array"]],
    ["minProperties", ["object"]],
  ] as const;
  for (const [key, applicableTypes] of lowerBounds) {
    if (!schemaMayProduceType(source, applicableTypes)) continue;
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
    ["maxLength", ["string"]],
    ["maxItems", ["array"]],
    ["maxProperties", ["object"]],
  ] as const;
  for (const [key, applicableTypes] of upperBounds) {
    if (!schemaMayProduceType(source, applicableTypes)) continue;
    const sourceValue = source[key];
    const targetValue = target[key];
    if (
      targetValue !== undefined &&
      (sourceValue === undefined || sourceValue > targetValue)
    ) {
      return `${path}: ${key} became more restrictive`;
    }
  }

  if (
    schemaMayProduceType(source, ["array"]) && target.uniqueItems === true &&
    source.uniqueItems !== true
  ) {
    return `${path}: uniqueItems became more restrictive`;
  }
  if (
    schemaMayProduceType(source, ["string"]) &&
    target.pattern !== undefined && source.pattern !== target.pattern
  ) {
    return `${path}: pattern changed in a way compatibility checking cannot prove safe`;
  }
  if (
    schemaMayProduceType(source, ["string"]) && target.format !== undefined &&
    source.format !== target.format
  ) {
    return `${path}: format changed in a way compatibility checking cannot prove safe`;
  }
  if (
    schemaMayProduceType(source, ["number", "integer"]) &&
    target.multipleOf !== undefined
  ) {
    if (
      source.multipleOf === undefined ||
      source.multipleOf % target.multipleOf !== 0
    ) {
      return `${path}: multipleOf became more restrictive`;
    }
  }
  return undefined;
}

interface NumericBound {
  value: number;
  exclusive: boolean;
}

function effectiveNumericBound(
  schema: SchemaObject,
  direction: "lower" | "upper",
): NumericBound | undefined {
  const inclusive = direction === "lower" ? schema.minimum : schema.maximum;
  const exclusive = direction === "lower"
    ? schema.exclusiveMinimum
    : schema.exclusiveMaximum;
  if (inclusive === undefined) {
    return exclusive === undefined
      ? undefined
      : { value: exclusive, exclusive: true };
  }
  if (exclusive === undefined) {
    return { value: inclusive, exclusive: false };
  }
  if (inclusive === exclusive) {
    return { value: inclusive, exclusive: true };
  }
  const exclusiveIsStricter = direction === "lower"
    ? exclusive > inclusive
    : exclusive < inclusive;
  return exclusiveIsStricter
    ? { value: exclusive, exclusive: true }
    : { value: inclusive, exclusive: false };
}

/** JSON Schema scalar keywords are ignored for values of unrelated types. */
function schemaMayProduceType(
  schema: SchemaObject,
  applicableTypes: readonly string[],
): boolean {
  const types = schemaTypes(schema);
  return types === undefined || types.includes("unknown") ||
    types.some((type) => applicableTypes.includes(type));
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
  const proofContext = source.length > 1 || target.length > 1
    ? { ...context, allowEvolutionPolicy: false }
    : context;
  for (const targetConstraint of target) {
    const implied = source.some((sourceConstraint) =>
      schemaSubsetIssue(
        sourceConstraint,
        targetConstraint,
        path,
        proofContext,
      ) === undefined
    );
    if (!implied) {
      return `${path}: a schema alternative accepted previously is not accepted by the candidate`;
    }
  }
  return undefined;
}

function hasComplexSameInstanceConstraints(schema: SchemaObject): boolean {
  return COMPLEX_CONSTRAINT_KEYS.some((key) => schema[key] !== undefined);
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

function schemaDefaultsResolveEqually(
  source: JSONSchema,
  target: JSONSchema,
  context: CompatibilityContext,
): boolean {
  const sourceHasDefault = schemaHasDefaultValue(source, context.sourceRoot);
  const targetHasDefault = schemaHasDefaultValue(target, context.targetRoot);
  return sourceHasDefault === targetHasDefault &&
    (!sourceHasDefault ||
      fabricAwareEqual(
        extractDefaultValues(source, context.sourceRoot),
        extractDefaultValues(target, context.targetRoot),
      ));
}

type ActiveSchemasByStability = WeakMap<
  object,
  { stable: WeakSet<object>; unstable: WeakSet<object> }
>;

/** Whether target default merging can violate an ancestor constraint. */
function schemaHasUnsafeMaterializedDefault(
  input: JSONSchema,
  root: JSONSchema,
  unstableAncestor = false,
  activeByRoot: ActiveSchemasByStability = new WeakMap(),
): boolean {
  const resolution = resolveSchema(input, root);
  const schema = resolution.schema;
  if (typeof schema !== "object" || schema === null) return false;

  const rootKey = typeof resolution.root === "object" &&
      resolution.root !== null
    ? resolution.root
    : schema;
  let active = activeByRoot.get(rootKey);
  if (active === undefined) {
    active = { stable: new WeakSet(), unstable: new WeakSet() };
    activeByRoot.set(rootKey, active);
  }
  const unstable = unstableAncestor ||
    !schemaIsStableUnderDescendantDefaults(schema);
  const activeForPath = unstable ? active.unstable : active.stable;
  if (activeForPath.has(schema)) return false;
  activeForPath.add(schema);
  try {
    if (unstable && Object.hasOwn(schema, "default")) return true;

    const children: JSONSchema[] = [];
    for (
      const collection of [
        schema.properties,
        schema.patternProperties,
      ]
    ) {
      if (collection !== undefined) {
        children.push(...Object.values(collection));
      }
    }
    for (const child of [schema.additionalProperties, schema.items]) {
      if (child !== undefined) children.push(child);
    }
    for (
      const collection of [
        schema.prefixItems,
        schema.anyOf,
        schema.oneOf,
      ]
    ) {
      if (collection !== undefined) children.push(...collection);
    }
    return children.some((child) =>
      schemaHasUnsafeMaterializedDefault(
        child,
        resolution.root,
        unstable,
        activeByRoot,
      )
    );
  } finally {
    activeForPath.delete(schema);
  }
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
  return schemaHasDefaultValue(schema, fullSchema) &&
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
