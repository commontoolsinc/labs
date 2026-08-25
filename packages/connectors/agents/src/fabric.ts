import type { Cancel, Cell } from "@commonfabric/runner";
import {
  AGENT_CONNECTOR_WRITER_ID,
  type AgentFabricConnection,
  agentOwnerSchema,
  agentPrincipalSchema,
  cellHasOwnerProtection,
  pushStableCellGraph,
  readStableActions,
  readStableCellGraphValue,
  type StableCellGraphEntry,
  stableCellId,
  subscribeStableActions,
} from "./fabric-graph.ts";
import { stableFabricValue } from "./stable-fabric-value.ts";
import {
  commandReceiptCause,
  normalizeNativeSessionId,
  normalizeSourceId,
  sessionCause,
  sessionChunkCause,
  sessionKey,
} from "./session-contract.ts";
import {
  type CollectedSource,
  type PreparedSession,
  prepareSession,
} from "./reconcile.ts";
import {
  type AgentSessionCommandReceipt,
  type CommandTarget,
  parseCommandReceipt,
} from "./commands.ts";
import type {
  AgentDriver,
  DriverCapabilities,
  NormalizedMessage,
} from "./types.ts";
import { AGENT_CONNECTOR_SCHEMAS } from "./protocol.ts";
import { type GitContext, GitContextResolver } from "./git-context.ts";
import {
  materializeStableArrayCells,
  planStableArrayCells,
  type StableArrayCellPlan,
} from "./array-cell-identity.ts";
import { AsyncSerialQueue } from "./serial-queue.ts";
import { isAbsolute } from "@std/path";

export interface AgentFabricCells {
  index: Cell<unknown>;
  allIndex: Cell<unknown>;
  health: Cell<unknown>;
  commands: Cell<unknown>;
  receipts: Cell<unknown>;
}

export interface AgentFabricPublishOptions {
  preserveUntouchedStatus?: boolean;
  observationSequence?: number;
  checkoutDirectories?: string[];
  signal?: AbortSignal;
  onCommit?: () => void;
}

interface CellLink {
  id: string;
  space: string;
  path: readonly (string | number)[];
}

interface IndexEntry {
  ownerDid: string;
  key: string;
  sourceId: string;
  driver: string;
  nativeSessionId: string;
  title: string | null;
  cwd: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  gitWorktreeRoot: string | null;
  gitHeadSha: string | null;
  gitRemotes: Array<{ name: string; urls: string[] }>;
  gitObservedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean | null;
  active: boolean | null;
  capabilities: Record<string, unknown>;
  recentMessages?: NormalizedMessage[];
  manifest: Cell<unknown>;
  contentHash: string;
  syncStatus: "complete" | "partial" | "stale" | "deleted";
  deletedAt?: string;
}

export function recentSessionMessages(
  messages: NormalizedMessage[],
  limit = 12,
): NormalizedMessage[] {
  const count = Math.max(0, Math.trunc(limit));
  return count === 0 ? [] : messages.slice(-count);
}

interface AgentSessionIndex {
  schema: typeof AGENT_CONNECTOR_SCHEMAS.sessionIndex;
  ownerDid: string;
  bucket: "recent" | "all";
  generatedAt: string;
  generation: number;
  totalSessionCount?: number;
  olderSessionCount?: number;
  sources: Array<Record<string, unknown>>;
  checkouts?: CheckoutEntry[];
  // TODO(@ianh): Publish a shallow session directory with the row links and
  // sortable title, update-time, and worktree keys. Consumers cannot sort the
  // linked session rows globally without loading every row cell.
  sessions: IndexEntry[];
}

export interface CheckoutEntry {
  root: string;
  gitRepo: string | null;
  gitBranch: string | null;
  gitHeadSha: string | null;
  gitRemotes: Array<{ name: string; urls: string[] }>;
  observedAt: string;
}

export interface CheckoutObservation {
  gitRepo: string | null;
  gitBranch: string | null;
  gitWorktreeRoot: string | null;
  gitHeadSha: string | null;
  gitRemotes: Array<{ name: string; urls: string[] }>;
  gitObservedAt: string | null;
  syncStatus?: "complete" | "stale" | "partial" | "deleted";
}

const RECENT_SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function sessionIndexBuckets<
  T extends { updatedAt: string | null },
>(entries: T[], generatedAt: string): {
  recent: T[];
  all: T[];
  olderCount: number;
} {
  const cutoff = new Date(generatedAt).getTime() - RECENT_SESSION_WINDOW_MS;
  const recent = entries.filter((entry) => {
    if (!entry.updatedAt) return false;
    const updatedAt = new Date(entry.updatedAt).getTime();
    return Number.isFinite(updatedAt) && updatedAt >= cutoff;
  });
  return {
    recent,
    all: [...entries],
    olderCount: entries.length - recent.length,
  };
}

export function checkoutEntries(
  sessions: CheckoutObservation[],
  discovered: CheckoutObservation[] = [],
): CheckoutEntry[] {
  const checkouts = new Map<string, CheckoutEntry>();
  const observe = (observation: CheckoutObservation) => {
    const root = observation.gitWorktreeRoot;
    const observedAt = observation.gitObservedAt;
    if (!root || !observedAt || observation.syncStatus === "deleted") return;
    const prior = checkouts.get(root);
    if (prior && prior.observedAt > observedAt) return;
    checkouts.set(root, {
      root,
      gitRepo: observation.gitRepo,
      gitBranch: observation.gitBranch,
      gitHeadSha: observation.gitHeadSha,
      gitRemotes: observation.gitRemotes,
      observedAt,
    });
  };
  for (const session of sessions) observe(session);
  for (const checkout of discovered) observe(checkout);
  return [...checkouts.values()].sort((left, right) =>
    left.root.localeCompare(right.root)
  );
}

function storedCheckoutObservations(
  ...indexes: Array<AgentSessionIndex | null>
): CheckoutObservation[] {
  return indexes.flatMap((index) =>
    (index?.checkouts ?? []).map((checkout) => ({
      gitRepo: checkout.gitRepo,
      gitBranch: checkout.gitBranch,
      gitWorktreeRoot: checkout.root,
      gitHeadSha: checkout.gitHeadSha,
      gitRemotes: checkout.gitRemotes,
      gitObservedAt: checkout.observedAt,
    }))
  );
}

export function agentFabricCauses(spaceDid: string, ownerDid: string) {
  return {
    index: {
      spaceDid,
      ownerDid,
      agentConnector: "recent-session-index",
    },
    allIndex: {
      spaceDid,
      ownerDid,
      agentConnector: "all-session-index",
    },
    health: { spaceDid, ownerDid, agentConnector: "health" },
    commands: { spaceDid, ownerDid, agentConnector: "commands" },
    receipts: { spaceDid, ownerDid, agentConnector: "receipts" },
  } as const;
}

function fullLink(cell: Cell<unknown>): CellLink {
  const link = cell.getAsNormalizedFullLink();
  return {
    id: link.id!,
    space: link.space!,
    path: [...link.path],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDriverCapabilities(value: unknown): value is DriverCapabilities {
  if (!isRecord(value)) return false;
  if (
    ![
      "inventory",
      "read",
      "prompt",
      "cancel",
      "rename",
      "setMode",
      "setConfigOption",
    ].every((key) => typeof value[key] === "boolean")
  ) {
    return false;
  }
  if (
    value.modes !== undefined &&
    (!Array.isArray(value.modes) ||
      !value.modes.every((mode) => typeof mode === "string"))
  ) {
    return false;
  }
  return value.configOptions === undefined || isRecord(value.configOptions);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function equalCellLink(value: unknown, expected: CellLink): boolean {
  if (!isRecord(value)) return false;
  if (
    value.id !== expected.id || value.space !== expected.space ||
    !Array.isArray(value.path) || value.path.length !== expected.path.length
  ) {
    return false;
  }
  return value.path.every((part, index) =>
    (typeof part === "string" || typeof part === "number") &&
    part === expected.path[index]
  );
}

function graphEntry(cell: Cell<unknown>, plan: StableArrayCellPlan) {
  return {
    cell,
    value: (
      materializeCell: Parameters<typeof materializeStableArrayCells>[1],
    ) =>
      materializeStableArrayCells(
        plan,
        materializeCell,
      ) as Record<string, unknown>,
  };
}

function childScope(
  spaceDid: string,
  ownerDid: string,
  owner: string,
  identity?: Record<string, unknown>,
) {
  return {
    spaceDid,
    ownerDid,
    agentConnector: `${owner}-array-elements`,
    ...identity,
  };
}

function validatedReceiptIndexRows(
  conn: AgentFabricConnection,
  value: unknown,
): Array<Record<string, unknown>> {
  if (
    !isRecord(value) ||
    value.schema !== AGENT_CONNECTOR_SCHEMAS.commandReceipts ||
    value.ownerDid !== conn.ownerDid ||
    !isIsoTimestamp(value.updatedAt) ||
    !Array.isArray(value.receipts)
  ) {
    throw new Error("command receipt index has an invalid shape");
  }
  if (value.receipts.length > 200) {
    throw new Error("command receipt index exceeds 200 rows");
  }

  const commandIds = new Set<string>();
  return value.receipts.map((item, index) => {
    if (!isRecord(item) || typeof item.commandId !== "string") {
      throw new Error(
        `command receipt index row has an invalid shape: ${index}`,
      );
    }
    const commandId = item.commandId;
    const receipt = parseCommandReceipt(
      commandId,
      {
        schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
        ownerDid: item.ownerDid,
        commandId,
        sourceId: item.sourceId,
        nativeSessionId: item.nativeSessionId,
        status: item.status,
        ...(item.error === undefined ? {} : { error: item.error }),
      },
      `command receipt index row ${index}`,
    );
    if (receipt.ownerDid !== conn.ownerDid) {
      throw new Error(
        `command receipt index row belongs to another owner: ${index}`,
      );
    }
    if (!isIsoTimestamp(item.updatedAt)) {
      throw new Error(
        `command receipt index row updatedAt is invalid: ${index}`,
      );
    }
    const expectedLink = fullLink(
      conn.runtime.getCell(
        conn.spaceDid,
        commandReceiptCause(conn.spaceDid, conn.ownerDid, commandId),
        agentOwnerSchema(conn.ownerDid),
      ),
    );
    if (!equalCellLink(item.receipt, expectedLink)) {
      throw new Error(
        `command receipt index row receipt link is invalid: ${index}`,
      );
    }
    if (commandIds.has(commandId)) {
      throw new Error(
        `command receipt index contains a duplicate command: ${commandId}`,
      );
    }
    commandIds.add(commandId);
    return {
      commandId,
      ownerDid: receipt.ownerDid,
      sourceId: receipt.sourceId,
      nativeSessionId: receipt.nativeSessionId,
      status: receipt.status,
      updatedAt: item.updatedAt,
      ...(receipt.error ? { error: receipt.error } : {}),
      receipt: expectedLink,
    };
  });
}

export function createAgentFabricCells(
  conn: AgentFabricConnection,
): AgentFabricCells {
  const causes = agentFabricCauses(conn.spaceDid, conn.ownerDid);
  const connectorSchema = agentOwnerSchema(conn.ownerDid);
  const commandSchema = agentOwnerSchema(conn.ownerDid, false);
  return {
    index: conn.runtime.getCell(conn.spaceDid, causes.index, connectorSchema),
    allIndex: conn.runtime.getCell(
      conn.spaceDid,
      causes.allIndex,
      connectorSchema,
    ),
    health: conn.runtime.getCell(conn.spaceDid, causes.health, connectorSchema),
    commands: conn.runtime.getCell(
      conn.spaceDid,
      causes.commands,
      commandSchema,
    ),
    receipts: conn.runtime.getCell(
      conn.spaceDid,
      causes.receipts,
      connectorSchema,
    ),
  };
}

export async function ensureAgentFabricCells(
  conn: AgentFabricConnection,
): Promise<AgentFabricCells> {
  const cells = await syncAgentFabricCells(conn);
  await claimAgentFabricRoots(conn, cells);
  return cells;
}

async function syncAgentFabricCells(
  conn: AgentFabricConnection,
): Promise<AgentFabricCells> {
  const cells = createAgentFabricCells(conn);
  await Promise.all([
    cells.index.sync(),
    cells.allIndex.sync(),
    cells.health.sync(),
    cells.commands.sync(),
    cells.receipts.sync(),
  ]);
  await conn.runtime.storageManager.synced();
  return cells;
}

async function claimAgentFabricRoots(
  conn: AgentFabricConnection,
  cells: AgentFabricCells,
): Promise<void> {
  const generatedAt = new Date().toISOString();
  const roots: Array<{
    name: string;
    cell: Cell<unknown>;
    initialValue: Record<string, unknown>;
  }> = [{
    name: "recent session index",
    cell: cells.index,
    initialValue: {
      schema: AGENT_CONNECTOR_SCHEMAS.sessionIndex,
      ownerDid: conn.ownerDid,
      bucket: "recent",
      generatedAt,
      generation: 0,
      totalSessionCount: 0,
      olderSessionCount: 0,
      sources: [],
      sessions: [],
    },
  }, {
    name: "complete session index",
    cell: cells.allIndex,
    initialValue: {
      schema: AGENT_CONNECTOR_SCHEMAS.sessionIndex,
      ownerDid: conn.ownerDid,
      bucket: "all",
      generatedAt,
      generation: 0,
      totalSessionCount: 0,
      olderSessionCount: 0,
      sources: [],
      sessions: [],
    },
  }, {
    name: "health",
    cell: cells.health,
    initialValue: {
      schema: AGENT_CONNECTOR_SCHEMAS.health,
      ownerDid: conn.ownerDid,
    },
  }, {
    name: "receipt index",
    cell: cells.receipts,
    initialValue: {
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipts,
      ownerDid: conn.ownerDid,
      receipts: [],
      updatedAt: generatedAt,
    },
  }];
  const tx = conn.runtime.edit();
  tx.setCfcImplementationIdentity({
    kind: "builtin",
    builtinId: AGENT_CONNECTOR_WRITER_ID,
  });
  try {
    for (const root of roots) {
      const link = root.cell.getAsNormalizedFullLink();
      const value = tx.readValueOrThrow(link);
      if (value !== undefined) {
        if (!cellHasOwnerProtection(tx, root.cell, conn.ownerDid)) {
          throw new Error(
            `refusing to adopt an unprotected ${root.name} for ${conn.ownerDid}`,
          );
        }
        root.cell.withTx(tx).applyCfcSchemaToExistingValue();
        continue;
      }
      tx.writeValueOrThrow(link, stableFabricValue(root.initialValue));
      root.cell.withTx(tx).applyCfcSchemaToExistingValue();
    }
    tx.prepareCfc();
  } catch (error) {
    tx.abort(error);
    throw error;
  }
  const committed = await tx.commit();
  if (committed.error) {
    throw new Error(
      `could not claim agent connector storage: ${committed.error.message}`,
      { cause: committed.error },
    );
  }
}

function asIndex(
  value: unknown,
  ownerDid: string,
  expectedBucket: "recent" | "all",
): AgentSessionIndex | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("agent session index is not an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schema !== AGENT_CONNECTOR_SCHEMAS.sessionIndex ||
    record.ownerDid !== ownerDid ||
    record.bucket !== expectedBucket ||
    !isIsoTimestamp(record.generatedAt) ||
    !isNonNegativeSafeInteger(record.generation) ||
    (record.totalSessionCount !== undefined &&
      !isNonNegativeSafeInteger(record.totalSessionCount)) ||
    (record.olderSessionCount !== undefined &&
      !isNonNegativeSafeInteger(record.olderSessionCount)) ||
    !Array.isArray(record.sources) ||
    (record.checkouts !== undefined && !Array.isArray(record.checkouts)) ||
    !Array.isArray(record.sessions)
  ) {
    throw new Error("agent session index has an invalid shape");
  }
  const sourceIds = new Set<string>();
  for (const [index, source] of record.sources.entries()) {
    if (
      !isRecord(source) || typeof source.id !== "string" ||
      normalizeSourceId(source.id) !== source.id || sourceIds.has(source.id) ||
      typeof source.driver !== "string" || source.driver.length === 0 ||
      !isDriverCapabilities(source.capabilities)
    ) {
      throw new Error(
        `agent session index source ${index} has an invalid shape`,
      );
    }
    sourceIds.add(source.id);
  }
  const checkoutRoots = new Set<string>();
  for (const [index, checkout] of (record.checkouts ?? []).entries()) {
    if (
      !isRecord(checkout) || typeof checkout.root !== "string" ||
      !isAbsolute(checkout.root) || checkoutRoots.has(checkout.root) ||
      !isNullableString(checkout.gitRepo) ||
      !isNullableString(checkout.gitBranch) ||
      !isNullableString(checkout.gitHeadSha) ||
      !Array.isArray(checkout.gitRemotes) ||
      !checkout.gitRemotes.every((remote) =>
        isRecord(remote) && typeof remote.name === "string" &&
        remote.name.length > 0 && Array.isArray(remote.urls) &&
        remote.urls.every((url) => typeof url === "string" && url.length > 0)
      ) ||
      !isIsoTimestamp(checkout.observedAt)
    ) {
      throw new Error(
        `agent session index checkout ${index} has an invalid shape`,
      );
    }
    checkoutRoots.add(checkout.root);
  }
  const sessionKeys = new Set<string>();
  const statuses = new Set(["complete", "partial", "stale", "deleted"]);
  for (const [index, session] of record.sessions.entries()) {
    if (!isRecord(session)) {
      throw new Error(`agent session index row ${index} has an invalid shape`);
    }
    if (typeof session.driver !== "string" || session.driver.length === 0) {
      throw new Error(`agent session index row ${index} has no driver`);
    }
    if (
      session.ownerDid !== ownerDid || typeof session.key !== "string" ||
      typeof session.sourceId !== "string" ||
      typeof session.nativeSessionId !== "string" ||
      normalizeSourceId(session.sourceId) !== session.sourceId ||
      normalizeNativeSessionId(session.nativeSessionId) !==
        session.nativeSessionId ||
      session.key !== sessionKey(session.sourceId, session.nativeSessionId) ||
      sessionKeys.has(session.key) ||
      typeof session.contentHash !== "string" ||
      session.contentHash.length === 0 ||
      typeof session.syncStatus !== "string" ||
      !statuses.has(session.syncStatus) ||
      !isNullableString(session.title) || !isNullableString(session.cwd) ||
      !isNullableString(session.gitRepo) ||
      !isNullableString(session.gitBranch) ||
      !isNullableString(session.gitWorktreeRoot) ||
      !isNullableString(session.createdAt) ||
      !isNullableString(session.updatedAt) ||
      !isNullableBoolean(session.archived) ||
      !isNullableBoolean(session.active) ||
      !isRecord(session.capabilities) ||
      (session.recentMessages !== undefined &&
        !Array.isArray(session.recentMessages)) ||
      (session.deletedAt !== undefined &&
        !isIsoTimestamp(session.deletedAt))
    ) {
      throw new Error(`agent session index row ${index} has an invalid shape`);
    }
    sessionKeys.add(session.key);
  }
  return record as unknown as AgentSessionIndex;
}

interface PlannedSessionGraph {
  chunks: StableCellGraphEntry[];
  manifest: StableCellGraphEntry;
  indexEntry: IndexEntry;
}

const SESSION_GRAPH_BATCH_SIZE = 10;
const MANIFEST_GRAPH_BATCH_SIZE = 1;

async function planSessionGraph(
  conn: AgentFabricConnection,
  prepared: PreparedSession,
  driver: string,
  gitContext: GitContext,
): Promise<PlannedSessionGraph> {
  const manifest = conn.runtime.getCell(
    conn.spaceDid,
    sessionCause(
      conn.spaceDid,
      conn.ownerDid,
      prepared.sourceId,
      prepared.nativeSessionId,
    ),
    agentOwnerSchema(conn.ownerDid),
  );
  const chunkEntries = await Promise.all(prepared.chunks.map(async (chunk) => {
    const cell = conn.runtime.getCell(
      conn.spaceDid,
      sessionChunkCause(
        conn.spaceDid,
        conn.ownerDid,
        prepared.sourceId,
        prepared.nativeSessionId,
        chunk.part,
        chunk.contentHash,
      ),
      agentOwnerSchema(conn.ownerDid),
    );
    const value = {
      schema: AGENT_CONNECTOR_SCHEMAS.sessionChunk,
      ownerDid: conn.ownerDid,
      key: prepared.key,
      part: chunk.part,
      contentHash: chunk.contentHash,
      events: chunk.events,
    };
    return {
      cell,
      plan: await planStableArrayCells(
        value,
        childScope(conn.spaceDid, conn.ownerDid, "session-events", {
          sourceId: prepared.sourceId,
          nativeSessionId: prepared.nativeSessionId,
          part: chunk.part,
          contentHash: chunk.contentHash,
        }),
      ),
      descriptor: {
        part: chunk.part,
        link: cell,
        contentHash: chunk.contentHash,
        byteLength: chunk.byteLength,
        eventCount: chunk.eventCount,
      },
    };
  }));
  const manifestValue = {
    schema: AGENT_CONNECTOR_SCHEMAS.session,
    ownerDid: conn.ownerDid,
    key: prepared.key,
    sourceId: prepared.sourceId,
    driver,
    nativeSessionId: prepared.nativeSessionId,
    metadata: prepared.summary.raw,
    summary: prepared.summary,
    normalized: { messages: prepared.normalizedMessages },
    chunks: chunkEntries.map(({ descriptor }) => descriptor),
    snapshotHash: prepared.snapshotHash,
    revision: prepared.revision ?? null,
    observedAt: new Date().toISOString(),
    complete: prepared.complete,
  };
  const manifestPlan = await planStableArrayCells(
    manifestValue,
    childScope(conn.spaceDid, conn.ownerDid, "session", {
      sourceId: prepared.sourceId,
      nativeSessionId: prepared.nativeSessionId,
    }),
  );
  return {
    chunks: chunkEntries.map(({ cell, plan }) => graphEntry(cell, plan)),
    manifest: graphEntry(manifest, manifestPlan),
    indexEntry: {
      ownerDid: conn.ownerDid,
      key: prepared.key,
      sourceId: prepared.sourceId,
      driver,
      nativeSessionId: prepared.nativeSessionId,
      title: prepared.summary.title,
      cwd: prepared.summary.cwd,
      gitRepo: prepared.summary.gitRepo ?? null,
      gitBranch: prepared.summary.gitBranch ?? null,
      gitWorktreeRoot: prepared.summary.gitWorktreeRoot ?? null,
      gitHeadSha: gitContext.gitHeadSha,
      gitRemotes: gitContext.gitRemotes,
      gitObservedAt: gitContext.gitObservedAt,
      createdAt: prepared.summary.createdAt,
      updatedAt: prepared.summary.updatedAt,
      archived: prepared.summary.archived,
      active: prepared.summary.active,
      capabilities: {},
      recentMessages: recentSessionMessages(prepared.normalizedMessages),
      manifest,
      contentHash: prepared.snapshotHash,
      syncStatus: prepared.complete ? "complete" : "partial",
    },
  };
}

async function pushSessionGraphBatch(
  conn: AgentFabricConnection,
  graphs: PlannedSessionGraph[],
): Promise<void> {
  const chunks = graphs.flatMap((graph) => graph.chunks);
  for (
    let offset = 0;
    offset < chunks.length;
    offset += SESSION_GRAPH_BATCH_SIZE
  ) {
    await pushStableCellGraph(
      conn,
      chunks.slice(offset, offset + SESSION_GRAPH_BATCH_SIZE),
    );
  }
  const manifests = graphs.map((graph) => graph.manifest);
  for (
    let offset = 0;
    offset < manifests.length;
    offset += MANIFEST_GRAPH_BATCH_SIZE
  ) {
    await pushStableCellGraph(
      conn,
      manifests.slice(offset, offset + MANIFEST_GRAPH_BATCH_SIZE),
    );
  }
}

export class AgentFabricTarget implements CommandTarget {
  readonly conn: AgentFabricConnection;
  readonly cells: AgentFabricCells;
  readonly #gitContext: GitContextResolver;
  readonly #mutations = new AsyncSerialQueue();
  readonly #latestObservationBySession = new Map<string, number>();
  readonly #latestCompleteObservationBySource = new Map<string, number>();
  readonly #latestDescriptorObservationBySource = new Map<string, number>();
  #nextObservationSequence = 1;
  #commandCellBound = false;

  private constructor(
    conn: AgentFabricConnection,
    cells: AgentFabricCells,
    gitContext: GitContextResolver,
  ) {
    this.conn = conn;
    this.cells = cells;
    this.#gitContext = gitContext;
  }

  static async open(
    conn: AgentFabricConnection,
    gitContext = new GitContextResolver(),
  ): Promise<AgentFabricTarget> {
    const cells = await ensureAgentFabricCells(conn);
    return new AgentFabricTarget(conn, cells, gitContext);
  }

  static async connect(
    conn: AgentFabricConnection,
    gitContext = new GitContextResolver(),
  ): Promise<AgentFabricTarget> {
    const cells = await syncAgentFabricCells(conn);
    return new AgentFabricTarget(conn, cells, gitContext);
  }

  claimStorage(): Promise<void> {
    return this.#mutations.run(() =>
      claimAgentFabricRoots(this.conn, this.cells)
    );
  }

  publish(
    collected: CollectedSource[],
    options: AgentFabricPublishOptions = {},
  ): Promise<number> {
    const observationSequence = options.observationSequence ??
      this.beginSessionObservation();
    if (
      !Number.isSafeInteger(observationSequence) || observationSequence < 1
    ) {
      return Promise.reject(
        new Error("observationSequence must be a positive safe integer"),
      );
    }
    return this.#mutations.run(() =>
      this.#publish(collected, { ...options, observationSequence })
    );
  }

  beginSessionObservation(): number {
    const sequence = this.#nextObservationSequence;
    if (!Number.isSafeInteger(sequence)) {
      throw new Error("session observation sequence is exhausted");
    }
    this.#nextObservationSequence++;
    return sequence;
  }

  async validateCheckout(
    directory: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return await this.#gitContext.validateCheckout(directory, signal);
  }

  async #publish(
    collected: CollectedSource[],
    options: AgentFabricPublishOptions & { observationSequence: number },
  ): Promise<number> {
    let graphCommitStarted = false;
    const startGraphCommit = () => {
      if (graphCommitStarted) return;
      options.onCommit?.();
      graphCommitStarted = true;
    };
    const throwIfPublicationCanStop = () => {
      if (!graphCommitStarted) options.signal?.throwIfAborted();
    };
    const cancellableSignal = () =>
      graphCommitStarted ? undefined : options.signal;
    throwIfPublicationCanStop();
    const isSuperseded = (key: string) =>
      (this.#latestObservationBySession.get(key) ?? 0) >
        options.observationSequence;
    const isSourceSuperseded = (sourceId: string) =>
      (this.#latestCompleteObservationBySource.get(sourceId) ?? 0) >
        options.observationSequence;
    const isDescriptorSuperseded = (sourceId: string) =>
      (this.#latestDescriptorObservationBySource.get(sourceId) ?? 0) >
        options.observationSequence;
    const gitContext = this.#gitContext.beginObservation();
    const graphReadCache = new Map<string, Promise<unknown>>();
    const previousRecent = asIndex(
      await readStableCellGraphValue(
        this.conn,
        this.cells.index,
        graphReadCache,
        { preserveLinkFields: new Set(["manifest"]) },
      ),
      this.conn.ownerDid,
      "recent",
    );
    const previousAll = asIndex(
      await readStableCellGraphValue(
        this.conn,
        this.cells.allIndex,
        graphReadCache,
        { preserveLinkFields: new Set(["manifest"]) },
      ),
      this.conn.ownerDid,
      "all",
    );
    const discoveredCheckouts: GitContext[] = [];
    if (options.checkoutDirectories !== undefined) {
      for (const directory of options.checkoutDirectories) {
        throwIfPublicationCanStop();
        const checkout = await gitContext.resolveCheckout(
          directory,
          cancellableSignal(),
        );
        if (checkout) discoveredCheckouts.push(checkout);
      }
    }
    throwIfPublicationCanStop();
    const entriesByKey = new Map<string, IndexEntry>(
      [
        ...(previousRecent?.sessions ?? []),
        ...(previousAll?.sessions ?? []),
      ]
        .map((entry): [string, IndexEntry] => {
          const restored = {
            ...entry,
            gitHeadSha: typeof entry.gitHeadSha === "string"
              ? entry.gitHeadSha
              : null,
            gitRemotes: Array.isArray(entry.gitRemotes) ? entry.gitRemotes : [],
            gitObservedAt: typeof entry.gitObservedAt === "string"
              ? entry.gitObservedAt
              : null,
            archived: typeof entry.archived === "boolean"
              ? entry.archived
              : null,
            active: typeof entry.active === "boolean" ? entry.active : null,
            manifest: this.conn.runtime.getCell(
              this.conn.spaceDid,
              sessionCause(
                this.conn.spaceDid,
                this.conn.ownerDid,
                entry.sourceId,
                entry.nativeSessionId,
              ),
              agentOwnerSchema(this.conn.ownerDid),
            ),
          };
          return [
            entry.key,
            options.preserveUntouchedStatus || isSuperseded(entry.key) ||
              isSourceSuperseded(entry.sourceId)
              ? restored
              : { ...restored, syncStatus: "stale" },
          ];
        }),
    );
    const sourceRows = new Map<string, Record<string, unknown>>(
      [
        ...(previousRecent?.sources ?? []),
        ...(previousAll?.sources ?? []),
      ].map((
        source,
      ) => [String(source.id), { ...source }]),
    );
    let pendingGraphs: PlannedSessionGraph[] = [];
    const observedSessionKeys = new Set<string>();
    const observedCompleteSourceIds = new Set<string>();
    const observedDescriptorSourceIds = new Set<string>();
    const flushGraphs = async () => {
      if (pendingGraphs.length === 0) return;
      throwIfPublicationCanStop();
      const batch = pendingGraphs;
      pendingGraphs = [];
      startGraphCommit();
      await pushSessionGraphBatch(this.conn, batch);
    };

    for (const source of collected) {
      if (isSourceSuperseded(source.source.id)) continue;
      const priorSourceRow = sourceRows.get(source.source.id);
      const descriptorSuperseded = isDescriptorSuperseded(source.source.id);
      const driver = descriptorSuperseded &&
          typeof priorSourceRow?.driver === "string"
        ? priorSourceRow.driver
        : source.source.driver;
      const capabilities = descriptorSuperseded &&
          isDriverCapabilities(priorSourceRow?.capabilities)
        ? priorSourceRow.capabilities
        : source.source.capabilities;
      if (!descriptorSuperseded) {
        observedDescriptorSourceIds.add(source.source.id);
      }
      const priorForSource = [...entriesByKey.values()].filter((entry) =>
        entry.sourceId === source.source.id
      );
      const currentKeys = new Set<string>();
      for (const snapshot of source.sessions) {
        throwIfPublicationCanStop();
        const key = sessionKey(
          source.source.id,
          snapshot.summary.nativeSessionId,
        );
        currentKeys.add(key);
        if (isSuperseded(key)) continue;
        const previousEntry = entriesByKey.get(key);
        const observedContext = await gitContext.resolve(
          snapshot.summary.cwd,
          cancellableSignal(),
        );
        throwIfPublicationCanStop();
        const preservesPriorGit = previousEntry !== undefined &&
          (observedContext.gitObservationFailed === true ||
            (observedContext.gitWorktreeRoot !== null &&
              observedContext.gitObservedAt === null &&
              previousEntry.gitWorktreeRoot ===
                observedContext.gitWorktreeRoot));
        const context = preservesPriorGit
          ? {
            gitRepo: previousEntry!.gitRepo,
            gitBranch: previousEntry!.gitBranch,
            gitWorktreeRoot: previousEntry!.gitWorktreeRoot,
            gitHeadSha: previousEntry!.gitHeadSha,
            gitRemotes: previousEntry!.gitRemotes,
            gitObservedAt: previousEntry!.gitObservedAt,
          }
          : observedContext;
        const {
          gitHeadSha: _gitHeadSha,
          gitRemotes: _gitRemotes,
          gitObservedAt: _gitObservedAt,
          gitObservationFailed: _gitObservationFailed,
          ...summaryContext
        } = context;
        const prepared = await prepareSession(source.source.id, {
          ...snapshot,
          summary: {
            ...snapshot.summary,
            ...summaryContext,
          },
        });
        throwIfPublicationCanStop();
        observedSessionKeys.add(prepared.key);
        if (
          previousEntry &&
          previousEntry.contentHash === prepared.snapshotHash &&
          previousEntry.driver === driver
        ) {
          const { deletedAt: _deletedAt, ...rest } = previousEntry;
          entriesByKey.set(prepared.key, {
            ...rest,
            gitRepo: prepared.summary.gitRepo ?? null,
            gitBranch: prepared.summary.gitBranch ?? null,
            gitWorktreeRoot: prepared.summary.gitWorktreeRoot ?? null,
            gitHeadSha: context.gitHeadSha,
            gitRemotes: context.gitRemotes,
            gitObservedAt: context.gitObservedAt,
            capabilities: { ...capabilities },
            recentMessages: recentSessionMessages(
              prepared.normalizedMessages,
            ),
            syncStatus: prepared.complete ? "complete" : "partial",
          });
          continue;
        }
        const graph = await planSessionGraph(
          this.conn,
          prepared,
          driver,
          context,
        );
        const entry = graph.indexEntry;
        entry.capabilities = { ...capabilities };
        entriesByKey.set(entry.key, entry);
        pendingGraphs.push(graph);
        if (pendingGraphs.length >= SESSION_GRAPH_BATCH_SIZE) {
          await flushGraphs();
        }
      }
      for (const prior of priorForSource) {
        if (currentKeys.has(prior.key)) continue;
        entriesByKey.set(prior.key, {
          ...prior,
          capabilities: { ...capabilities },
        });
      }
      if (source.complete) {
        observedCompleteSourceIds.add(source.source.id);
        for (const prior of priorForSource) {
          if (!currentKeys.has(prior.key) && !isSuperseded(prior.key)) {
            const current = entriesByKey.get(prior.key) ?? prior;
            entriesByKey.set(prior.key, {
              ...current,
              syncStatus: "deleted",
              deletedAt: current.deletedAt ?? new Date().toISOString(),
            });
            observedSessionKeys.add(prior.key);
          }
        }
      } else {
        for (const error of source.errors) {
          if (!error.nativeSessionId) continue;
          const key = sessionKey(source.source.id, error.nativeSessionId);
          if (isSuperseded(key)) continue;
          const prior = entriesByKey.get(key);
          if (prior) {
            entriesByKey.set(key, { ...prior, syncStatus: "partial" });
            observedSessionKeys.add(key);
          }
        }
      }
      if (options.preserveUntouchedStatus && priorSourceRow) {
        sourceRows.set(source.source.id, {
          ...priorSourceRow,
          id: source.source.id,
          driver,
          capabilities,
        });
      } else {
        sourceRows.set(source.source.id, {
          id: source.source.id,
          driver,
          capabilities,
          complete: source.complete,
          sessionCount: source.sessions.length,
          errors: source.errors,
        });
      }
    }
    await flushGraphs();
    throwIfPublicationCanStop();
    const generatedAt = new Date().toISOString();
    const generation = Math.max(
      previousRecent?.generation ?? 0,
      previousAll?.generation ?? 0,
    ) + 1;
    const sources = [...sourceRows.values()].sort((left, right) =>
      String(left.id).localeCompare(String(right.id))
    );
    const sessions = [...entriesByKey.values()].sort((left, right) =>
      left.key.localeCompare(right.key)
    );
    const activeSessions = sessions.filter((session) =>
      session.syncStatus !== "deleted"
    );
    const deletedSessions = sessions.filter((session) =>
      session.syncStatus === "deleted"
    );
    const buckets = sessionIndexBuckets(activeSessions, generatedAt);
    const allSessions = [...buckets.all, ...deletedSessions].sort((
      left,
      right,
    ) => left.key.localeCompare(right.key));
    const checkouts = options.checkoutDirectories === undefined
      ? checkoutEntries(
        activeSessions,
        storedCheckoutObservations(previousRecent, previousAll),
      )
      : checkoutEntries(activeSessions, discoveredCheckouts);
    const recentIndex: AgentSessionIndex = {
      schema: AGENT_CONNECTOR_SCHEMAS.sessionIndex,
      ownerDid: this.conn.ownerDid,
      bucket: "recent",
      generatedAt,
      generation,
      totalSessionCount: activeSessions.length,
      olderSessionCount: buckets.olderCount,
      sources,
      checkouts,
      sessions: buckets.recent,
    };
    const allIndex: AgentSessionIndex = {
      schema: AGENT_CONNECTOR_SCHEMAS.sessionIndex,
      ownerDid: this.conn.ownerDid,
      bucket: "all",
      generatedAt,
      generation,
      totalSessionCount: activeSessions.length,
      olderSessionCount: buckets.olderCount,
      sources,
      checkouts,
      sessions: allSessions,
    };
    const indexChildScope = childScope(
      this.conn.spaceDid,
      this.conn.ownerDid,
      "session-index",
    );
    const [recentIndexPlan, allIndexPlan] = await Promise.all([
      planStableArrayCells(recentIndex, indexChildScope),
      planStableArrayCells(allIndex, indexChildScope),
    ]);
    throwIfPublicationCanStop();
    startGraphCommit();
    await pushStableCellGraph(
      this.conn,
      [
        graphEntry(this.cells.index, recentIndexPlan),
        graphEntry(this.cells.allIndex, allIndexPlan),
      ],
    );
    for (const key of observedSessionKeys) {
      this.#latestObservationBySession.set(
        key,
        options.observationSequence,
      );
    }
    for (const sourceId of observedCompleteSourceIds) {
      this.#latestCompleteObservationBySource.set(
        sourceId,
        options.observationSequence,
      );
    }
    for (const sourceId of observedDescriptorSourceIds) {
      this.#latestDescriptorObservationBySource.set(
        sourceId,
        options.observationSequence,
      );
    }
    return activeSessions.length;
  }

  publishHealth(value: Record<string, unknown>): Promise<void> {
    return this.#mutations.run(() => this.#publishHealth(value));
  }

  async #publishHealth(value: Record<string, unknown>): Promise<void> {
    const healthValue = {
      ...value,
      schema: AGENT_CONNECTOR_SCHEMAS.health,
      ownerDid: this.conn.ownerDid,
    };
    const plan = await planStableArrayCells(
      healthValue,
      childScope(this.conn.spaceDid, this.conn.ownerDid, "health"),
    );
    await pushStableCellGraph(
      this.conn,
      [graphEntry(this.cells.health, plan)],
    );
  }

  commandCellId(): string {
    return stableCellId(this.cells.commands.resolveAsCell());
  }

  receiptCellId(): string {
    return stableCellId(this.cells.receipts);
  }

  async bindCommandCell(
    cell: Cell<unknown>,
    writerAuthorization: unknown,
  ): Promise<void> {
    const suppliedLink = cell.getAsNormalizedFullLink();
    const expectedLink = this.cells.commands.getAsNormalizedFullLink();
    if (
      suppliedLink.space !== expectedLink.space ||
      suppliedLink.id !== expectedLink.id ||
      suppliedLink.scope !== expectedLink.scope ||
      suppliedLink.path.length !== expectedLink.path.length ||
      suppliedLink.path.some((part, index) => part !== expectedLink.path[index])
    ) {
      throw new Error("command cell is not the connector's owner-scoped queue");
    }
    const authorization = isRecord(writerAuthorization) &&
        isRecord(writerAuthorization.__ctWriterIdentityOf)
      ? writerAuthorization.__ctWriterIdentityOf
      : undefined;
    if (
      !authorization || typeof authorization.file !== "string" ||
      typeof authorization.moduleIdentity !== "string" ||
      !Array.isArray(authorization.path) ||
      !authorization.path.every((part) => typeof part === "string")
    ) {
      throw new Error("command writer authorization is invalid");
    }
    const tx = this.conn.runtime.edit();
    tx.setCfcImplementationIdentity({
      kind: "verified",
      moduleIdentity: authorization.moduleIdentity,
      sourceFile: authorization.file,
      bindingPath: authorization.path as string[],
    });
    try {
      const hasOwnerProtection = cellHasOwnerProtection(
        tx,
        cell,
        this.conn.ownerDid,
      );
      const protectedCell = cell.withTx(tx);
      const existing = protectedCell.getRawUntyped({ frozen: false });
      if (
        !hasOwnerProtection && existing !== undefined &&
        (!Array.isArray(existing) || existing.length > 0)
      ) {
        throw new Error(
          "refusing to adopt a populated command queue without its owner label",
        );
      }
      if (existing === undefined) protectedCell.setRawUntyped([]);
      protectedCell.asSchema(
        agentPrincipalSchema(this.conn.ownerDid, writerAuthorization),
      )
        .applyCfcSchemaToExistingValue();
      tx.prepareCfc();
    } catch (error) {
      tx.abort(error);
      throw error;
    }
    const result = await tx.commit();
    if (result.error) {
      throw new Error(
        `could not protect the owner command cell: ${result.error.message}`,
        { cause: result.error },
      );
    }
    this.cells.commands = cell;
    this.#commandCellBound = true;
  }

  commandsAreBound(): boolean {
    return this.#commandCellBound;
  }

  #assertCommandCellBound(): void {
    if (!this.#commandCellBound) {
      throw new Error("owner command cell has not been bound");
    }
  }

  async readReceipt(
    commandId: string,
  ): Promise<AgentSessionCommandReceipt | undefined> {
    const cell = this.conn.runtime.getCell(
      this.conn.spaceDid,
      commandReceiptCause(this.conn.spaceDid, this.conn.ownerDid, commandId),
      agentOwnerSchema(this.conn.ownerDid),
    );
    await cell.sync();
    await this.conn.runtime.storageManager.synced();
    const claim = this.conn.runtime.edit();
    claim.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: AGENT_CONNECTOR_WRITER_ID,
    });
    try {
      if (
        claim.readValueOrThrow(cell.getAsNormalizedFullLink()) === undefined
      ) {
        claim.abort();
        return undefined;
      }
      if (!cellHasOwnerProtection(claim, cell, this.conn.ownerDid)) {
        throw new Error(
          `refusing to trust an unprotected command receipt: ${commandId}`,
        );
      }
      cell.withTx(claim).applyCfcSchemaToExistingValue();
      claim.prepareCfc();
    } catch (error) {
      claim.abort(error);
      throw error;
    }
    const claimed = await claim.commit();
    if (claimed.error) {
      throw new Error(
        `could not verify command receipt ownership: ${claimed.error.message}`,
        { cause: claimed.error },
      );
    }
    const value = await readStableCellGraphValue(this.conn, cell);
    if (value === undefined || value === null) {
      throw new Error(
        `command receipt disappeared while reading: ${commandId}`,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`command receipt is not an object: ${commandId}`);
    }
    const receipt = parseCommandReceipt(commandId, value);
    if (receipt.ownerDid !== this.conn.ownerDid) {
      throw new Error(`command receipt belongs to another owner: ${commandId}`);
    }
    return receipt;
  }

  async subscribeCommands(
    callback: (commands: unknown[]) => void,
  ): Promise<Cancel> {
    this.#assertCommandCellBound();
    return await subscribeStableActions(
      this.conn,
      this.cells.commands,
      callback,
    );
  }

  async pollCommands(): Promise<unknown[]> {
    this.#assertCommandCellBound();
    return await readStableActions(this.conn, this.cells.commands);
  }

  publishReceipt(
    receipt: AgentSessionCommandReceipt,
  ): Promise<void> {
    return this.#mutations.run(() => {
      const parsed = parseCommandReceipt(receipt.commandId, receipt);
      if (parsed.ownerDid !== this.conn.ownerDid) {
        throw new Error(
          `command receipt belongs to another owner: ${receipt.commandId}`,
        );
      }
      return this.#publishReceipt(parsed);
    });
  }

  async #publishReceipt(
    receipt: AgentSessionCommandReceipt,
  ): Promise<void> {
    const cell = this.conn.runtime.getCell(
      this.conn.spaceDid,
      commandReceiptCause(
        this.conn.spaceDid,
        this.conn.ownerDid,
        receipt.commandId,
      ),
      agentOwnerSchema(this.conn.ownerDid),
    );
    const receiptPlan = await planStableArrayCells(
      receipt,
      childScope(this.conn.spaceDid, this.conn.ownerDid, "command-receipt", {
        commandId: receipt.commandId,
      }),
    );
    await pushStableCellGraph(
      this.conn,
      [graphEntry(cell, receiptPlan)],
    );
    const prior = await readStableCellGraphValue(
      this.conn,
      this.cells.receipts,
    );
    let priorReceipts: Array<Record<string, unknown>> = [];
    if (prior !== undefined && prior !== null) {
      priorReceipts = validatedReceiptIndexRows(this.conn, prior);
    }
    const receipts = priorReceipts
      .filter((item) =>
        item && typeof item === "object" &&
        (item as Record<string, unknown>).commandId !== receipt.commandId
      );
    receipts.push({
      commandId: receipt.commandId,
      ownerDid: receipt.ownerDid,
      sourceId: receipt.sourceId,
      nativeSessionId: receipt.nativeSessionId,
      status: receipt.status,
      updatedAt: receipt.completedAt ?? receipt.claimedAt ??
        new Date().toISOString(),
      ...(receipt.error ? { error: receipt.error } : {}),
      receipt: fullLink(cell),
    });
    const receiptIndexValue = {
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipts,
      ownerDid: this.conn.ownerDid,
      receipts: receipts.slice(-200),
      updatedAt: new Date().toISOString(),
    };
    const receiptIndexPlan = await planStableArrayCells(
      receiptIndexValue,
      childScope(
        this.conn.spaceDid,
        this.conn.ownerDid,
        "command-receipt-index",
      ),
    );
    await pushStableCellGraph(
      this.conn,
      [graphEntry(this.cells.receipts, receiptIndexPlan)],
    );
  }

  async refreshSession(
    driver: AgentDriver,
    nativeSessionId: string,
  ): Promise<void> {
    const observationSequence = this.beginSessionObservation();
    const snapshot = await driver.readSession(nativeSessionId);
    await this.publish(
      [{
        source: driver.source,
        sessions: [snapshot],
        errors: [],
        complete: false,
      }],
      { preserveUntouchedStatus: true, observationSequence },
    );
  }
}
