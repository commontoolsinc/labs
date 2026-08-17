import type { Cancel, Cell } from "@commonfabric/runner";
import {
  type AgentFabricConnection,
  pushStableCellGraph,
  readStableActions,
  readStableCellGraphValue,
  type StableCellGraphEntry,
  stableCellId,
  subscribeStableActions,
} from "./fabric-graph.ts";
import {
  commandReceiptCause,
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
import { GitContextResolver } from "./git-context.ts";
import {
  materializeStableArrayCells,
  planStableArrayCells,
  type StableArrayCellPlan,
} from "./array-cell-identity.ts";
import { AsyncSerialQueue } from "./serial-queue.ts";

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
}

interface CellLink {
  id: string;
  space: string;
  path: readonly (string | number)[];
}

interface IndexEntry {
  formatVersion: 1;
  key: string;
  sourceId: string;
  driver: string;
  nativeSessionId: string;
  title: string | null;
  cwd: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  gitWorktreeRoot: string | null;
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
  bucket?: "recent" | "all";
  generatedAt: string;
  generation: number;
  totalSessionCount?: number;
  olderSessionCount?: number;
  sources: Array<Record<string, unknown>>;
  // TODO(@ianh): Publish a shallow session directory with the row links and
  // sortable title, update-time, and worktree keys. Consumers cannot sort the
  // linked session rows globally without loading every row cell.
  sessions: IndexEntry[];
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

export function agentFabricCauses(spaceDid: string) {
  return {
    index: { spaceDid, agentConnector: "recent-session-index", version: 1 },
    allIndex: {
      spaceDid,
      agentConnector: "all-session-index",
      version: 1,
    },
    health: { spaceDid, agentConnector: "health", version: 1 },
    commands: { spaceDid, agentConnector: "commands", version: 1 },
    receipts: { spaceDid, agentConnector: "receipts", version: 1 },
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

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
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
  owner: string,
  identity?: Record<string, unknown>,
) {
  return {
    spaceDid,
    agentConnector: `${owner}-array-elements`,
    version: 1,
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
        commandId,
        sourceId: item.sourceId,
        nativeSessionId: item.nativeSessionId,
        status: item.status,
        ...(item.error === undefined ? {} : { error: item.error }),
      },
      `command receipt index row ${index}`,
    );
    if (!isIsoTimestamp(item.updatedAt)) {
      throw new Error(
        `command receipt index row updatedAt is invalid: ${index}`,
      );
    }
    const expectedLink = fullLink(
      conn.runtime.getCell(
        conn.spaceDid,
        commandReceiptCause(conn.spaceDid, commandId),
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
  const causes = agentFabricCauses(conn.spaceDid);
  return {
    index: conn.runtime.getCell(conn.spaceDid, causes.index),
    allIndex: conn.runtime.getCell(conn.spaceDid, causes.allIndex),
    health: conn.runtime.getCell(conn.spaceDid, causes.health),
    commands: conn.runtime.getCell(conn.spaceDid, causes.commands),
    receipts: conn.runtime.getCell(conn.spaceDid, causes.receipts),
  };
}

export async function ensureAgentFabricCells(
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

function asIndex(value: unknown): AgentSessionIndex | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("agent session index is not an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schema !== AGENT_CONNECTOR_SCHEMAS.sessionIndex ||
    !Array.isArray(record.sources) ||
    !Array.isArray(record.sessions)
  ) {
    throw new Error("agent session index has an invalid shape");
  }
  for (const [index, session] of record.sessions.entries()) {
    if (!isRecord(session) || session.formatVersion !== 1) {
      throw new Error(
        `agent session index row ${index} has an invalid formatVersion`,
      );
    }
    if (typeof session.driver !== "string" || session.driver.length === 0) {
      throw new Error(`agent session index row ${index} has no driver`);
    }
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
): Promise<PlannedSessionGraph> {
  const manifest = conn.runtime.getCell(
    conn.spaceDid,
    sessionCause(conn.spaceDid, prepared.sourceId, prepared.nativeSessionId),
  );
  const chunkEntries = await Promise.all(prepared.chunks.map(async (chunk) => {
    const cell = conn.runtime.getCell(
      conn.spaceDid,
      sessionChunkCause(
        conn.spaceDid,
        prepared.sourceId,
        prepared.nativeSessionId,
        chunk.part,
        chunk.contentHash,
      ),
    );
    const value = {
      schema: AGENT_CONNECTOR_SCHEMAS.sessionChunk,
      formatVersion: 1,
      key: prepared.key,
      part: chunk.part,
      contentHash: chunk.contentHash,
      events: chunk.events,
    };
    return {
      cell,
      plan: await planStableArrayCells(
        value,
        childScope(conn.spaceDid, "session-events", {
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
    formatVersion: 1,
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
    childScope(conn.spaceDid, "session", {
      sourceId: prepared.sourceId,
      nativeSessionId: prepared.nativeSessionId,
    }),
  );
  return {
    chunks: chunkEntries.map(({ cell, plan }) => graphEntry(cell, plan)),
    manifest: graphEntry(manifest, manifestPlan),
    indexEntry: {
      formatVersion: 1,
      key: prepared.key,
      sourceId: prepared.sourceId,
      driver,
      nativeSessionId: prepared.nativeSessionId,
      title: prepared.summary.title,
      cwd: prepared.summary.cwd,
      gitRepo: prepared.summary.gitRepo ?? null,
      gitBranch: prepared.summary.gitBranch ?? null,
      gitWorktreeRoot: prepared.summary.gitWorktreeRoot ?? null,
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

  async #publish(
    collected: CollectedSource[],
    options: AgentFabricPublishOptions & { observationSequence: number },
  ): Promise<number> {
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
    );
    const previousAll = asIndex(
      await readStableCellGraphValue(
        this.conn,
        this.cells.allIndex,
        graphReadCache,
        { preserveLinkFields: new Set(["manifest"]) },
      ),
    );
    const entriesByKey = new Map<string, IndexEntry>(
      [
        ...(previousRecent?.sessions ?? []),
        ...(previousAll?.sessions ?? []),
      ]
        .map((entry): [string, IndexEntry] => {
          const restored = {
            ...entry,
            archived: typeof entry.archived === "boolean"
              ? entry.archived
              : null,
            active: typeof entry.active === "boolean" ? entry.active : null,
            manifest: this.conn.runtime.getCell(
              this.conn.spaceDid,
              sessionCause(
                this.conn.spaceDid,
                entry.sourceId,
                entry.nativeSessionId,
              ),
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
      const batch = pendingGraphs;
      pendingGraphs = [];
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
          priorSourceRow?.capabilities &&
          typeof priorSourceRow.capabilities === "object"
        ? priorSourceRow.capabilities as DriverCapabilities
        : source.source.capabilities;
      if (!descriptorSuperseded) {
        observedDescriptorSourceIds.add(source.source.id);
      }
      const priorForSource = [...entriesByKey.values()].filter((entry) =>
        entry.sourceId === source.source.id
      );
      const currentKeys = new Set<string>();
      for (const snapshot of source.sessions) {
        const key = sessionKey(
          source.source.id,
          snapshot.summary.nativeSessionId,
        );
        currentKeys.add(key);
        if (isSuperseded(key)) continue;
        const prepared = await prepareSession(
          source.source.id,
          await gitContext.enrich(snapshot),
        );
        observedSessionKeys.add(prepared.key);
        const previousEntry = entriesByKey.get(prepared.key);
        if (
          previousEntry &&
          previousEntry.contentHash === prepared.snapshotHash &&
          previousEntry.driver === driver
        ) {
          const { deletedAt: _deletedAt, ...rest } = previousEntry;
          entriesByKey.set(prepared.key, {
            ...rest,
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
          driver,
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
    const recentIndex: AgentSessionIndex = {
      schema: AGENT_CONNECTOR_SCHEMAS.sessionIndex,
      bucket: "recent",
      generatedAt,
      generation,
      totalSessionCount: activeSessions.length,
      olderSessionCount: buckets.olderCount,
      sources,
      sessions: buckets.recent,
    };
    const allIndex: AgentSessionIndex = {
      schema: AGENT_CONNECTOR_SCHEMAS.sessionIndex,
      bucket: "all",
      generatedAt,
      generation,
      totalSessionCount: activeSessions.length,
      olderSessionCount: buckets.olderCount,
      sources,
      sessions: allSessions,
    };
    const indexChildScope = childScope(
      this.conn.spaceDid,
      "session-index",
    );
    const [recentIndexPlan, allIndexPlan] = await Promise.all([
      planStableArrayCells(recentIndex, indexChildScope),
      planStableArrayCells(allIndex, indexChildScope),
    ]);
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
    };
    const plan = await planStableArrayCells(
      healthValue,
      childScope(this.conn.spaceDid, "health"),
    );
    await pushStableCellGraph(
      this.conn,
      [graphEntry(this.cells.health, plan)],
    );
  }

  commandCellId(): string {
    return stableCellId(this.cells.commands);
  }

  receiptCellId(): string {
    return stableCellId(this.cells.receipts);
  }

  async readReceipt(
    commandId: string,
  ): Promise<AgentSessionCommandReceipt | undefined> {
    const cell = this.conn.runtime.getCell(
      this.conn.spaceDid,
      commandReceiptCause(this.conn.spaceDid, commandId),
    );
    const value = await readStableCellGraphValue(this.conn, cell);
    if (value === undefined || value === null) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`command receipt is not an object: ${commandId}`);
    }
    return parseCommandReceipt(commandId, value);
  }

  subscribeCommands(callback: (commands: unknown[]) => void): Promise<Cancel> {
    return subscribeStableActions(this.conn, this.cells.commands, callback);
  }

  pollCommands(): Promise<unknown[]> {
    return readStableActions(this.cells.commands);
  }

  publishReceipt(
    receipt: AgentSessionCommandReceipt,
  ): Promise<void> {
    return this.#mutations.run(() =>
      this.#publishReceipt(parseCommandReceipt(receipt.commandId, receipt))
    );
  }

  async #publishReceipt(
    receipt: AgentSessionCommandReceipt,
  ): Promise<void> {
    const cell = this.conn.runtime.getCell(
      this.conn.spaceDid,
      commandReceiptCause(this.conn.spaceDid, receipt.commandId),
    );
    const receiptPlan = await planStableArrayCells(
      receipt,
      childScope(this.conn.spaceDid, "command-receipt", {
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
      receipts: receipts.slice(-200),
      updatedAt: new Date().toISOString(),
    };
    const receiptIndexPlan = await planStableArrayCells(
      receiptIndexValue,
      childScope(this.conn.spaceDid, "command-receipt-index"),
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
