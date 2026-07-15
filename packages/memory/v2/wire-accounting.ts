import type { ClientMessage, ServerMessage } from "../v2.ts";
import { sha256 } from "@commonfabric/content-hash";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";

export type MemoryWireDirection = "inbound" | "outbound";

export interface MemoryWireConnectionMetadata {
  kind?: string;
  [key: string]: unknown;
}

export interface MemoryWireAccountingRecord {
  direction: MemoryWireDirection;
  connectionId: string;
  metadata?: MemoryWireConnectionMetadata;
  classification: string;
  baselineBytes: number;
  actualBytes: number;
  baselineSemanticBytes?: MemoryWireSemanticBytes;
  actualSemanticBytes?: MemoryWireSemanticBytes;
  baselineCandidates?: MemoryWireCandidate[];
  actualCandidates?: MemoryWireCandidate[];
}

export type MemoryWireSemanticCategory =
  | "encoding"
  | "identity"
  | "sequence"
  | "sessionControl"
  | "authCapability"
  | "schema"
  | "documentValue"
  | "patchOperation"
  | "queryWatch"
  | "sqliteScheduler"
  | "error"
  | "uncategorized";

export type MemoryWireSemanticBytes = Record<
  MemoryWireSemanticCategory,
  number
>;

export type MemoryWireCandidateScope =
  | "alreadyContentAddressed"
  | "immutableInternable"
  | "identityInternable"
  | "seqAddressedRepeatMeasurable"
  | "contextualControl";

export interface MemoryWireCandidate {
  category: MemoryWireSemanticCategory;
  scope: MemoryWireCandidateScope;
  fingerprint: string;
  encodedBytes: number;
}

export interface MemoryWireAccountingObserver {
  isActive?(): boolean;
  accountPayload?(payload: string, partitionKey: string): {
    semanticBytes: MemoryWireSemanticBytes;
    candidates: MemoryWireCandidate[];
  };
  observe(record: MemoryWireAccountingRecord): void;
}

export interface MemoryWireAccountingTotals {
  baselineBytes: number;
  actualBytes: number;
  frames: number;
  connections: number;
}

export interface MemoryWireAccountingRow extends MemoryWireAccountingTotals {
  key: string;
}

export interface MemoryWireAccountingReport {
  totals: MemoryWireAccountingTotals;
  byDirection: MemoryWireAccountingRow[];
  byConnection: MemoryWireAccountingRow[];
  byMetadataKind: MemoryWireAccountingRow[];
  byClassification: MemoryWireAccountingRow[];
  records: MemoryWireAccountingRecord[];
  truncated?: { reason: string };
}

export type MemoryWireAccountingLimits = {
  maxPayloadBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxCandidates: number;
  maxRecords: number;
  maxRetainedActualBytes: number;
  maxRetainedCandidates: number;
};

const defaultLimits: MemoryWireAccountingLimits = {
  maxPayloadBytes: 1_000_000,
  maxDepth: 64,
  maxNodes: 100_000,
  maxCandidates: 10_000,
  maxRecords: 10_000,
  maxRetainedActualBytes: 50_000_000,
  maxRetainedCandidates: 100_000,
};

type MutableTotals = {
  baselineBytes: number;
  actualBytes: number;
  frames: number;
  connections: Set<string>;
};

const textEncoder = new TextEncoder();
const wirePrefix = "fvj1:";
const semanticCategories: MemoryWireSemanticCategory[] = [
  "encoding",
  "identity",
  "sequence",
  "sessionControl",
  "authCapability",
  "schema",
  "documentValue",
  "patchOperation",
  "queryWatch",
  "sqliteScheduler",
  "error",
  "uncategorized",
];

export const memoryWireUtf8Bytes = (payload: string): number =>
  textEncoder.encode(payload).byteLength;

export const emptyMemoryWireSemanticBytes = (): MemoryWireSemanticBytes =>
  Object.fromEntries(
    semanticCategories.map((category) => [category, 0]),
  ) as MemoryWireSemanticBytes;

/**
 * Accounts the exact encoded boundary representation. It intentionally parses
 * only valid fvj1 JSON; malformed inbound payloads stay opaque encoding data.
 */
export const accountMemoryWirePayload = (
  payload: string,
  runSalt: string,
  partitionKey = "default",
  limits: Pick<
    MemoryWireAccountingLimits,
    "maxPayloadBytes" | "maxDepth" | "maxNodes" | "maxCandidates"
  > = defaultLimits,
): {
  semanticBytes: MemoryWireSemanticBytes;
  candidates: MemoryWireCandidate[];
} => {
  const semanticBytes = emptyMemoryWireSemanticBytes();
  if (
    !payload.startsWith(wirePrefix) ||
    memoryWireUtf8Bytes(payload) > limits.maxPayloadBytes
  ) {
    semanticBytes.encoding = memoryWireUtf8Bytes(payload);
    return { semanticBytes, candidates: [] };
  }

  try {
    const value = JSON.parse(payload.slice(wirePrefix.length));
    if (`${wirePrefix}${JSON.stringify(value)}` !== payload) {
      throw new Error("noncanonical memory wire payload");
    }
    semanticBytes.encoding = memoryWireUtf8Bytes(wirePrefix);
    const candidates: MemoryWireCandidate[] = [];
    accountEncodedJson(
      value,
      [],
      semanticBytes,
      candidates,
      runSalt,
      partitionKey,
      {
        nodes: 0,
        limits,
      },
    );
    return { semanticBytes, candidates };
  } catch {
    const opaque = emptyMemoryWireSemanticBytes();
    opaque.encoding = memoryWireUtf8Bytes(payload);
    return { semanticBytes: opaque, candidates: [] };
  }
};

type WalkState = {
  nodes: number;
  limits: Pick<
    MemoryWireAccountingLimits,
    "maxDepth" | "maxNodes" | "maxCandidates"
  >;
};

const accountEncodedJson = (
  value: unknown,
  path: readonly string[],
  totals: MemoryWireSemanticBytes,
  candidates: MemoryWireCandidate[],
  runSalt: string,
  partitionKey: string,
  state: WalkState,
): void => {
  if (
    ++state.nodes > state.limits.maxNodes || path.length > state.limits.maxDepth
  ) {
    throw new Error("wire accounting limit exceeded");
  }
  const category = semanticCategory(path);
  const candidatesAtEntry = candidates.length;
  if (Array.isArray(value)) {
    totals[category] += 2;
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) totals[category] += 1;
      accountEncodedJson(
        value[index],
        [...path, "[]"],
        totals,
        candidates,
        runSalt,
        partitionKey,
        state,
      );
    }
    if (candidates.length === candidatesAtEntry) {
      addCandidate(value, path, candidates, runSalt, partitionKey, state);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    totals[category] += 2;
    for (let index = 0; index < entries.length; index += 1) {
      const [key, child] = entries[index];
      if (index > 0) totals[category] += 1;
      totals[semanticCategory([...path, key])] +=
        memoryWireUtf8Bytes(JSON.stringify(key)) + 1;
      accountEncodedJson(
        child,
        [...path, key],
        totals,
        candidates,
        runSalt,
        partitionKey,
        state,
      );
    }
    if (candidates.length === candidatesAtEntry) {
      addCandidate(value, path, candidates, runSalt, partitionKey, state);
    }
    return;
  }
  totals[category] += memoryWireUtf8Bytes(JSON.stringify(value));
  if (candidates.length === candidatesAtEntry) {
    addCandidate(value, path, candidates, runSalt, partitionKey, state);
  }
};

const semanticCategory = (
  path: readonly string[],
): MemoryWireSemanticCategory => {
  if (path.length === 0) return "encoding";
  const key = path.at(-1) ?? "";
  const joined = path.join(".");
  if (isInsideProtocolSchema(path)) return "schema";
  if (isDocumentPath(path)) return "documentValue";
  if (isInsideAuthCapability(path)) return "authCapability";
  if (path.includes("flags")) return "sessionControl";
  if (joined.includes("error") || key === "message") return "error";
  if (
    /authorization|invocation|signature|challenge|sessionToken|capability/i
      .test(key)
  ) return "authCapability";
  if (/^(seq|fromSeq|toSeq|localSeq|opIndex|serverSeq|seenSeq)$/i.test(key)) {
    return "sequence";
  }
  if (
    /^(space|branch|scope|id|sessionId|aud|iss|sub|sourceBranch|baseBranch)$/i
      .test(key)
  ) {
    return "identity";
  }
  if (/session|flags|protocol|type|requestId/i.test(key)) {
    return "sessionControl";
  }
  if (/sqlite|scheduler|table|columns|params|sql/i.test(joined)) {
    return "sqliteScheduler";
  }
  if (/watches|watch|query|selector|roots|graph/i.test(joined)) {
    return "queryWatch";
  }
  if (/operations|patches|commit|revisions/i.test(joined)) {
    return "patchOperation";
  }
  return "uncategorized";
};

const isDocumentPath = (path: readonly string[]): boolean => {
  const documentIndex = path.findIndex((part) =>
    part === "doc" || part === "document"
  );
  if (documentIndex >= 0) return true;
  const valueIndex = path.lastIndexOf("value");
  return valueIndex >= 0 && path.slice(0, valueIndex).includes("operations");
};

const isInsideProtocolSchema = (path: readonly string[]): boolean =>
  protocolSchemaRootIndex(path) !== -1;

const isProtocolSchemaRoot = (path: readonly string[]): boolean =>
  protocolSchemaRootIndex(path) === path.length - 1;

const protocolSchemaRootIndex = (path: readonly string[]): number => {
  for (const root of [["/", "link@1", "schema"], ["$alias", "schema"]]) {
    const index = suffixRootIndex(path, root);
    if (index !== -1) return index;
  }
  const selectorIndex = protocolSelectorRootIndex(path, true);
  if (selectorIndex !== -1) return selectorIndex;
  const tableIndex = path.lastIndexOf("schemaTable");
  if (
    tableIndex >= 1 && isProtocolSchemaTablePath(path, tableIndex) &&
    path.length >= tableIndex + 2
  ) return tableIndex + 1;
  const definitionsIndex = path.lastIndexOf("schemaDefinitions");
  if (definitionsIndex === 0 && path.length >= 2) return 1;
  return -1;
};

const isProtocolSchemaTablePath = (
  path: readonly string[],
  tableIndex: number,
): boolean => {
  if (isDocumentPath(path)) return false;
  const prefix = path.slice(0, tableIndex);
  return pathsEqual(prefix, ["ok", "sync"]) || pathsEqual(prefix, ["effect"]);
};

const protocolSelectorRootIndex = (
  path: readonly string[],
  includeSchema: boolean,
): number => {
  if (isDocumentPath(path)) return -1;
  const root = [
    "query",
    "roots",
    "[]",
    "selector",
    ...(includeSchema ? ["schema"] : []),
  ];
  for (let index = 0; index <= path.length - root.length; index += 1) {
    if (!root.every((part, offset) => path[index + offset] === part)) continue;
    const prefix = path.slice(0, index);
    if (prefix.length === 0 || pathsEqual(prefix, ["watches", "[]"])) {
      return index + root.length - 1;
    }
  }
  return -1;
};

const pathsEqual = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((part, index) => part === right[index]);

const suffixRootIndex = (
  path: readonly string[],
  root: readonly string[],
): number => {
  for (let index = 0; index <= path.length - root.length; index += 1) {
    if (root.every((part, offset) => path[index + offset] === part)) {
      return index + root.length - 1;
    }
  }
  return -1;
};

const isInsideAuthCapability = (path: readonly string[]): boolean =>
  path.includes("invocation") || path.includes("authorization") ||
  path.includes("sessionOpen") || path.includes("challenge");

const addCandidate = (
  value: unknown,
  path: readonly string[],
  candidates: MemoryWireCandidate[],
  runSalt: string,
  partitionKey: string,
  state: WalkState,
): void => {
  const category = semanticCategory(path);
  const scope = candidateScope(category, path, value);
  if (scope === undefined) return;
  const encoded = JSON.stringify(value);
  if (candidates.length >= state.limits.maxCandidates) {
    throw new Error("wire accounting candidate limit exceeded");
  }
  candidates.push({
    category,
    scope,
    fingerprint: toUnpaddedBase64url(
      sha256(
        textEncoder.encode(`${runSalt}\u0000${partitionKey}\u0000${encoded}`),
      ),
    ),
    encodedBytes: memoryWireUtf8Bytes(encoded),
  });
};

const candidateScope = (
  category: MemoryWireSemanticCategory,
  path: readonly string[],
  value: unknown,
): MemoryWireCandidateScope | undefined => {
  if (category === "identity" && isProtocolIdentityScalar(path, value)) {
    return "identityInternable";
  }
  if (isDirectCommitCodeCID(path)) return "alreadyContentAddressed";
  if (category === "schema" && isProtocolSchemaRoot(path)) {
    if (
      isDirectSchemaTableValue(path) ||
      isDirectRequestSchemaDefinition(path)
    ) return "alreadyContentAddressed";
    if (
      typeof value === "string" &&
      (value.startsWith("schema-ref@2:") ||
        value.startsWith("schema-cas@1:")) &&
      (endsWithPath(path, ["/", "link@1", "schema"]) ||
        endsWithPath(path, ["$alias", "schema"]) ||
        protocolSelectorRootIndex(path, true) === path.length - 1)
    ) return "alreadyContentAddressed";
    return "immutableInternable";
  }
  if (category === "documentValue" && isDocumentCandidateRoot(path)) {
    return "seqAddressedRepeatMeasurable";
  }
  if (
    category === "patchOperation" &&
    isDirectPatchCandidateRoot(path)
  ) {
    return "seqAddressedRepeatMeasurable";
  }
  if (
    category === "queryWatch" &&
    protocolSelectorRootIndex(path, false) === path.length - 1
  ) {
    return "immutableInternable";
  }
  if (
    category === "sqliteScheduler" && isDirectDbTables(path)
  ) {
    return "immutableInternable";
  }
  return undefined;
};

const endsWithPath = (
  path: readonly string[],
  suffix: readonly string[],
): boolean =>
  suffix.length <= path.length &&
  suffix.every((part, index) =>
    path[path.length - suffix.length + index] === part
  );

const isDocumentCandidateRoot = (path: readonly string[]): boolean =>
  endsWithPath(path, ["upserts", "[]", "doc", "value"]) ||
  endsWithPath(path, ["entities", "[]", "document", "value"]) ||
  endsWithPath(path, ["revisions", "[]", "document", "value"]) ||
  (endsWithPath(path, ["commit", "operations", "[]", "value"]) &&
    !path.includes("doc") && !path.includes("document"));

const isDirectPatchCandidateRoot = (path: readonly string[]): boolean =>
  (endsWithPath(path, ["commit", "operations", "[]", "patches"]) &&
    !isDocumentPath(path)) ||
  (endsWithPath(path, ["revisions", "[]", "patches"]) &&
    !isDocumentPath(path));

const isDirectDbTables = (path: readonly string[]): boolean =>
  endsWithPath(path, ["db", "tables"]) && !isDocumentPath(path);

const isDirectCommitCodeCID = (path: readonly string[]): boolean =>
  endsWithPath(path, ["commit", "codeCID"]) && !isDocumentPath(path);

const isDirectSchemaTableValue = (path: readonly string[]): boolean =>
  path.length >= 2 && path.at(-2) === "schemaTable" &&
  isProtocolSchemaTablePath(path, path.length - 2);

const isDirectRequestSchemaDefinition = (path: readonly string[]): boolean =>
  path.length === 2 && path[0] === "schemaDefinitions";

const isProtocolIdentityScalar = (
  path: readonly string[],
  value: unknown,
): boolean => {
  if (
    typeof value !== "string" || isDocumentPath(path) ||
    isInsideAuthCapability(path) || isInsideProtocolSchema(path)
  ) {
    return false;
  }
  const key = path.at(-1);
  if (key === "space") {
    return path.length <= 2 || endsWithPath(path, ["session", "space"]);
  }
  if (key === "sessionId") {
    return path.length <= 2 || endsWithPath(path, ["session", "sessionId"]);
  }
  if (key === "id") {
    return endsWithPath(path, ["upserts", "[]", "id"]) ||
      endsWithPath(path, ["removes", "[]", "id"]) ||
      endsWithPath(path, ["entities", "[]", "id"]) ||
      endsWithPath(path, ["operations", "[]", "id"]) ||
      endsWithPath(path, ["revisions", "[]", "id"]) ||
      endsWithPath(path, ["roots", "[]", "id"]) ||
      endsWithPath(path, ["watches", "[]", "id"]) ||
      endsWithPath(path, ["db", "id"]);
  }
  if (key === "branch" || key === "scope") {
    return endsWithPath(path, ["upserts", "[]", key]) ||
      endsWithPath(path, ["removes", "[]", key]) ||
      endsWithPath(path, ["entities", "[]", key]) ||
      endsWithPath(path, ["operations", "[]", key]) ||
      endsWithPath(path, ["revisions", "[]", key]);
  }
  return false;
};

export const classifyClientMessage = (
  message: ClientMessage | null,
): string => message === null ? "client.invalid" : `client.${message.type}`;

export const classifyServerMessage = (
  message: ServerMessage,
  originatingRequestType?: string,
): string => {
  switch (message.type) {
    case "hello.ok":
      return "server.hello.ok";
    case "session/effect":
      return "server.session/effect.sync";
    case "session/revoked":
      return "server.session/revoked";
    case "response": {
      const origin = originatingRequestType ?? "unknown";
      const suffix = responseCarriesSync(message)
        ? ".sync"
        : message.error !== undefined
        ? ".error"
        : "";
      return `server.response.${origin}${suffix}`;
    }
  }
};

const responseCarriesSync = (message: ServerMessage): boolean => {
  if (message.type !== "response" || message.ok === undefined) {
    return false;
  }
  const ok = message.ok;
  return ok !== null && typeof ok === "object" &&
    (ok as { sync?: { type?: unknown } }).sync?.type === "sync";
};

const emptyTotals = (): MutableTotals => ({
  baselineBytes: 0,
  actualBytes: 0,
  frames: 0,
  connections: new Set(),
});

const addToTotals = (
  totals: MutableTotals,
  record: MemoryWireAccountingRecord,
): void => {
  totals.baselineBytes += record.baselineBytes;
  totals.actualBytes += record.actualBytes;
  totals.frames += 1;
  totals.connections.add(record.connectionId);
};

const snapshotTotals = (
  totals: MutableTotals,
): MemoryWireAccountingTotals => ({
  baselineBytes: totals.baselineBytes,
  actualBytes: totals.actualBytes,
  frames: totals.frames,
  connections: totals.connections.size,
});

const addGrouped = (
  groups: Map<string, MutableTotals>,
  key: string,
  record: MemoryWireAccountingRecord,
): void => {
  let totals = groups.get(key);
  if (totals === undefined) {
    totals = emptyTotals();
    groups.set(key, totals);
  }
  addToTotals(totals, record);
};

const snapshotRows = (
  groups: Map<string, MutableTotals>,
): MemoryWireAccountingRow[] =>
  [...groups.entries()].map(([key, totals]) => ({
    key,
    ...snapshotTotals(totals),
  }));

export class MemoryWireAccountingAccumulator
  implements MemoryWireAccountingObserver {
  #active = false;
  #records: MemoryWireAccountingRecord[] = [];
  #runSalt = crypto.randomUUID();
  #retainedActualBytes = 0;
  #retainedCandidates = 0;
  #truncated: { reason: string } | undefined;

  private readonly limits: MemoryWireAccountingLimits;

  constructor(limits: Partial<MemoryWireAccountingLimits> = {}) {
    this.limits = { ...defaultLimits, ...limits };
  }

  isActive(): boolean {
    return this.#active;
  }

  start(): void {
    this.reset();
    this.#active = true;
  }

  reset(): void {
    this.#records = [];
    this.#runSalt = crypto.randomUUID();
    this.#retainedActualBytes = 0;
    this.#retainedCandidates = 0;
    this.#truncated = undefined;
  }

  accountPayload(payload: string, partitionKey: string): {
    semanticBytes: MemoryWireSemanticBytes;
    candidates: MemoryWireCandidate[];
  } {
    return accountMemoryWirePayload(
      payload,
      this.#runSalt,
      partitionKey,
      this.limits,
    );
  }

  stop(): MemoryWireAccountingReport {
    this.#active = false;
    const report = this.snapshot();
    this.reset();
    return report;
  }

  snapshot(): MemoryWireAccountingReport {
    const totals = emptyTotals();
    const byDirection = new Map<string, MutableTotals>();
    const byConnection = new Map<string, MutableTotals>();
    const byMetadataKind = new Map<string, MutableTotals>();
    const byClassification = new Map<string, MutableTotals>();

    for (const record of this.#records) {
      addToTotals(totals, record);
      addGrouped(byDirection, record.direction, record);
      addGrouped(byConnection, record.connectionId, record);
      addGrouped(byMetadataKind, record.metadata?.kind ?? "unknown", record);
      addGrouped(byClassification, record.classification, record);
    }

    return {
      totals: snapshotTotals(totals),
      byDirection: snapshotRows(byDirection),
      byConnection: snapshotRows(byConnection),
      byMetadataKind: snapshotRows(byMetadataKind),
      byClassification: snapshotRows(byClassification),
      records: this.#records.map(cloneRecord),
      truncated: this.#truncated === undefined
        ? undefined
        : { ...this.#truncated },
    };
  }

  observe(record: MemoryWireAccountingRecord): void {
    if (!this.#active) {
      return;
    }
    if (this.#truncated !== undefined) return;
    const candidateCount = (record.actualCandidates?.length ?? 0) +
      (record.baselineCandidates?.length ?? 0);
    if (
      this.#records.length >= this.limits.maxRecords ||
      this.#retainedActualBytes + record.actualBytes >
        this.limits.maxRetainedActualBytes ||
      this.#retainedCandidates + candidateCount >
        this.limits.maxRetainedCandidates
    ) {
      this.#truncated = { reason: "retention limit reached" };
      this.#active = false;
      return;
    }
    const cloned = cloneRecord(record);
    this.#records.push(cloned);
    this.#retainedActualBytes += cloned.actualBytes;
    this.#retainedCandidates += candidateCount;
  }
}

const cloneRecord = (
  record: MemoryWireAccountingRecord,
): MemoryWireAccountingRecord => ({
  ...record,
  metadata: record.metadata === undefined
    ? undefined
    : structuredClone(record.metadata),
  baselineSemanticBytes: record.baselineSemanticBytes === undefined
    ? undefined
    : { ...record.baselineSemanticBytes },
  actualSemanticBytes: record.actualSemanticBytes === undefined
    ? undefined
    : { ...record.actualSemanticBytes },
  baselineCandidates: record.baselineCandidates?.map((candidate) => ({
    ...candidate,
  })),
  actualCandidates: record.actualCandidates?.map((candidate) => ({
    ...candidate,
  })),
});
