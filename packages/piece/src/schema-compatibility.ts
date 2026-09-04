import {
  extractDefaultValues,
  type JSONSchema,
  type Pattern,
  schemaHasDefaultValue,
} from "@commonfabric/runner";
import {
  cfcSchemaChildRoot,
  type IfcKey,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
  validateSchemaDefinition,
  validateSchemaValue,
} from "@commonfabric/runner/cfc";
import { isFabricPrimitiveSchemaType } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model-schema";
import { fabricAwareEqual } from "@commonfabric/data-model";

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

/**
 * The keywords a schema comparison may ignore: they annotate a schema without
 * constraining the values it admits, so adding or removing one across a piece
 * update proves nothing about compatibility either way.
 *
 * Exported because a second reader classifies keywords and would otherwise
 * keep its own copy of this list. What it says is which keywords are
 * validation-neutral **to this checker**; it is not a statement about what any
 * other consumer of a schema does with a key, and a reader that acts on one —
 * the runner reserves three `$comment` values as traversal control markers —
 * has to settle that against that consumer rather than against this set.
 */
export const ANNOTATION_KEYS: ReadonlySet<string> = new Set([
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

/**
 * The keys inside a `writeAuthorizedBy` writer claim's `__ctWriterIdentityOf`
 * that a backward-compatibility comparison ignores, because the runtime's
 * write-time authorization does not hold them fixed either.
 *
 * `moduleIdentity` (and the legacy `bundleId`) is the content hash of the
 * authoring module. It rehashes on any edit to that module, and the runtime
 * re-verifies the live writer's `moduleIdentity` against the claim at write
 * time (`writeAuthorizedByReason`, `packages/runner/src/cfc/prepare.ts`), so the
 * comparison defers it to that live check rather than reading a recompile as a
 * contract change.
 *
 * `file` is the module's source-file spelling, and that spelling is
 * resolver-dependent: the same module spells differently across piece-deploy
 * staging, piece-manifest-relative, and HTTP-resolved compiles
 * (`packages/runner/src/cfc/writer-claim-correspondence.ts`, labs#4772). The
 * runtime authorization ignores `file` entirely — it anchors on `moduleIdentity`
 * plus the binding `path` — so two claims that differ only in `file` authorize
 * identically, and the comparison must not reject one as the other's
 * incompatible successor.
 */
const WRITER_IDENTITY_VOLATILE_KEYS: ReadonlySet<string> = new Set([
  "bundleId",
  "file",
  "moduleIdentity",
]);

/**
 * Return an `ifc` extension with the volatile identity of a `writeAuthorizedBy`
 * writer claim removed, so that neither a recompile of the authorizing module
 * nor a cross-resolver rebuild of the same module reads as a contract change in
 * the semantic-extension comparison below.
 *
 * A CFC write authorization (`TrustedActionWrite`) lowers to
 * `ifc.writeAuthorizedBy.__ctWriterIdentityOf`, which records the authoring
 * module three ways: its content hash (`moduleIdentity`, and the legacy
 * `bundleId`), its source-file spelling (`file`), and the binding `path` within
 * the module. The runtime's write-time authorization anchors on `moduleIdentity`
 * plus `path` alone (`writeAuthorizedByReason`,
 * `packages/runner/src/cfc/prepare.ts`): it re-verifies the live writer's
 * `moduleIdentity` against the claim and never consults `file`. So both the
 * content hash and the file spelling are volatile against anything a caller can
 * depend on — the hash rehashes on any edit to the module, and the file spelling
 * changes with the resolver that compiled it (labs#4772). Removing both here
 * stops the schema diff from reading "the code was edited" or "a different
 * resolver compiled it" as "the contract changed"; it weakens no enforcement,
 * because the runtime holds neither field fixed.
 *
 * Everything a caller can depend on is kept and still compared: the binding
 * `path` — the coordinate the runtime authorizes against — and the entire
 * `uiContract` (helper/action/surface/role/kind/trustedPattern/
 * requiredEventIntegrity). The builtin `readonly string[]` form of
 * `writeAuthorizedBy` names trusted builtins rather than a compiled module, so
 * it carries no writer identity and is returned unchanged.
 *
 * This runs where the `ifc` extension is compared as a semantic-extension key,
 * which the per-node recursion reaches for a claim placed directly on a
 * property, behind a `$defs` reference, or in an `anyOf` branch. A claim
 * reached only through a composite keyword (`allOf`, `oneOf`, `if`/`then`,
 * `not`) is compared by whole-value equality instead, so its volatile identity
 * still participates and a recompile there is reported as a change.
 */
const writerClaimWithoutVolatileIdentity = (claim: unknown): unknown => {
  if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
    return claim;
  }
  const identity = (claim as Record<string, unknown>).__ctWriterIdentityOf;
  if (typeof identity !== "object" || identity === null) return claim;
  const strippedIdentity: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(identity)) {
    if (WRITER_IDENTITY_VOLATILE_KEYS.has(key)) continue;
    strippedIdentity[key] = value;
  }
  return {
    ...(claim as Record<string, unknown>),
    __ctWriterIdentityOf: strippedIdentity,
  };
};

/**
 * What each `ifc` key contributes to this comparison.
 *
 * `declared` is the store policy a caller depends on: a claim about what the
 * store holds, or a requirement on who may write or read it. A change to one is
 * a change to the contract, and the values are compared as they stand.
 *
 * `derived` describes the label a write produces rather than the policy the
 * store declares. CFC §8.12.8 gives a persisted path three label components and
 * a discipline for each: the declared store policy is monotone, while the
 * derived per-value component is replace-on-overwrite, and that section states
 * that a runtime must not apply the monotone constraint to the derived one.
 * This comparison is that monotone constraint, so it drops these keys — except
 * for the part of a mint that an `ownerPrincipal` beside it turns into
 * authorization evidence, which `comparableIfc` keeps.
 *
 * `writerIdentity` is the write authorization, compared except for the parts of
 * its claim that move without the authorization moving.
 */
type IfcKeyRole = "declared" | "derived" | "writerIdentity";

/**
 * A role for every key of {@link IFC_KEYS}. The mapped type is the point: a new
 * `ifc` key in the runtime fails to type-check here until someone decides what
 * it means for two contracts to differ in it. A key this table does not name at
 * all — an unrecognized extension — is compared as it stands, which is the
 * fail-closed direction.
 */
const IFC_KEY_ROLES: { readonly [K in IfcKey]: IfcKeyRole } = {
  confidentiality: "declared",
  integrity: "declared",
  requiredIntegrity: "declared",
  maxConfidentiality: "declared",
  ownerPrincipal: "declared",
  exactCopyOf: "declared",
  projection: "declared",
  collection: "declared",
  flowPrecisionClaim: "declared",
  uiContract: "declared",
  writeAuthorizedBy: "writerIdentity",
  // `addIntegrity` is the lowered form of the spec's `addedIntegrity`
  // transition annotation, and of the `RepresentsCurrentUser` and
  // `AuthoredByCurrentUser` spellings that expand to it. It names atoms the
  // runtime attaches to the integrity of the value a write produces (CFC
  // §8.9.3's output labels), which is the derived component of §8.12.8.
  //
  // Dropping it is what lets a path repair a floor it cannot satisfy. A schema
  // can require that anything written to one of its locations already carry a
  // named atom, and that floor is tested against the value the write produces.
  // An `addIntegrity` on the entries below the location does not reach a floor
  // declared on the location itself, so a schema that requires an atom and
  // attaches none refuses every write to that location. The repair is to attach
  // the atom the same declaration asks for, and comparing this key for equality
  // would report that repair as an incompatible successor.
  //
  // Dropping the key cuts both ways: losing a mint is not a contract change
  // either. A pattern whose own writes stop satisfying its own floor is a
  // defect its own tests catch, at the path where the write happens. A reader
  // elsewhere whose floor rested on atoms this path minted fails at that
  // reader's own check, which is where `docs/specs/piece-source-lifecycle.md`
  // places a result contract's drift. Neither is a statement about the contract
  // between two versions of this pattern, which is what this comparison
  // decides.
  addIntegrity: "derived",
};

/**
 * Copy one key onto the reduced extension.
 *
 * Uses `defineProperty` rather than `kept[key] = value`, the same way
 * `stripUndefinedProps` in `@commonfabric/utils` does, so that a key named
 * `"__proto__"` lands as a plain own data property rather than reaching the
 * prototype setter. A schema read off the wire can carry such a key, because
 * `JSON.parse` makes it an own property, and a key this comparison does not
 * recognize is one it has to keep comparing.
 */
const keep = (
  kept: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  Object.defineProperty(kept, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
};

/**
 * The parts of a mint that an `ownerPrincipal` check consults: the atoms
 * claiming to represent a principal. Everything else is a label the runtime
 * attaches and no authorization reads.
 *
 * The search walks arrays and object values, because
 * `literalDidSubjectsForPrincipalClaim` (runner `cfc/prepare.ts`) does: an atom
 * nested inside another structure still authorizes a write, so a flat scan
 * would drop evidence the runtime acts on.
 *
 * Every such atom is kept, not only one whose subject reads as the owner. The
 * runtime resolves a current-principal placeholder against the acting principal
 * of a live trust snapshot before it matches, and this comparison has neither,
 * so which atom will match cannot be decided here. Keeping all of them refuses
 * a few updates that would in fact have been safe, which is the direction to
 * err in.
 */
const representsPrincipalAtoms = (value: unknown): readonly unknown[] => {
  if (Array.isArray(value)) return value.flatMap(representsPrincipalAtoms);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  if (record.kind === "represents-principal") return [value];
  return Object.values(record).flatMap(representsPrincipalAtoms);
};

/**
 * Return an `ifc` extension reduced to what this comparison decides: the
 * derived per-value keys dropped, and a write authorization's volatile identity
 * normalized. Returns the input unchanged when neither applies.
 *
 * This runs where `ifc` is compared as a semantic-extension key, which the
 * per-node recursion reaches for a node written directly on a property, behind
 * a `$defs` reference, or in an `anyOf` branch. An `ifc` reached only through a
 * composite keyword (`allOf`, `oneOf`, `if`/`then`, `not`) is compared by whole
 * value instead, so a mint there still reads as a change — the same scope the
 * writer-identity normalization has.
 *
 * An extension with no keys left comes back as `undefined`, the same as no
 * extension at all, and so does one that arrived empty. A path that carried no
 * `ifc` and gains only a mint therefore compares equal to what it was, and so
 * does one whose last mint is removed. Without that, the reduced `{}` would differ
 * from the absent one and the update would be refused for the very change this
 * reduction exists to allow.
 */
const comparableIfc = (ifc: unknown): unknown => {
  if (typeof ifc !== "object" || ifc === null || Array.isArray(ifc)) return ifc;
  const source = ifc as Record<string, unknown>;
  // Beside an `ownerPrincipal`, part of the mint is not a derived label at all.
  // `currentPrincipalIntegrityReason` (runner `cfc/prepare.ts`) reads the
  // `represents-principal` atoms out of `addIntegrity` and requires one whose
  // subject is the owner before it authorizes the write, so losing those
  // refuses writes the node used to accept. Every other atom in the array is
  // still a label the runtime attaches and nothing consults, so only the
  // owner-matching evidence is held to the contract.
  const ownerAuthorizesWrites = source.ownerPrincipal !== undefined;
  // Most `ifc` nodes carry only declared keys and come back untouched. Scanning
  // for a key that needs handling walks the keys without building anything, so
  // that common node costs no allocation at all.
  let handled = false;
  let empty = true;
  for (const key in source) {
    empty = false;
    const role: IfcKeyRole | undefined = IFC_KEY_ROLES[key as IfcKey] as
      | IfcKeyRole
      | undefined;
    if (role === "derived" || role === "writerIdentity") {
      handled = true;
      break;
    }
  }
  // An extension with nothing in it says the same as no extension, whether it
  // arrived that way or is what the reduction below leaves behind. Both come
  // back as `undefined`, so the two compare equal either way round.
  if (empty) return undefined;
  if (!handled) return ifc;
  const kept: Record<string, unknown> = {};
  let changed = false;
  for (const key in source) {
    const value = source[key];
    const role: IfcKeyRole | undefined = IFC_KEY_ROLES[key as IfcKey] as
      | IfcKeyRole
      | undefined;
    if (role === "derived") {
      const evidence = ownerAuthorizesWrites
        ? representsPrincipalAtoms(value)
        : [];
      changed = true;
      if (evidence.length > 0) keep(kept, key, evidence);
      continue;
    }
    if (role === "writerIdentity") {
      const normalized = writerClaimWithoutVolatileIdentity(value);
      if (normalized !== value) changed = true;
      keep(kept, key, normalized);
      continue;
    }
    keep(kept, key, value);
  }
  if (!changed) return ifc;
  for (const _key in kept) return kept;
  return undefined;
};

/**
 * Reject a piece update unless its argument and result schemas preserve the
 * contracts of the currently running pattern.
 *
 * Arguments are contravariant and results are covariant. Open argument objects
 * may still gain optional/defaulted named fields as the piece-evolution policy,
 * and may drop named fields the pattern no longer reads — a demand given up
 * leaves a writer's value unread, where a dropped result field breaks a reader,
 * so only the result side preserves its named fields outright. A candidate that
 * cannot hold a dropped field's value is still refused, by the ordinary
 * named-property proof against its additionalProperties contract. What keeps
 * those allowances sound is a second check at update time rather than anything
 * provable here: pattern setup re-stages the piece's stored argument
 * against the incoming schema and validates it inside the setup transaction, so
 * an update whose durable argument the new schema cannot read is refused
 * instead of landing over unreadable state. Two sites do the checking, and the
 * line between them is whether the caller will (re)instantiate the graph, not
 * whether the piece happens to be running: `Runner.#applySetupState` re-points
 * and validates the argument for a cold root and for the watcher's hot-swap,
 * both of which then instantiate; `Runner.#validateStoredArgument` checks a
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
 *
 * The semantic-extension keys (`asCell`, `ifc`, `readOnly`, `scope`,
 * `writeOnly`) are compared for exact equality, with one exception: a
 * `writeAuthorizedBy` writer claim's volatile identity is normalized out before
 * the `ifc` comparison. That identity is the content-addressed module hash
 * (`moduleIdentity`, and the legacy `bundleId`), which rehashes on any edit to
 * the authoring module, together with the source-file spelling (`file`), which
 * changes with the resolver that compiled the module. The runtime authorizes a
 * write on `moduleIdentity` plus the binding `path` and never on `file`, and it
 * re-verifies the live writer's `moduleIdentity` against the claim at write
 * time, so holding those fields fixed here would reject a recompile or a
 * cross-resolver rebuild of an unchanged authorization. The binding `path` and
 * the whole `uiContract` are still compared, and the runtime enforcement is
 * untouched, so this narrows nothing.
 *
 * The `ifc` comparison drops one key as well. `addIntegrity` names the derived
 * per-value label rather than the store's declared policy, so a path gaining or
 * losing a mint is not a change to the contract between two versions of the
 * pattern — except beside an `ownerPrincipal`, where the atoms of that mint
 * claiming to represent a principal are what authorizes the write, and those
 * are compared. `comparableIfc` performs both reductions, and
 * {@link IfcKeyRole} states which keys take part in each.
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

    // A brand-marked structural emission (the pre-vocabulary generator's
    // shape for a `FabricSpecialObject`) moving to a `FabricPrimitive`-typed
    // schema is deliberately NOT allowed through here, even under
    // `allowEvolutionPolicy`. The structural schema is an ordinary object
    // schema, so its value population is decided structurally: a plain
    // record carrying the brand key as an own property satisfies it, and the
    // presence-only `required` checks admit primitives of other classes
    // (`FabricHash` has `length`, so it inhabits the `FabricBytes` emission).
    // A `FabricPrimitive`-typed schema matches by prototype, and a pattern
    // update rewrites the stored argument verbatim -- nothing converts -- so
    // every such inhabitant would survive the update only to be rejected by
    // reads. The transition therefore narrows for every class, and it is
    // refused here (`type object is not accepted`) rather than deferred to a
    // read-time rejection; updating such a piece requires redeployment or
    // `dangerouslyAllowIncompatibleSchema`.

    const literalIssue = literalSubsetIssue(source, target, path);
    if (literalIssue) return literalIssue;

    const typeIssue = typeSubsetIssue(source, target, path);
    if (typeIssue) return typeIssue;

    const constraintIssue = scalarConstraintSubsetIssue(source, target, path);
    if (constraintIssue) return constraintIssue;

    for (const key of SEMANTIC_EXTENSION_KEYS) {
      // The `ifc` extension is compared for exact equality except for a
      // `writeAuthorizedBy` writer claim's volatile identity — its content hash
      // and its resolver-dependent file spelling, which the runtime does not
      // hold fixed either — and the derived per-value label annotations, which
      // describe the label a write produces rather than the policy the store
      // declares. `comparableIfc` removes both.
      const sourceValue = key === "ifc"
        ? comparableIfc(source[key])
        : source[key];
      const targetValue = key === "ifc"
        ? comparableIfc(target[key])
        : target[key];
      if (!fabricAwareEqual(sourceValue, targetValue)) {
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
  return Object.keys(schema).every((key) => {
    if (DEFAULT_STABLE_SCHEMA_KEYS.has(key)) return true;
    return (key === "anyOf" || key === "oneOf") &&
      alternativesDeclareDisjointTypes(schema[key]!);
  });
}

/**
 * Whether composition branches can never change membership after descendant
 * defaults are inserted because their accepted top-level types do not overlap.
 */
function alternativesDeclareDisjointTypes(
  alternatives: readonly JSONSchema[],
): boolean {
  const declared = alternatives.map((alternative) => {
    if (alternative === false) return [] as string[];
    if (alternative === true) return undefined;
    const types = schemaTypes(alternative);
    return types === undefined || types.includes("unknown")
      ? undefined
      : [...types];
  });
  if (declared.some((types) => types === undefined)) return false;
  for (let left = 0; left < declared.length; left++) {
    for (let right = left + 1; right < declared.length; right++) {
      if (
        declared[left]!.some((leftType) =>
          declared[right]!.some((rightType) =>
            leftType === rightType ||
            leftType === "number" && rightType === "integer" ||
            leftType === "integer" && rightType === "number" ||
            leftType === "object" &&
              isFabricPrimitiveSchemaType(rightType) ||
            isFabricPrimitiveSchemaType(leftType) && rightType === "object"
          )
        )
      ) {
        return false;
      }
    }
  }
  return true;
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

  // A result's named fields are the contract consumers read, so evolution
  // preserves every one of them even when the candidate object is otherwise
  // open. An argument's are not: dropping one gives up a demand, which leaves a
  // writer's value unread rather than breaking a reader. What the stored
  // argument still needs — that the candidate can hold the value the piece
  // already carries — the named-property proof below decides per field,
  // accepting it under an open candidate and reporting it under a closed one. A
  // durable-link subset proof reaches that same proof from the other side: a
  // source may name additional fields that an open target accepts through
  // patternProperties/additionalProperties, and treating those as "removed"
  // rejects valid Fabric projections such as $FS.
  if (context.defaultComparison === "evolution" && context.role === "result") {
    for (const property of Object.keys(previousProperties)) {
      if (Object.hasOwn(candidateProperties, property)) continue;
      return `${path}.${property}: existing result field was removed`;
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
    // Not below a verb node, where the same reasoning runs the other way. A
    // result field that stops being required withdraws a guarantee its
    // readers were given. An EVENT field that stops being required widens
    // what the verb accepts: every call already written still sent it, so
    // every one of them still validates. The argument side permits exactly
    // this relaxation, and a verb's event is an argument in every respect but
    // where it is declared.
    if (!context.verbEvent) {
      for (const property of targetRequired) {
        if (!sourceRequired.has(property)) {
          return `${path}.${property}: result field is no longer required`;
        }
      }
    }
    // The candidate pattern produces its result. A newly required field does
    // not need a migration default: the new graph materializes that output when
    // it runs. Existing required-result guarantees above still cannot weaken,
    // and existing field types remain checked covariantly below.
    //
    // A verb's event is the exception, and it is one of location rather than of
    // principle. The node sits in the result, so this covariant comparison
    // reaches it — but the pattern does not produce the event, the CALLER
    // supplies it. Requiring a field the previous event did not is therefore a
    // demand made of every call already written, and each one that omits it is
    // refused at dispatch once the update has landed. Below a verb node the
    // rule is the argument side's, stated in this comparison's direction:
    // `source` is the candidate here, where `target` is the candidate there.
    // The rescue turns on the field's own default and not on
    // `allowEvolutionDefaults`, which the verb node above has already set
    // false: `asCell` is not default-stable, so descending through one
    // withdraws permission to introduce a default anywhere below. That
    // withdrawal is about defaults that CHANGE, which the check above decides
    // on its own. A field that carried the same default before and after
    // changes nothing and still materializes for a caller that omits it, so
    // reusing the flag here would refuse the one evolution this rule means to
    // allow.
    if (context.verbEvent) {
      for (const property of sourceRequired) {
        if (
          !targetRequired.has(property) &&
          !schemaProvidesValidDefault(
            sourceProperties[property],
            context.sourceRoot,
          )
        ) {
          return `${path}.${property}: newly required verb event field has no default`;
        }
      }
    }

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
      // Each `FabricPrimitive` type is a subtype of "object" (mirrors
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
    // A default on this schema replaces this schema's value. Constraints on
    // this same node (for example `anyOf` beside `default`) validate that
    // replacement directly; they are not ancestors that descendant insertion
    // can perturb. Fail only when a strict ancestor can observe the inserted
    // value, or when the same-node default is itself invalid.
    if (
      Object.hasOwn(schema, "default") &&
      (unstableAncestor ||
        !schemaProvidesValidDefault(schema, resolution.root))
    ) {
      return true;
    }

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
