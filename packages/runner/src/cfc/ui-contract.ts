import { isRecord } from "@commonfabric/utils/types";
import type { CellScope, JSONSchema } from "../builder/types.ts";
import {
  findAndInlineDataURILinks,
  type NormalizedFullLink,
  parseLink,
} from "../link-utils.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { getJSONFromDataURI } from "../uri-utils.ts";
import { ContextualFlowControl } from "../cfc.ts";
import type { CfcAddress } from "./types.ts";
import { isNormalizedFullLink } from "../link-types.ts";

type UiContractTrustRequirements = {
  trustedPattern?: string;
  requiredEventIntegrity?: readonly string[];
};

type UiActionContract = UiContractTrustRequirements & {
  helper: "UiAction";
  action: string;
};

type UiPromptSlotContract = UiContractTrustRequirements & {
  helper: "UiPromptSlot";
  surface: string;
  role?: string;
};

type UiDisclosureContract = UiContractTrustRequirements & {
  helper: "UiDisclosure";
  kind: string;
};

export type UiContract =
  | UiActionContract
  | UiPromptSlotContract
  | UiDisclosureContract;

export type UiContractEntry = {
  path: string[];
  contract: UiContract;
  schema?: JSONSchema;
};

const uiContractEntry = (
  path: string[],
  contract: UiContract,
  schema?: JSONSchema,
): UiContractEntry => {
  const entry: UiContractEntry = { path, contract };
  if (schema !== undefined) {
    Object.defineProperty(entry, "schema", {
      value: schema,
      enumerable: false,
    });
  }
  return entry;
};

type SerializedTrustedEvent = {
  type?: string;
  provenance?: {
    origin?: string;
    trusted?: boolean;
    ui?: {
      pattern?: string;
      eventIntegrity?: unknown;
      uiContractDataset?: unknown;
    };
  };
};

type TrustedEventPolicyTx = Pick<
  IExtendedStorageTransaction,
  "getCfcState" | "recordCfcWritePolicyInput"
>;

type AddressLike = {
  space: string;
  id: string;
  scope: CellScope;
  path: readonly unknown[];
};

type TrustedDomProvenance = {
  origin: "dom";
  trusted: true;
  ui?: {
    pattern?: unknown;
    eventIntegrity?: unknown;
    uiContractDataset?: unknown;
  };
};

const rendererTrustedEvents = new WeakSet<object>();

const isTrustedDomProvenance = (
  provenance: unknown,
): provenance is TrustedDomProvenance =>
  isRecord(provenance) &&
  provenance.origin === "dom" &&
  provenance.trusted === true;

export const markRendererTrustedEvent = (event: unknown): void => {
  if (isRecord(event)) {
    rendererTrustedEvents.add(event);
  }
};

export const propagateRendererTrustedEvent = (
  source: unknown,
  target: unknown,
): void => {
  if (
    isRecord(source) &&
    rendererTrustedEvents.has(source) &&
    isRecord(target)
  ) {
    rendererTrustedEvents.add(target);
  }
};

const isRendererTrustedEvent = (event: unknown): boolean =>
  isRecord(event) && rendererTrustedEvents.has(event);

const trustRequirementsFromContract = (
  contract: Record<string, unknown>,
): UiContractTrustRequirements | undefined => {
  const trustedPattern = typeof contract.trustedPattern === "string"
    ? contract.trustedPattern
    : undefined;
  const requiredEventIntegrity = Array.isArray(contract.requiredEventIntegrity)
    ? contract.requiredEventIntegrity.filter((label): label is string =>
      typeof label === "string"
    )
    : undefined;

  return {
    ...(trustedPattern ? { trustedPattern } : {}),
    ...(requiredEventIntegrity && requiredEventIntegrity.length > 0
      ? { requiredEventIntegrity }
      : {}),
  };
};

const resolveLocalSchemaRef = (
  schema: JSONSchema | undefined,
  root: JSONSchema | undefined,
  seenRefs: Set<string>,
): JSONSchema | undefined => {
  if (!isRecord(schema) || typeof schema.$ref !== "string") {
    return schema;
  }
  const ref = schema.$ref;
  if (!ref.startsWith("#/") || seenRefs.has(ref)) {
    return schema;
  }
  seenRefs.add(ref);

  if (!isRecord(root)) {
    return schema;
  }

  return ContextualFlowControl.resolveSchemaRefs(schema, root) ?? schema;
};

const uiContractFromSchemaInternal = (
  schema: JSONSchema | undefined,
  root: JSONSchema | undefined,
  seenRefs: Set<string>,
): UiContract | undefined => {
  const resolvedSchema = resolveLocalSchemaRef(schema, root, seenRefs);
  if (resolvedSchema !== schema) {
    return uiContractFromSchemaInternal(resolvedSchema, root, seenRefs);
  }
  if (
    !isRecord(resolvedSchema) || !isRecord(resolvedSchema.ifc) ||
    !isRecord(resolvedSchema.ifc.uiContract)
  ) {
    return undefined;
  }
  const contract = resolvedSchema.ifc.uiContract;
  const trustRequirements = trustRequirementsFromContract(contract);
  switch (contract.helper) {
    case "UiAction":
      return typeof contract.action === "string"
        ? { helper: "UiAction", action: contract.action, ...trustRequirements }
        : undefined;
    case "UiPromptSlot":
      return typeof contract.surface === "string"
        ? {
          helper: "UiPromptSlot",
          surface: contract.surface,
          ...(typeof contract.role === "string" ? { role: contract.role } : {}),
          ...trustRequirements,
        }
        : undefined;
    case "UiDisclosure":
      return typeof contract.kind === "string"
        ? { helper: "UiDisclosure", kind: contract.kind, ...trustRequirements }
        : undefined;
    default:
      return undefined;
  }
};

export const uiContractFromSchema = (
  schema: JSONSchema | undefined,
): UiContract | undefined =>
  uiContractFromSchemaInternal(schema, schema, new Set());

const uiContractsFromSchemaInternal = (
  schema: JSONSchema | undefined,
  root: JSONSchema | undefined,
  path: string[],
  seenRefs: Set<string>,
): UiContractEntry[] => {
  const branchRefs = new Set(seenRefs);
  const resolvedSchema = resolveLocalSchemaRef(schema, root, branchRefs);
  if (resolvedSchema !== schema) {
    return uiContractsFromSchemaInternal(
      resolvedSchema,
      root,
      path,
      branchRefs,
    );
  }
  if (!isRecord(resolvedSchema)) {
    return [];
  }

  const childRoot = isRecord(resolvedSchema.$defs) ? resolvedSchema : root;
  const entries: UiContractEntry[] = [];
  const contract = uiContractFromSchemaInternal(
    resolvedSchema,
    childRoot,
    new Set(),
  );
  if (contract !== undefined) {
    entries.push(uiContractEntry([...path], contract, resolvedSchema));
  }

  const hasProperties = isRecord(resolvedSchema.properties);
  const hasCompoundSchemas = Array.isArray(resolvedSchema.anyOf) ||
    Array.isArray(resolvedSchema.oneOf) ||
    Array.isArray(resolvedSchema.allOf);
  const hasItems = isRecord(resolvedSchema.items) ||
    typeof resolvedSchema.items === "boolean";
  if (
    contract === undefined &&
    !hasProperties &&
    !hasCompoundSchemas &&
    !hasItems &&
    resolvedSchema.type === "unknown" &&
    isRecord(resolvedSchema.$defs)
  ) {
    const definitionContracts = Object.values(resolvedSchema.$defs)
      .flatMap((definition) =>
        uiContractsFromSchemaInternal(
          definition as JSONSchema,
          definition as JSONSchema,
          [],
          new Set(),
        )
      )
      .map((entry) => entry.contract);
    if (definitionContracts.length === 1) {
      entries.push(uiContractEntry([...path], definitionContracts[0]));
    }
  }

  if (hasProperties) {
    for (const [key, child] of Object.entries(resolvedSchema.properties)) {
      entries.push(
        ...uiContractsFromSchemaInternal(
          child as JSONSchema,
          childRoot,
          [...path, key],
          seenRefs,
        ),
      );
    }
  }

  const compound = [
    ...(Array.isArray(resolvedSchema.anyOf) ? resolvedSchema.anyOf : []),
    ...(Array.isArray(resolvedSchema.oneOf) ? resolvedSchema.oneOf : []),
    ...(Array.isArray(resolvedSchema.allOf) ? resolvedSchema.allOf : []),
  ];
  for (const child of compound) {
    entries.push(
      ...uiContractsFromSchemaInternal(
        child as JSONSchema,
        childRoot,
        path,
        seenRefs,
      ),
    );
  }

  if (
    isRecord(resolvedSchema.items) || typeof resolvedSchema.items === "boolean"
  ) {
    entries.push(
      ...uiContractsFromSchemaInternal(
        resolvedSchema.items as JSONSchema,
        childRoot,
        [...path, "*"],
        seenRefs,
      ),
    );
  }

  return entries;
};

export const uiContractsFromSchema = (
  schema: JSONSchema | undefined,
): UiContractEntry[] =>
  uiContractsFromSchemaInternal(schema, schema, [], new Set());

export const trustedEventProvenanceMatchesUiContract = (
  provenance: unknown,
  contract: UiContract | undefined,
): boolean => {
  if (contract === undefined || !isTrustedDomProvenance(provenance)) {
    return false;
  }
  if (
    contract.trustedPattern !== undefined ||
    (contract.requiredEventIntegrity?.length ?? 0) > 0
  ) {
    if (!isRecord(provenance.ui)) {
      return false;
    }
    if (
      contract.trustedPattern !== undefined &&
      provenance.ui.pattern !== contract.trustedPattern
    ) {
      return false;
    }
    if ((contract.requiredEventIntegrity?.length ?? 0) > 0) {
      const labels = provenance.ui.eventIntegrity;
      if (!Array.isArray(labels)) {
        return false;
      }
      const presentLabels = new Set(
        labels.filter((label): label is string => typeof label === "string"),
      );
      if (
        contract.requiredEventIntegrity?.some((label) =>
          !presentLabels.has(label)
        )
      ) {
        return false;
      }
    }
  }
  return true;
};

export const recordedTrustedEventProvenanceMatchesUiContract = (
  provenance: unknown,
  contract: UiContract | undefined,
): boolean => {
  if (!trustedEventProvenanceMatchesUiContract(provenance, contract)) {
    return false;
  }
  const dataset = isRecord(provenance) && isRecord(provenance.ui)
    ? provenance.ui.uiContractDataset
    : undefined;
  if (!isRecord(dataset)) {
    return false;
  }

  switch (contract?.helper) {
    case "UiAction":
      return dataset.uiAction === contract.action;
    case "UiPromptSlot":
      return dataset.uiSurface === contract.surface &&
        (contract.role === undefined || dataset.uiRole === contract.role);
    case "UiDisclosure":
      return dataset.uiDisclosureKind === contract.kind;
    default:
      return false;
  }
};

export const trustedEventMatchesUiContract = (
  event: unknown,
  contract: UiContract | undefined,
): boolean => {
  if (contract === undefined || !isRecord(event)) {
    return false;
  }
  const serializedEvent = event as SerializedTrustedEvent;
  if (!isRendererTrustedEvent(event)) {
    return false;
  }
  return recordedTrustedEventProvenanceMatchesUiContract(
    serializedEvent.provenance,
    contract,
  );
};

const trustedEventMatchCandidates = (event: unknown): unknown[] => {
  const candidates: unknown[] = [];
  const sourceIsRendererTrusted = isRendererTrustedEvent(event);
  const add = (candidate: unknown) => {
    if (candidate !== undefined && !candidates.includes(candidate)) {
      if (sourceIsRendererTrusted) {
        markRendererTrustedEvent(candidate);
      }
      candidates.push(candidate);
    }
  };

  add(event);
  try {
    add(findAndInlineDataURILinks(event));
  } catch {
    // Invalid data URI links cannot establish trusted provenance.
  }

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (!isRecord(candidate)) {
      continue;
    }
    if ("$event" in candidate) {
      add(candidate.$event);
    }
    if (isRecord(candidate.value) && "$event" in candidate.value) {
      add(candidate.value.$event);
    }
  }

  return candidates;
};

const pathsEqual = (
  left: readonly unknown[],
  right: readonly unknown[],
): boolean =>
  left.length === right.length &&
  left.every((segment, index) => String(segment) === String(right[index]));

export const pathPatternMatches = (
  pattern: readonly unknown[],
  path: readonly unknown[],
): boolean =>
  pattern.length === path.length &&
  pattern.every((segment, index) =>
    String(segment) === "*" || String(segment) === String(path[index])
  );

const pathHasPrefix = (
  path: readonly unknown[],
  prefix: readonly unknown[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => String(segment) === String(path[index]));

const targetMatchesWrite = (
  target: CfcAddress,
  write: AddressLike,
): boolean =>
  target.space === write.space &&
  target.id === write.id &&
  target.scope === write.scope &&
  pathsEqual(target.path, write.path);

const sameDocument = (
  target: CfcAddress,
  write: AddressLike,
): boolean =>
  target.space === write.space &&
  target.id === write.id &&
  target.scope === write.scope;

const contractCandidatesForWrite = (
  tx: TrustedEventPolicyTx,
  write: NormalizedFullLink,
): UiContract[] => {
  const contracts: UiContract[] = [];
  if (write.schema !== undefined) {
    for (const entry of uiContractsFromSchema(write.schema)) {
      if (
        pathsEqual(entry.path, []) || pathPatternMatches(entry.path, write.path)
      ) {
        contracts.push(entry.contract);
      }
    }
  }
  for (const input of tx.getCfcState().writePolicyInputs) {
    if (
      input.kind === "schema" &&
      input.schema !== undefined &&
      sameDocument(input.target, write) &&
      pathHasPrefix(write.path, input.target.path)
    ) {
      for (const entry of uiContractsFromSchema(input.schema)) {
        if (
          pathPatternMatches([...input.target.path, ...entry.path], write.path)
        ) {
          contracts.push(entry.contract);
        }
      }
    }
  }
  return contracts;
};

const eventEnvelopePayloads = (
  event: unknown,
): Array<{ value: unknown; space?: string }> => {
  const payloads: Array<{ value: unknown; space?: string }> = [];
  const addPayload = (value: unknown, space?: string) => {
    if (
      !payloads.some((payload) =>
        payload.value === value && payload.space === space
      )
    ) {
      payloads.push({ value, ...(space !== undefined ? { space } : {}) });
    }
  };

  addPayload(event);
  if (isRecord(event) && "value" in event) {
    addPayload(event.value);
  }
  try {
    const eventLink = parseLink(event);
    if (eventLink?.id?.startsWith("data:application/json")) {
      const decoded = getJSONFromDataURI(eventLink.id);
      addPayload(decoded, eventLink.space);
      if (isRecord(decoded) && "value" in decoded) {
        addPayload(decoded.value, eventLink.space);
      }
    }
  } catch {
    // Invalid data URI links cannot provide authoring context.
  }

  return payloads;
};

// Helper for the (dormant — see `contractCandidatesFromEventContext`) `$ctx`
// path. Binding lowers handler context props one level at a time but preserves
// the surrounding object/array structure (see `unwrapOneLevelAndBindtoDoc`), so a
// contract-bearing link can sit nested inside a `$ctx` entry (e.g.
// `myHandler({ config: { savedTitle: state.x } })`) rather than at its top
// level. Walk plain objects/arrays to collect every reachable bound link. A
// link (sigil or legacy alias) is always a leaf: never descend into its
// envelope, even when it is rejected below — its internals are not addressable
// `$ctx` links. Only an absolute (full) link contributes a candidate; parse
// WITHOUT a base so a relative link stays relative and fails the full-link
// check, rather than inheriting the write target's id/space/scope (which would
// make the same-document guard vacuous).
const collectContextLinks = (
  value: unknown,
  seen: Set<unknown>,
  depth: number,
  out: NormalizedFullLink[],
): void => {
  if (depth > 16) {
    return;
  }
  const parsedLink = parseLink(value);
  if (parsedLink !== undefined) {
    if (isNormalizedFullLink(parsedLink)) {
      out.push(parsedLink);
    }
    return;
  }
  if (!isRecord(value) && !Array.isArray(value)) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectContextLinks(child, seen, depth + 1, out);
  }
};

// DORMANT / forward-looking: no production caller currently reaches this.
// `recordTrustedEventPolicyInputs` is invoked with the bare sent event value
// (the handler's `$event`), never the `{ $ctx, $event }` argument envelope — the
// handler's `$ctx` is read separately by the action (see `runner.ts`, the
// `$ctx`/`$event` split in `invokeJavaScriptImplementation`) and is never handed
// to enforcement. So `payload.value.$ctx` is empty on every live path, and this
// function returns no contracts in production; it is exercised only by unit
// tests that hand-build a context envelope. It is kept as scaffolding for a
// future path that would feed the argument envelope here (which would let a
// contract be discovered via a contract-bearing `$ctx` link rather than only via
// the write's own schema). Until such a caller exists, a UI contract reachable
// ONLY through `$ctx` is NOT enforced at runtime.
//
// The shape it assumes: a `$ctx` link that addresses the write target carries
// the schema (and thus any uiContract) for that write. At handler-execution time
// these would be bound sigil links that already address an absolute document, so
// a link only contributes a contract when it points into the same document as
// `write`.
const contractCandidatesFromEventContext = (
  event: unknown,
  write: NormalizedFullLink,
): UiContract[] => {
  const contracts: UiContract[] = [];
  for (const payload of eventEnvelopePayloads(event)) {
    if (!isRecord(payload.value) || !isRecord(payload.value.$ctx)) {
      continue;
    }
    const links: NormalizedFullLink[] = [];
    collectContextLinks(payload.value.$ctx, new Set(), 0, links);
    for (const link of links) {
      if (
        link.id !== write.id ||
        link.space !== write.space ||
        (link.scope ?? "space") !== (write.scope ?? "space") ||
        !pathHasPrefix(write.path, link.path)
      ) {
        continue;
      }
      for (const entry of uiContractsFromSchema(link.schema)) {
        if (pathPatternMatches([...link.path, ...entry.path], write.path)) {
          contracts.push(entry.contract);
        }
      }
    }
  }
  return contracts;
};

const trustedEventPolicyInputAlreadyRecorded = (
  tx: TrustedEventPolicyTx,
  target: CfcAddress,
  eventId: string,
): boolean =>
  tx.getCfcState().writePolicyInputs.some((input) =>
    input.kind === "trusted-event" &&
    input.eventId === eventId &&
    targetMatchesWrite(input.target, target)
  );

const trustedEventId = (
  event: unknown,
  write: NormalizedFullLink,
): string =>
  `trusted-event:${
    String((event as { type?: string }).type ?? "event")
  }:${write.id}:${write.path.join("/")}`;

export const recordTrustedEventPolicyInputs = (
  tx: TrustedEventPolicyTx,
  writes: readonly NormalizedFullLink[],
  event: unknown,
): void => {
  for (const write of writes) {
    const contracts = [
      ...contractCandidatesForWrite(tx, write),
      ...contractCandidatesFromEventContext(event, write),
    ];
    for (const contract of contracts) {
      const matchingEvent = trustedEventMatchCandidates(event).find(
        (candidate) => trustedEventMatchesUiContract(candidate, contract),
      );
      if (matchingEvent === undefined) {
        continue;
      }
      const target = {
        space: write.space,
        id: write.id,
        scope: write.scope,
        path: [...write.path],
      };
      const eventId = trustedEventId(matchingEvent, write);
      if (trustedEventPolicyInputAlreadyRecorded(tx, target, eventId)) {
        break;
      }
      tx.recordCfcWritePolicyInput({
        kind: "trusted-event",
        target,
        eventId,
        provenance: (matchingEvent as SerializedTrustedEvent).provenance,
      });
      break;
    }
  }
};
