import type { JSONSchema, JSONValue } from "@commontools/api";
import type { Cell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  Labels,
} from "../storage/interface.ts";
import type { NormalizedFetchDataInputs } from "../builtins/fetch-request.ts";
import { effectiveLabelForPath } from "./consumed-input-labels.ts";
import {
  computeCfcFetchRequestDigest,
  deriveCfcFetchRequestSemantics,
} from "./fetch-request-semantics.ts";
import { cfcSchemaBlobAddress } from "./schema-blob.ts";
import {
  type CfcAtom,
  type CfcConfidentialityClause,
  joinConfidentialityLabels,
  joinIntegrityLabels,
  normalizeConfidentialityLabel,
  normalizeIntegrityLabel,
} from "./label-algebra.ts";
import {
  cfcLabelsAddress,
  joinObservedLabels,
  labelsPresent,
  normalizePersistedPathLabels,
  type PersistedPathLabels,
} from "./shared.ts";

const AUTHORIZED_REQUEST_ATOM =
  "https://commonfabric.org/cfc/atom/AuthorizedRequest";
const NETWORK_PROVENANCE_ATOM =
  "https://commonfabric.org/cfc/atom/NetworkProvenance";
const FETCH_BUILTIN_IDENTITY = "Builtin(fetchData)";

type FetchSinkRule = {
  readonly confidentialityPre: readonly CfcAtom[];
  readonly integrityPre: readonly CfcAtom[];
  readonly addAlternatives: readonly CfcAtom[];
  readonly removeMatchedClauses: boolean;
  readonly allowedPaths: readonly string[];
};

type CfcEntityAddress = Pick<IMemorySpaceAddress, "space" | "id" | "type">;

export interface DeriveFetchSinkResultLabelsOptions {
  readonly endpoint?: string;
  readonly actingPrincipal?: string;
  readonly additionalRequestIntegrity?: readonly CfcAtom[];
}

interface FetchSinkRequestContext {
  readonly requestLink: CfcEntityAddress;
  readonly requestSchema: JSONSchema | undefined;
  readonly labelsByPath: PersistedPathLabels;
  readonly aggregate: Labels | undefined;
  readonly rules: readonly FetchSinkRule[];
}

function atomKey(atom: JSONValue): string {
  return JSON.stringify(atom);
}

function normalizeAtomList(value: unknown): readonly CfcAtom[] {
  return normalizeIntegrityLabel(value) ?? [];
}

function toCanonicalPath(segments: readonly string[]): string {
  if (segments.length === 0) {
    return "/";
  }
  const encoded = segments.map((segment) =>
    segment.replaceAll("~", "~0").replaceAll("/", "~1")
  );
  return `/${encoded.join("/")}`;
}

function normalizeAllowedPaths(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const paths: string[] = [];
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      !entry.every((segment) => typeof segment === "string")
    ) {
      continue;
    }
    paths.push(toCanonicalPath(entry));
  }
  return [...new Set(paths)].sort();
}

function parseFetchSinkRule(rawRule: unknown): FetchSinkRule | undefined {
  if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
    return undefined;
  }
  if ((rawRule as { allowedSink?: unknown }).allowedSink !== "fetchData") {
    return undefined;
  }

  const confidentialityPre = normalizeAtomList(
    (rawRule as { confidentialityPre?: unknown }).confidentialityPre,
  );
  const integrityPre = normalizeAtomList(
    (rawRule as { integrityPre?: unknown }).integrityPre,
  );
  const addAlternatives = normalizeAtomList(
    (rawRule as { addAlternatives?: unknown }).addAlternatives,
  );
  const removeMatchedClauses =
    (rawRule as { removeMatchedClauses?: unknown }).removeMatchedClauses ===
      true;
  const allowedPaths = normalizeAllowedPaths(
    (rawRule as { allowedPaths?: unknown }).allowedPaths,
  );

  if (confidentialityPre.length === 0 || allowedPaths.length === 0) {
    return undefined;
  }
  if (!removeMatchedClauses && addAlternatives.length === 0) {
    return undefined;
  }

  return {
    confidentialityPre,
    integrityPre,
    addAlternatives,
    removeMatchedClauses,
    allowedPaths,
  };
}

function collectRawFetchSinkRules(
  rawConfig: unknown,
  rules: FetchSinkRule[],
): void {
  if (rawConfig === undefined) {
    return;
  }
  if (Array.isArray(rawConfig)) {
    for (const rawRule of rawConfig) {
      const parsed = parseFetchSinkRule(rawRule);
      if (parsed) {
        rules.push(parsed);
      }
    }
    return;
  }
  if (!rawConfig || typeof rawConfig !== "object") {
    return;
  }

  const nestedRules = (rawConfig as { rules?: unknown }).rules;
  if (Array.isArray(nestedRules)) {
    for (const rawRule of nestedRules) {
      const parsed = parseFetchSinkRule(rawRule);
      if (parsed) {
        rules.push(parsed);
      }
    }
    return;
  }

  const parsed = parseFetchSinkRule(rawConfig);
  if (parsed) {
    rules.push(parsed);
  }
}

function collectFetchSinkRules(
  schema: JSONSchema | undefined,
  rules: FetchSinkRule[],
  seen = new Set<object>(),
): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return;
  }
  if (seen.has(schema)) {
    return;
  }
  seen.add(schema);

  const rawIfc = (schema as { ifc?: unknown }).ifc;
  if (rawIfc && typeof rawIfc === "object" && !Array.isArray(rawIfc)) {
    collectRawFetchSinkRules(
      (rawIfc as { exchange?: unknown }).exchange,
      rules,
    );
  }

  const properties = (schema as { properties?: unknown }).properties;
  if (
    properties && typeof properties === "object" && !Array.isArray(properties)
  ) {
    for (
      const child of Object.values(properties as Record<string, JSONSchema>)
    ) {
      collectFetchSinkRules(child, rules, seen);
    }
  }

  const additionalProperties = (
    schema as { additionalProperties?: unknown }
  ).additionalProperties;
  if (
    additionalProperties &&
    typeof additionalProperties === "object" &&
    !Array.isArray(additionalProperties)
  ) {
    collectFetchSinkRules(additionalProperties as JSONSchema, rules, seen);
  }

  const items = (schema as { items?: unknown }).items;
  if (Array.isArray(items)) {
    for (const child of items) {
      collectFetchSinkRules(child as JSONSchema, rules, seen);
    }
  } else {
    collectFetchSinkRules(items as JSONSchema | undefined, rules, seen);
  }

  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const entries = (schema as Record<string, unknown>)[key];
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const child of entries) {
      collectFetchSinkRules(child as JSONSchema, rules, seen);
    }
  }
}

function schemaHashAddress(entity: CfcEntityAddress) {
  return {
    space: entity.space,
    id: entity.id,
    type: entity.type,
    path: ["cfc", "schemaHash"],
  } as const;
}

async function loadPersistedRequestSchema(
  runtime: Runtime,
  requestLink: CfcEntityAddress,
): Promise<JSONSchema | undefined> {
  const readTx = runtime.edit();
  const schemaHash = readTx.readOrThrow(schemaHashAddress(requestLink));
  if (typeof schemaHash !== "string" || schemaHash.length === 0) {
    await readTx.abort();
    return undefined;
  }

  const schemaValue = readTx.readOrThrow({
    ...cfcSchemaBlobAddress(requestLink.space, schemaHash),
    path: ["value"],
  });
  await readTx.abort();
  if (!schemaValue || typeof schemaValue !== "object") {
    return undefined;
  }
  return schemaValue as JSONSchema;
}

function aggregateRequestLabels(
  labelsByPath: PersistedPathLabels,
): Labels | undefined {
  const observed: Labels[] = [];
  for (const entry of Object.values(labelsByPath)) {
    if (entry.label) {
      observed.push(entry.label);
    }
    if (entry.shape) {
      observed.push(entry.shape);
    }
    if (entry.value) {
      observed.push(entry.value);
    }
    if (entry.iterate?.order) {
      observed.push(entry.iterate.order);
    }
    if (entry.iterate?.count) {
      observed.push(entry.iterate.count);
    }
  }
  return joinObservedLabels(observed);
}

function rootWriteLabel(
  labelsByPath: PersistedPathLabels,
  path: string,
): Labels | undefined {
  const existing = labelsByPath[path];
  return existing?.value ?? existing?.label;
}

function toStorableLabelMap(
  labelsByPath: PersistedPathLabels,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(labelsByPath).map(([path, template]) => [path, template]),
  );
}

function withPathValueLabel(
  labelsByPath: PersistedPathLabels,
  path: string,
  label: Labels,
): PersistedPathLabels {
  const next: PersistedPathLabels = { ...labelsByPath };
  next[path] = {
    ...(next[path] ?? {}),
    label,
  };
  return next;
}

function containsAllAtoms(
  container: readonly CfcAtom[] | undefined,
  required: readonly CfcAtom[],
): boolean {
  if (required.length === 0) {
    return true;
  }
  const keys = new Set((container ?? []).map((atom) => atomKey(atom)));
  return required.every((atom) => keys.has(atomKey(atom)));
}

function joinExtraIntegrity(
  integrity: readonly CfcAtom[] | undefined,
  extraIntegrity: readonly CfcAtom[] | undefined,
): readonly CfcAtom[] | undefined {
  return joinIntegrityLabels(integrity, extraIntegrity);
}

function clauseMatchesRule(
  clause: CfcConfidentialityClause,
  rule: FetchSinkRule,
): boolean {
  return containsAllAtoms(clause, rule.confidentialityPre);
}

function ruleMatchesAtAllowedPath(
  labelsByPath: PersistedPathLabels,
  rule: FetchSinkRule,
  extraIntegrity: readonly CfcAtom[] | undefined = undefined,
): boolean {
  return rule.allowedPaths.some((path) => {
    const label = effectiveLabelForPath(labelsByPath, path);
    const classification =
      normalizeConfidentialityLabel(label?.classification) ??
        [];
    const pathMatches = classification.some((clause) =>
      clauseMatchesRule(clause, rule)
    );
    if (!pathMatches) {
      return false;
    }
    return containsAllAtoms(
      joinExtraIntegrity(label?.integrity, extraIntegrity),
      rule.integrityPre,
    );
  });
}

function applyRuleToClassification(
  classification: Labels["classification"],
  rule: FetchSinkRule,
): Labels["classification"] {
  const normalized = normalizeConfidentialityLabel(classification);
  if (!normalized || normalized.length === 0) {
    return normalized;
  }

  const nextClauses: CfcConfidentialityClause[] = [];
  for (const clause of normalized) {
    if (!clauseMatchesRule(clause, rule)) {
      nextClauses.push(clause);
      continue;
    }

    if (rule.removeMatchedClauses && rule.addAlternatives.length === 0) {
      continue;
    }

    const additions = rule.addAlternatives.filter((atom) =>
      !clause.some((entry) => atomKey(entry) === atomKey(atom))
    );
    nextClauses.push([...clause, ...additions]);
  }

  return normalizeConfidentialityLabel(nextClauses);
}

function isActingUserClause(
  clause: CfcConfidentialityClause,
  actingPrincipal: string | undefined,
): boolean {
  if (!actingPrincipal) {
    return false;
  }
  return clause.some((atom) => {
    if (typeof atom !== "object" || atom === null || Array.isArray(atom)) {
      return false;
    }
    const candidate = atom as { type?: unknown; subject?: unknown };
    return candidate.type === "https://commonfabric.org/cfc/atom/User" &&
      candidate.subject === actingPrincipal;
  });
}

function authorizationSatisfiedAfterSinkRewrite(
  classification: Labels["classification"],
  actingPrincipal: string | undefined,
): boolean {
  const normalized = normalizeConfidentialityLabel(classification);
  if (!normalized || normalized.length === 0) {
    return true;
  }
  return normalized.every((clause) =>
    isActingUserClause(clause, actingPrincipal)
  );
}

async function loadFetchSinkRequestContext(
  runtime: Runtime,
  inputsCell: Cell<unknown>,
): Promise<FetchSinkRequestContext> {
  const requestCell = inputsCell.getArgumentCell<{ request: unknown }>()
    ?.key("request")
    .resolveAsCell() ?? inputsCell.resolveAsCell();
  const requestLink = requestCell.getAsNormalizedFullLink();
  const requestSchema =
    await loadPersistedRequestSchema(runtime, requestLink) ??
      requestCell.asSchemaFromLinks().getAsNormalizedFullLink().schema ??
      requestLink.schema;
  const readTx = runtime.edit();
  const labelsByPath = normalizePersistedPathLabels(
    readTx.readOrThrow(cfcLabelsAddress(requestLink)),
  );
  await readTx.abort();

  const rules: FetchSinkRule[] = [];
  collectFetchSinkRules(requestSchema, rules);

  return {
    requestLink,
    requestSchema,
    labelsByPath,
    aggregate: aggregateRequestLabels(labelsByPath),
    rules,
  };
}

function rewriteClassificationForPath(
  path: string,
  classification: Labels["classification"],
  labelsByPath: PersistedPathLabels,
  rules: readonly FetchSinkRule[],
  extraIntegrity: readonly CfcAtom[] | undefined,
): Labels["classification"] {
  let nextClassification = classification;
  for (const rule of rules) {
    if (!rule.allowedPaths.includes(path)) {
      continue;
    }
    if (!ruleMatchesAtAllowedPath(labelsByPath, rule, extraIntegrity)) {
      continue;
    }
    nextClassification = applyRuleToClassification(nextClassification, rule);
  }
  return nextClassification;
}

export async function authorizeFetchSinkRequest(
  runtime: Runtime,
  inputsCell: Cell<unknown>,
  options: DeriveFetchSinkResultLabelsOptions = {},
): Promise<boolean> {
  const context = await loadFetchSinkRequestContext(runtime, inputsCell);
  if (!context.aggregate && !labelsPresent(context.labelsByPath)) {
    return true;
  }

  const actingPrincipal = options.actingPrincipal ?? runtime.userIdentityDID;
  for (const path of Object.keys(context.labelsByPath)) {
    const effective = effectiveLabelForPath(context.labelsByPath, path);
    const rewrittenClassification = rewriteClassificationForPath(
      path,
      effective?.classification,
      context.labelsByPath,
      context.rules,
      options.additionalRequestIntegrity,
    );
    if (
      !authorizationSatisfiedAfterSinkRewrite(
        rewrittenClassification,
        actingPrincipal,
      )
    ) {
      return false;
    }
  }

  return true;
}

export async function deriveFetchSinkResultLabels(
  runtime: Runtime,
  inputsCell: Cell<unknown>,
  inputs: NormalizedFetchDataInputs,
  options: DeriveFetchSinkResultLabelsOptions = {},
): Promise<Labels | undefined> {
  const context = await loadFetchSinkRequestContext(runtime, inputsCell);
  if (!context.aggregate && !labelsPresent(context.labelsByPath)) {
    return undefined;
  }

  let classification = context.aggregate?.classification;
  const integrity = joinExtraIntegrity(
    context.aggregate?.integrity,
    options.additionalRequestIntegrity,
  );

  let sinkRuleFired = false;
  for (const rule of context.rules) {
    if (
      !ruleMatchesAtAllowedPath(
        context.labelsByPath,
        rule,
        options.additionalRequestIntegrity,
      )
    ) {
      continue;
    }
    sinkRuleFired = true;
    classification = applyRuleToClassification(classification, rule);
  }

  const semantics = deriveCfcFetchRequestSemantics(inputs, {
    endpoint: options.endpoint,
  });
  const requestDigest = semantics
    ? computeCfcFetchRequestDigest(semantics)
    : undefined;
  let nextIntegrity = integrity;

  if (sinkRuleFired) {
    nextIntegrity = joinIntegrityLabels(nextIntegrity, [
      {
        type: AUTHORIZED_REQUEST_ATOM,
        policy: "fetchData-sink-gate",
        user: options.actingPrincipal ?? runtime.userIdentityDID,
        endpoint: semantics?.endpoint ?? options.endpoint ?? "fetchData",
        ...(requestDigest ? { requestDigest } : {}),
        codeHash: FETCH_BUILTIN_IDENTITY,
      },
    ]);
  }

  if ((context.aggregate || sinkRuleFired) && inputs.url) {
    const url = new URL(inputs.url);
    nextIntegrity = joinIntegrityLabels(nextIntegrity, [
      {
        type: NETWORK_PROVENANCE_ATOM,
        host: url.host,
        tls: url.protocol === "https:",
        ...(requestDigest ? { requestDigest } : {}),
        codeHash: FETCH_BUILTIN_IDENTITY,
      },
    ]);
  }

  if (!classification && !nextIntegrity) {
    return undefined;
  }

  return {
    ...(classification ? { classification } : {}),
    ...(nextIntegrity ? { integrity: nextIntegrity } : {}),
  };
}

export function writeFetchResultLabels(
  tx: IExtendedStorageTransaction,
  resultCell: Cell<unknown>,
  labels: Labels | undefined,
  path: string = "/",
): void {
  if (!labels) {
    return;
  }

  const resultLink = resultCell.getAsNormalizedFullLink();
  const existing = normalizePersistedPathLabels(
    tx.readOrThrow(cfcLabelsAddress(resultLink)),
  );
  const existingRoot = rootWriteLabel(existing, path);
  const mergedClassification = joinConfidentialityLabels(
    existingRoot?.classification,
    labels.classification,
  );
  const mergedIntegrity = joinIntegrityLabels(
    existingRoot?.integrity,
    labels.integrity,
  );
  const mergedRoot: Labels = {
    ...(mergedClassification
      ? {
        classification: mergedClassification,
      }
      : {}),
    ...(mergedIntegrity
      ? {
        integrity: mergedIntegrity,
      }
      : {}),
  };

  if (mergedRoot.classification || mergedRoot.integrity) {
    tx.writeOrThrow(
      cfcLabelsAddress(resultLink),
      toStorableLabelMap(
        withPathValueLabel(existing, path, mergedRoot),
      ) as unknown as never,
    );
  }
}
