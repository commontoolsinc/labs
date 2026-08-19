import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import type {
  NativeSessionSnapshot,
  SourceDescriptor,
} from "@commonfabric/agents-connector/types";
import { isLinkRef, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { createSession, Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { pieceId } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  type Options,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import type { RawDataProvenance } from "../../patterns/agent-sessions-debug/main.tsx";
import { SESSION_PAGE_SIZE } from "../../patterns/agent-sessions-debug/presentation.ts";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import type { Cell } from "../../runner/src/builder/types.ts";
import {
  defaultDebugPatternLocation,
  deployAgentSessionsDebugView,
} from "../src/debug-view.ts";

const identity = await Identity.fromPassphrase(
  "agent sessions debug deployment test",
);
const EMULATED_AUDIENCE = "did:key:z6Mk-runner-emulated-memory";
const SHALLOW_PIECE_LIST_SCHEMA = internSchema({
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  default: [],
});
const SHALLOW_PIECE_SCHEMA = internSchema({
  type: "object",
  properties: {},
});
interface DebugArgumentSchema {
  $defs?: {
    SessionIndexInput?: {
      properties?: {
        sources?: { items?: CellBoundarySchema };
        sessions?: { items?: CellBoundarySchema };
      };
    };
    PublishedSessionInput?: {
      properties?: {
        active?: { anyOf?: Array<{ type?: string | string[] }> };
        archived?: { anyOf?: Array<{ type?: string | string[] }> };
      };
      required?: string[];
    };
  };
}

interface CellBoundarySchema {
  asCell?: string[];
  anyOf?: CellBoundarySchema[];
}

class SharedServerStorageManager extends EmulatedStorageManager {
  static override connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.#sharedServer = server;
    return manager;
  }

  #sharedServer!: MemoryV2Server.Server;

  protected override server(): MemoryV2Server.Server {
    return this.#sharedServer;
  }
}

class ObservedServer extends MemoryV2Server.Server {
  readonly returnedEntityIds: string[] = [];

  override async evaluateGraphQuery(
    ...args: Parameters<MemoryV2Server.Server["evaluateGraphQuery"]>
  ) {
    const result = await super.evaluateGraphQuery(...args);
    this.returnedEntityIds.push(...result.entities.map((entity) => entity.id));
    return result;
  }
}

function newSharedServer(): ObservedServer {
  return new ObservedServer({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: EMULATED_AUDIENCE },
  });
}

function sourceDescriptor(): SourceDescriptor {
  return {
    id: "codex:test",
    driver: "codex-app-server",
    capabilities: {
      inventory: true,
      read: true,
      prompt: true,
      cancel: true,
      rename: true,
      setMode: true,
      setConfigOption: false,
      modes: ["default", "plan"],
    },
  };
}

function sessionSnapshot(
  sequence = 1,
  titlePrefix = "Sharded session",
): NativeSessionSnapshot {
  const nativeSessionId = `session-${sequence}`;
  return {
    summary: {
      nativeSessionId,
      title: `${titlePrefix} ${sequence}`,
      cwd: "/worktree",
      gitRepo: "example/repo",
      gitBranch: "main",
      gitWorktreeRoot: "/worktree",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: new Date().toISOString(),
      archived: false,
      active: true,
      raw: { id: nativeSessionId, labels: ["debug"] },
    },
    events: [{ type: "message", content: [{ text: "hello" }] }],
    normalizedMessages: [{
      id: "message-1",
      role: "user",
      kind: "message",
      createdAt: "2026-07-20T00:00:00.000Z",
      textPreview: "hello",
      rawIndex: 0,
    }],
    complete: true,
    revision: "1",
  };
}

function countSessionRawDataLinks(
  value: unknown,
): number {
  const table = publishedSessionTable(value);
  return table === undefined ? 0 : cellLinkCells(table, "Raw data").length;
}

function materializeCell(value: unknown): unknown {
  if (
    typeof value === "object" && value !== null && "get" in value &&
    typeof (value as { get?: unknown }).get === "function"
  ) {
    return (value as { get: () => unknown }).get();
  }
  return value;
}

interface RenderedNode {
  name?: unknown;
  props?: Record<string, unknown>;
  children?: unknown;
}

function renderedNodes(
  value: unknown,
  result: RenderedNode[] = [],
  visited = new Set<object>(),
): RenderedNode[] {
  const materialized = materializeCell(value);
  if (typeof materialized !== "object" || materialized === null) return result;
  if (visited.has(materialized)) return result;
  visited.add(materialized);
  if (Array.isArray(materialized)) {
    for (const child of materialized) renderedNodes(child, result, visited);
    return result;
  }
  const node = materialized as RenderedNode;
  if (typeof node.name === "string") result.push(node);
  renderedNodes(node.children, result, visited);
  return result;
}

function renderedText(value: unknown, visited = new Set<object>()): string {
  const materialized = materializeCell(value);
  if (typeof materialized === "string" || typeof materialized === "number") {
    return String(materialized);
  }
  if (typeof materialized !== "object" || materialized === null) return "";
  if (visited.has(materialized)) return "";
  visited.add(materialized);
  if (Array.isArray(materialized)) {
    return materialized.map((child) => renderedText(child, visited)).join("");
  }
  return renderedText((materialized as RenderedNode).children, visited);
}

function publishedSessionTable(value: unknown): RenderedNode | undefined {
  return renderedNodes(value).find((node) =>
    node.name === "cf-table" &&
    renderedText(node.children).includes("Status") &&
    renderedText(node.children).includes("Idle for") &&
    renderedText(node.children).includes("Worktree")
  );
}

function publishedSessionTableRows(value: unknown): RenderedNode[] {
  const table = publishedSessionTable(value);
  return table === undefined
    ? []
    : renderedNodes(table.children).filter((node) => node.name === "tr");
}

function renderedTableCells(row: RenderedNode): string[] {
  return renderedNodes(row.children)
    .filter((node) => node.name === "td" || node.name === "th")
    .map((node) => renderedText(node.children));
}

function tableWithHeaders(
  value: unknown,
  expectedHeaders: string[],
): RenderedNode | undefined {
  return renderedNodes(value).find((node) => {
    if (node.name !== "cf-table") return false;
    const firstRow = renderedNodes(node.children).find((child) =>
      child.name === "tr"
    );
    if (firstRow === undefined) return false;
    const headers = renderedTableCells(firstRow);
    return headers.length === expectedHeaders.length &&
      headers.every((header, index) => header === expectedHeaders[index]);
  });
}

function tableRowWithFirstCell(
  table: RenderedNode,
  expected: string,
): RenderedNode | undefined {
  return renderedNodes(table.children)
    .filter((node) => node.name === "tr")
    .slice(1)
    .find((row) => renderedTableCells(row)[0] === expected);
}

function renderedAriaSortValues(row: RenderedNode): string[] {
  return renderedNodes(row.children)
    .filter((node) => node.name === "th")
    .map((node) => materializeCell(node.props?.["aria-sort"]))
    .filter((value): value is string => typeof value === "string");
}

function cellLinkIds(value: unknown, label: string): string[] {
  return cellLinkCells(value, label).flatMap((cell) => {
    const link = cell.resolveAsCell().getAsNormalizedFullLink();
    return [`${link.space}/${link.id}/${JSON.stringify(link.path)}`];
  });
}

function cellLinkCells(value: unknown, label: string): Cell<unknown>[] {
  return renderedNodes(value).flatMap((node) => {
    if (
      node.name !== "cf-cell-link" ||
      materializeCell(node.props?.label) !== label
    ) {
      return [];
    }
    const cell = node.props?.["$cell"] as Cell<unknown> | undefined;
    return typeof cell?.getAsNormalizedFullLink === "function" ? [cell] : [];
  });
}

async function loadRawDataView(
  runtime: Runtime,
  link: Cell<unknown>,
): Promise<unknown> {
  const view = link.resolveAsCell();
  await runtime.start(view);
  return await readRawDataView(runtime, view);
}

async function readRawDataView(
  runtime: Runtime,
  view: Cell<unknown>,
): Promise<unknown> {
  const ui = view.key("$UI");
  await ui.pull();
  await runtime.settled();
  await ui.pull();
  const pre = renderedNodes(ui.get()).find((node) => node.name === "pre");
  return JSON.parse(renderedText(pre?.children));
}

async function readRawDataProvenance(
  runtime: Runtime,
  link: Cell<unknown>,
): Promise<{ provenance: RawDataProvenance; rendered: string }> {
  const view = link.resolveAsCell();
  await view.pull();
  const ui = view.key("$UI");
  const provenance = view.key("provenance");
  await ui.pull();
  await provenance.pull();
  await runtime.settled();
  await ui.pull();
  await provenance.pull();
  return {
    provenance: provenance.get() as RawDataProvenance,
    rendered: renderedText(ui.get()),
  };
}

async function installDefaultPattern(
  manager: PiecesController,
): Promise<Cell<unknown>> {
  const { handler, pattern } = createBuilder().commonfabric;
  const addPiece = handler<
    { piece: Cell<unknown> },
    { allPieces: Cell<Cell<unknown>[]> }
  >(
    {
      type: "object",
      properties: {
        piece: { type: "unknown", asCell: ["cell"] },
      },
      required: ["piece"],
    },
    {
      type: "object",
      properties: {
        allPieces: {
          ...SHALLOW_PIECE_LIST_SCHEMA,
          asCell: ["cell"],
        },
      },
      required: ["allPieces"],
    },
    ({ piece }, { allPieces }) => {
      allPieces.push(piece);
    },
  );
  const defaultPattern = pattern<{
    allPieces: Cell<unknown>[];
    recentPieces: Cell<unknown>[];
  }>(
    ({ allPieces, recentPieces }) => ({
      allPieces,
      recentPieces,
      addPiece: addPiece({ allPieces }),
    }),
  );
  const piece = await manager.runPersistent(
    defaultPattern,
    { allPieces: [], recentPieces: [] },
    "agents-host-debug-test-default-pattern",
  );
  await manager.linkDefaultPattern(piece);
  await manager.runtime.idle();
  await manager.synced();
  return piece;
}

async function registeredPieceIds(
  defaultPattern: Cell<unknown>,
  name: "allPieces" | "recentPieces",
): Promise<string[]> {
  const slot = defaultPattern.asSchema(undefined).key(name);
  if (slot.getRaw() === undefined) return [];
  const list = slot.resolveAsCell().asSchema(
    SHALLOW_PIECE_LIST_SCHEMA,
  ) as Cell<Cell<unknown>[]>;
  await list.sync();
  return (list.get() ?? []).flatMap((piece) => {
    const id = pieceId(piece);
    return id ? [id] : [];
  });
}

async function deployDebugPiece(
  manager: PiecesController,
  target: AgentFabricTarget,
  cause?: string,
) {
  const location = defaultDebugPatternLocation();
  const program = await resolveLocalProgram(
    (resolver) => manager.runtime.harness.resolve(resolver),
    { main: location.mainPath, root: location.rootPath },
  );
  return await manager.create(
    program,
    {
      input: {
        recentIndex: target.cells.index,
        allIndex: target.cells.allIndex,
        health: target.cells.health,
        commands: target.cells.commands,
        receipts: target.cells.receipts,
        recentIndexCell: target.cells.index,
        allIndexCell: target.cells.allIndex,
        healthCell: target.cells.health,
        commandsCell: target.cells.commands,
        receiptsCell: target.cells.receipts,
      },
    },
    cause,
  );
}

async function deployRawDataPiece(
  manager: PiecesController,
  manifest: AgentFabricTarget["cells"]["index"],
) {
  const location = defaultDebugPatternLocation();
  const program = await resolveLocalProgram(
    (resolver) => manager.runtime.harness.resolve(resolver),
    {
      main: fromFileUrl(
        new URL("./fixtures/raw-session-view.tsx", import.meta.url),
      ),
      root: location.rootPath,
    },
  );
  return await manager.create(program, {
    input: {
      manifest,
      sourceId: "codex:test",
      nativeSessionId: "session-1",
    },
  });
}

Deno.test("debug pattern accepts empty target cells before collection", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-empty-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const piece = await deployDebugPiece(manager, target);

    assertEquals(typeof piece.id, "string");
    assertEquals(
      JSON.stringify(manager.getArgument(piece.getCell()).getRaw()).includes(
        "SessionIndexInput",
      ),
      false,
    );
    const argumentSchema = manager.getArgument(piece.getCell())
      .getAsNormalizedFullLink().schema as DebugArgumentSchema;
    for (const field of ["sources", "sessions"] as const) {
      const item = argumentSchema.$defs?.SessionIndexInput?.properties?.[field]
        ?.items;
      assertEquals(
        item?.asCell?.includes("opaque"),
        true,
      );
      assertEquals(
        item?.anyOf,
        undefined,
      );
    }
    for (const field of ["active", "archived"] as const) {
      const alternatives = argumentSchema.$defs?.PublishedSessionInput
        ?.properties?.[field]?.anyOf ?? [];
      assertEquals(
        alternatives.some((schema) =>
          schema.type === "null" ||
          (Array.isArray(schema.type) && schema.type.includes("null"))
        ),
        true,
      );
    }
    assertEquals(
      argumentSchema.$defs?.PublishedSessionInput?.required?.includes(
        "driver",
      ) ?? false,
      false,
    );
    assertEquals(piece.name(), "Agent sessions");
    assertEquals(await piece.result.get(["sourceCount"]), 0);
    assertEquals(await piece.result.get(["sessionCount"]), 0);
    assertEquals(await piece.result.get(["activityCount"]), 0);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug pattern renders sessions published after deployment", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-publish-after-deploy-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const piece = await deployDebugPiece(manager, target);
    const snapshot = sessionSnapshot();
    snapshot.summary.archived = null;
    snapshot.summary.active = null;
    snapshot.normalizedMessages[0].createdAt = null;
    snapshot.normalizedMessages[0].textPreview = null;
    const source = sourceDescriptor();
    source.id = "claude";
    source.driver = "claude-agent-sdk";
    source.capabilities.modes = [
      "default",
      "acceptEdits",
      "plan",
      "dontAsk",
      "auto",
    ];
    source.capabilities.configOptions = {
      model: { type: "string" },
    };

    await target.publish([{
      source,
      sessions: [snapshot],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();

    const result = await piece.result.get() as Record<string, unknown>;
    assertEquals(await piece.result.get(["sessionCount"]), 1);
    assertEquals(countSessionRawDataLinks(result["$UI"]), 1);
    assertEquals(
      renderedNodes(result["$UI"]).some((node) =>
        node.name === "cf-badge" && renderedText(node.children) === "unknown"
      ),
      true,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug pattern submits commands and links row data to separate views", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-command-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const source = sourceDescriptor();
    const snapshot = sessionSnapshot();
    await target.publish([{
      source,
      sessions: [snapshot],
      errors: [],
      complete: true,
    }]);
    const firstActivity = {
      id: "activity-1",
      at: "2026-07-20T00:01:00.000Z",
      type: "host-started",
      message: "Host startup completed",
      details: {
        phase: "startup",
        sessionCount: 1,
        capabilities: ["read", "write"],
      },
    };
    const health = {
      service: "agents-host",
      formatVersion: 1,
      status: "ready",
      startedAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:01:00.000Z",
      target: {
        spaceDid: session.space,
        cells: {
          recentIndex: "recent-index",
          allIndex: "all-index",
          health: "health",
          commands: "commands",
          receipts: "receipts",
        },
      },
      commandProcessing: {
        accepting: true,
        pendingReceiptPublications: 0,
        failedCommands: 0,
      },
      sources: [{
        ...source,
        status: "ready",
        sessionCount: 1,
        complete: true,
        errors: [],
      }],
      activity: [firstActivity],
    };
    await target.publishHealth(health);
    const piece = await deployDebugPiece(manager, target);
    await runtime.settled();

    let result = await piece.result.get() as Record<string, unknown>;
    const commandButton = renderedNodes(result["$UI"]).find((node) =>
      node.name === "cf-button" && renderedText(node.children) === "Command"
    );
    const selectTarget = materializeCell(commandButton?.props?.onClick);
    assertEquals(
      typeof (selectTarget as { send?: unknown } | undefined)?.send,
      "function",
    );
    (selectTarget as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    result = await piece.result.get() as Record<string, unknown>;
    const form = renderedNodes(result["$UI"]).find((node) =>
      node.name === "cf-form"
    );
    const prompt = renderedNodes(form?.children).find((node) =>
      node.name === "cf-textarea"
    );
    const promptCell = prompt?.props?.["$value"];
    assertEquals(
      typeof (promptCell as { set?: unknown } | undefined)?.set,
      "function",
    );
    const promptTx = runtime.edit();
    (promptCell as Cell<string>).withTx(promptTx).set(
      "Continue from the deployed debug view",
    );
    const promptCommit = await promptTx.commit();
    if (promptCommit.error) throw promptCommit.error;
    await runtime.settled();

    const review = materializeCell(form?.props?.["oncf-submit"]);
    assertEquals(
      typeof (review as { send?: unknown } | undefined)?.send,
      "function",
    );
    (review as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    result = await piece.result.get() as Record<string, unknown>;
    const modal = renderedNodes(result["$UI"]).find((node) =>
      node.name === "cf-modal"
    );
    assertEquals(materializeCell(modal?.props?.["$open"]), true);
    const sendButton = renderedNodes(result["$UI"]).find((node) =>
      node.name === "cf-button" &&
      renderedText(node.children) === "Send command"
    );
    const send = materializeCell(sendButton?.props?.onClick);
    assertEquals(
      typeof (send as { send?: unknown } | undefined)?.send,
      "function",
    );
    (send as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    const actionValues = await target.pollCommands();
    assertEquals(actionValues.length, 1);
    assertEquals(typeof actionValues[0], "string");
    const command = JSON.parse(String(actionValues[0]));
    assertEquals(command.schema, "commonfabric.agent-connector.command.v1");
    assertEquals(command.sourceId, source.id);
    assertEquals(
      command.nativeSessionId,
      snapshot.summary.nativeSessionId,
    );
    assertEquals(command.type, "prompt");
    assertEquals(
      command.payload,
      { text: "Continue from the deployed debug view" },
    );

    await target.publishReceipt({
      schema: "commonfabric.agent-connector.command-receipt.v1",
      commandId: command.id,
      sourceId: source.id,
      nativeSessionId: snapshot.summary.nativeSessionId,
      status: "in-flight",
      claimedAt: "2026-07-20T00:02:00.000Z",
    });
    await runtime.settled();

    result = await piece.result.get() as Record<string, unknown>;
    const commandTable = tableWithHeaders(result["$UI"], [
      "ID",
      "Source",
      "Session",
      "Type",
      "Created",
      "Payload",
    ]);
    const receiptTable = tableWithHeaders(result["$UI"], [
      "Command",
      "Source",
      "Session",
      "Status",
      "Updated",
      "Details",
    ]);
    const activityTable = tableWithHeaders(result["$UI"], [
      "Time",
      "Type",
      "Source",
      "Message",
      "Details",
    ]);
    assertEquals(commandTable !== undefined, true);
    assertEquals(receiptTable !== undefined, true);
    assertEquals(activityTable !== undefined, true);

    for (const table of [commandTable!, receiptTable!, activityTable!]) {
      assertEquals(
        renderedNodes(table.children).some((node) => node.name === "details"),
        false,
      );
      assertEquals(cellLinkCells(table, "Raw data").length, 1);
    }

    const commandRawLink = cellLinkCells(commandTable, "Raw data")[0];
    assertEquals(
      await loadRawDataView(runtime, commandRawLink),
      { text: "Continue from the deployed debug view" },
    );
    const commandProvenance = await readRawDataProvenance(
      runtime,
      commandRawLink,
    );
    assertEquals(commandProvenance.provenance.fabric.space, session.space);
    assertEquals(
      commandProvenance.provenance.fabric.entity.includes(
        target.commandCellId(),
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.origin.includes(
        "shared commands cell",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.processing.includes(
        "JSON-decodes string action values",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.retrievalCommand.includes(
        "cf inspect value-at",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.retrievalCommand.includes(
        "Recursively run the commands below for every $link",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.retrievalCommand.includes(
        "--seq REVISION_SEQ",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.retrievalCommand.includes(
        "--seq LINK_REVISION_SEQ",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.retrievalCommand.includes(
        "A missing space uses the containing space",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.retrievalCommand.includes(
        "--scope 'LINK_SCOPE_KEY'",
      ),
      true,
    );
    assertEquals(
      commandProvenance.provenance.retrievalCommand.includes(
        "--scope '<resolved $link.scope>'",
      ),
      false,
    );
    assertEquals(
      commandProvenance.rendered.includes("Where this data comes from"),
      true,
    );

    const receiptRow = tableRowWithFirstCell(receiptTable!, command.id)!;
    const receiptRawLink = cellLinkCells(receiptRow, "Raw data")[0];
    const receiptRawLinkId = cellLinkIds(receiptRow, "Raw data")[0];
    const initialReceiptDetails = await loadRawDataView(
      runtime,
      receiptRawLink,
    ) as Record<string, unknown>;
    assertEquals(initialReceiptDetails.error, undefined);
    assertEquals(
      typeof (initialReceiptDetails.receipt as Record<string, unknown>).id,
      "string",
    );
    const receiptProvenance = await readRawDataProvenance(
      runtime,
      receiptRawLink,
    );
    assertEquals(receiptProvenance.provenance.fabric.space, session.space);
    assertEquals(
      receiptProvenance.provenance.origin.includes(
        "publishReceipt()",
      ),
      true,
    );
    assertEquals(
      receiptProvenance.provenance.retrievalCommand.includes(
        "# The row's receipt field points to the complete receipt document:",
      ),
      true,
    );
    assertEquals(
      receiptProvenance.provenance.retrievalCommand.includes(
        "--seq RECEIPT_REVISION_SEQ",
      ),
      true,
    );
    assertEquals(
      receiptProvenance.rendered.includes("Retrieve it independently"),
      true,
    );

    const activityRow = tableRowWithFirstCell(
      activityTable!,
      firstActivity.at,
    )!;
    const activityRawLink = cellLinkCells(activityRow, "Raw data")[0];
    const activityRawLinkId = cellLinkIds(activityRow, "Raw data")[0];
    assertEquals(
      await loadRawDataView(runtime, activityRawLink),
      firstActivity.details,
    );
    const activityProvenance = await readRawDataProvenance(
      runtime,
      activityRawLink,
    );
    assertEquals(activityProvenance.provenance.fabric.space, session.space);
    assertEquals(
      activityProvenance.provenance.origin.includes(
        "bounded in-memory activity list",
      ),
      true,
    );
    assertEquals(
      activityProvenance.provenance.processing.includes(
        "only the activity record's details field",
      ),
      true,
    );
    assertEquals(
      activityProvenance.provenance.retrievalCommand.includes(
        "Recursively run the commands below for every $link",
      ),
      true,
    );
    assertEquals(
      activityProvenance.provenance.retrievalCommand.includes(
        "--seq REVISION_SEQ",
      ),
      true,
    );
    assertEquals(
      activityProvenance.provenance.retrievalCommand.includes(
        "--seq LINK_REVISION_SEQ",
      ),
      true,
    );

    await target.publishReceipt({
      schema: "commonfabric.agent-connector.command-receipt.v1",
      commandId: "other-command",
      sourceId: source.id,
      nativeSessionId: snapshot.summary.nativeSessionId,
      status: "succeeded",
      completedAt: "2026-07-20T00:03:00.000Z",
    });
    await target.publishReceipt({
      schema: "commonfabric.agent-connector.command-receipt.v1",
      commandId: command.id,
      sourceId: source.id,
      nativeSessionId: snapshot.summary.nativeSessionId,
      status: "failed",
      completedAt: "2026-07-20T00:04:00.000Z",
      error: {
        code: "provider-error",
        message: "Provider rejected the command",
        retryable: false,
      },
    });
    const updatedActivityDetails = {
      phase: "ready",
      sessionCount: 2,
    };
    await target.publishHealth({
      ...health,
      updatedAt: "2026-07-20T00:05:00.000Z",
      activity: [{
        id: "activity-2",
        at: "2026-07-20T00:05:00.000Z",
        type: "collection-completed",
        message: "Collection completed",
        details: { sessionCount: 2 },
      }, {
        ...firstActivity,
        details: updatedActivityDetails,
      }],
    });
    await runtime.settled();

    result = await piece.result.get() as Record<string, unknown>;
    const updatedReceiptTable = tableWithHeaders(result["$UI"], [
      "Command",
      "Source",
      "Session",
      "Status",
      "Updated",
      "Details",
    ])!;
    const updatedActivityTable = tableWithHeaders(result["$UI"], [
      "Time",
      "Type",
      "Source",
      "Message",
      "Details",
    ])!;
    const updatedReceiptRow = tableRowWithFirstCell(
      updatedReceiptTable,
      command.id,
    )!;
    const updatedActivityRow = tableRowWithFirstCell(
      updatedActivityTable,
      firstActivity.at,
    )!;
    assertEquals(renderedTableCells(updatedReceiptRow)[3], "failed");
    assertEquals(
      cellLinkIds(updatedReceiptRow, "Raw data")[0],
      receiptRawLinkId,
    );
    assertEquals(
      cellLinkIds(updatedActivityRow, "Raw data")[0],
      activityRawLinkId,
    );

    const updatedReceiptDetails = await loadRawDataView(
      runtime,
      cellLinkCells(updatedReceiptRow, "Raw data")[0],
    ) as Record<string, unknown>;
    assertEquals(updatedReceiptDetails.error, {
      code: "provider-error",
      message: "Provider rejected the command",
      retryable: false,
    });
    assertEquals(
      typeof (updatedReceiptDetails.receipt as Record<string, unknown>).id,
      "string",
    );
    assertEquals(
      await loadRawDataView(
        runtime,
        cellLinkCells(updatedActivityRow, "Raw data")[0],
      ),
      updatedActivityDetails,
    );

    const pageCommands = Array.from(
      { length: 25 },
      (_, index) =>
        JSON.stringify({
          ...command,
          id: `page-command-${index}`,
          createdAt: `2026-07-20T00:${String(index).padStart(2, "0")}:00.000Z`,
          payload: { sequence: index },
        }),
    );
    let commandTx = runtime.edit();
    target.cells.commands.withTx(commandTx).set(pageCommands);
    let commandCommit = await commandTx.commit();
    if (commandCommit.error) throw commandCommit.error;
    await runtime.settled();

    result = await piece.result.get() as Record<string, unknown>;
    const fullCommandPage = tableWithHeaders(result["$UI"], [
      "ID",
      "Source",
      "Session",
      "Type",
      "Created",
      "Payload",
    ])!;
    assertEquals(cellLinkCells(fullCommandPage, "Raw data").length, 25);
    const shiftedCommandRow = tableRowWithFirstCell(
      fullCommandPage,
      "page-command-1",
    )!;
    const shiftedCommandLinkId = cellLinkIds(
      shiftedCommandRow,
      "Raw data",
    )[0];

    commandTx = runtime.edit();
    target.cells.commands.withTx(commandTx).set([
      ...pageCommands,
      JSON.stringify({
        ...command,
        id: "page-command-25",
        createdAt: "2026-07-20T00:25:00.000Z",
        payload: { sequence: 25 },
      }),
    ]);
    commandCommit = await commandTx.commit();
    if (commandCommit.error) throw commandCommit.error;
    await runtime.settled();

    result = await piece.result.get() as Record<string, unknown>;
    const shiftedCommandPage = tableWithHeaders(result["$UI"], [
      "ID",
      "Source",
      "Session",
      "Type",
      "Created",
      "Payload",
    ])!;
    assertEquals(cellLinkCells(shiftedCommandPage, "Raw data").length, 25);
    const shiftedCommandRowAfterAppend = tableRowWithFirstCell(
      shiftedCommandPage,
      "page-command-1",
    )!;
    assertEquals(
      cellLinkIds(shiftedCommandRowAfterAppend, "Raw data")[0],
      shiftedCommandLinkId,
    );
    assertEquals(
      await loadRawDataView(
        runtime,
        cellLinkCells(shiftedCommandRowAfterAppend, "Raw data")[0],
      ),
      { sequence: 1 },
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug pattern bounds raw-data links to one session page", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-session-page-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const trailingSessionCount = 5;
  const sessionCount = SESSION_PAGE_SIZE * 3 + trailingSessionCount;
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    await target.publish([{
      source: sourceDescriptor(),
      sessions: Array.from(
        { length: sessionCount },
        (_, index) =>
          sessionSnapshot(
            index + 1,
            index < SESSION_PAGE_SIZE + 5
              ? "Selected session"
              : "Other session",
          ),
      ),
      errors: [],
      complete: true,
    }]);
    const recentIndexValue = target.cells.index.getRaw();
    const firstIndexSession = recentIndexValue &&
        typeof recentIndexValue === "object" &&
        !Array.isArray(recentIndexValue) &&
        "sessions" in recentIndexValue &&
        Array.isArray(recentIndexValue.sessions)
      ? recentIndexValue.sessions[0]
      : undefined;
    if (!isLinkRef(firstIndexSession)) {
      throw new Error("recent index session row link is missing");
    }
    // Represent a publication that wrote the manifest before its replacement
    // index row.
    const staleIndexRow = runtime.getCellFromLink({
      ...linkRefPayload(firstIndexSession),
      space: session.space,
      path: [],
    });
    const staleIndexTx = runtime.edit();
    staleIndexRow.withTx(staleIndexTx).key("driver").set(
      "claude-agent-sdk",
    );
    const staleIndexCommit = await staleIndexTx.commit();
    if (staleIndexCommit.error) throw staleIndexCommit.error;
    const piece = await deployDebugPiece(manager, target);
    await runtime.settled();

    assertEquals(
      await piece.result.get(["sessionCount"]),
      sessionCount,
    );
    let result = await piece.result.get();
    const firstPageRows = publishedSessionTableRows(
      (result as Record<string, unknown>)["$UI"],
    );
    assertEquals(
      renderedTableCells(firstPageRows[0]),
      [
        "Source",
        "Title ↕",
        "Status",
        "Sync",
        "Idle for ↕",
        "Worktree ↕",
        "Data",
      ],
    );
    assertEquals(renderedAriaSortValues(firstPageRows[0]), []);
    const initialTitles = firstPageRows.slice(1).map((row) =>
      renderedTableCells(row)[1]
    );
    const openedRawSessionLink = cellLinkCells(
      (result as Record<string, unknown>)["$UI"],
      "Raw data",
    )[0];
    assertEquals(openedRawSessionLink !== undefined, true);
    const openedRawSession = openedRawSessionLink.resolveAsCell();
    await runtime.start(openedRawSession);
    await openedRawSession.pull();
    const titleSortButton = renderedNodes(
      (result as Record<string, unknown>)["$UI"],
    ).find((node) =>
      node.name === "cf-button" && renderedText(node.children) === "Title ↕"
    );
    const titleSort = materializeCell(titleSortButton?.props?.onClick);
    assertEquals(
      typeof (titleSort as { send?: unknown } | undefined)?.send,
      "function",
    );
    (titleSort as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    result = await piece.result.get();
    assertEquals(
      renderedAriaSortValues(
        publishedSessionTableRows(
          (result as Record<string, unknown>)["$UI"],
        )[0],
      ),
      ["ascending"],
    );
    const ascendingTitleButton = renderedNodes(
      (result as Record<string, unknown>)["$UI"],
    ).find((node) =>
      node.name === "cf-button" && renderedText(node.children) === "Title ↑"
    );
    const descendingTitleSort = materializeCell(
      ascendingTitleButton?.props?.onClick,
    );
    assertEquals(
      typeof (descendingTitleSort as { send?: unknown } | undefined)?.send,
      "function",
    );
    (descendingTitleSort as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    result = await piece.result.get();
    assertEquals(
      renderedAriaSortValues(
        publishedSessionTableRows(
          (result as Record<string, unknown>)["$UI"],
        )[0],
      ),
      ["descending"],
    );
    assertEquals(
      publishedSessionTableRows(
        (result as Record<string, unknown>)["$UI"],
      ).slice(1).map((row) => renderedTableCells(row)[1]),
      initialTitles.toSorted((left, right) =>
        right.localeCompare(left, undefined, {
          numeric: true,
          sensitivity: "base",
        })
      ),
    );
    const firstPageLinkIds = cellLinkIds(
      (result as Record<string, unknown>)["$UI"],
      "Raw data",
    );
    const firstPageRunnerCount = runtime.runner.cancels.size;
    assertEquals(
      countSessionRawDataLinks((result as Record<string, unknown>)["$UI"]),
      SESSION_PAGE_SIZE,
    );
    assertEquals(firstPageLinkIds.length, SESSION_PAGE_SIZE);
    const nextButton = renderedNodes(
      (result as Record<string, unknown>)["$UI"],
    ).find((node) =>
      node.name === "cf-button" && renderedText(node.children) === "Next"
    );
    const nextPage = materializeCell(nextButton?.props?.onClick);
    assertEquals(
      typeof (nextPage as { send?: unknown } | undefined)?.send,
      "function",
    );
    (nextPage as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    const secondResult = await piece.result.get();
    const secondPageLinkIds = cellLinkIds(
      (secondResult as Record<string, unknown>)["$UI"],
      "Raw data",
    );
    assertEquals(
      countSessionRawDataLinks(
        (secondResult as Record<string, unknown>)["$UI"],
      ),
      SESSION_PAGE_SIZE,
    );
    assertNotEquals(secondPageLinkIds, firstPageLinkIds);
    const firstPageIds = new Set(firstPageLinkIds);
    assertEquals(
      secondPageLinkIds.every((id) => !firstPageIds.has(id)),
      true,
    );
    const secondPageRunnerCount = runtime.runner.cancels.size;
    assertEquals(secondPageRunnerCount > firstPageRunnerCount, true);
    openedRawSession.key("load").send({});
    await runtime.settled();
    await openedRawSession.pull();
    const openedRawSessionJson = JSON.parse(
      String(openedRawSession.key("rawJson").get()),
    );
    assertEquals(openedRawSessionJson.manifest.nativeSessionId, "session-1");
    const sessionRawSource = await readRawDataProvenance(
      runtime,
      openedRawSessionLink,
    );
    assertEquals(sessionRawSource.provenance.fabric.space, session.space);
    assertEquals(
      sessionRawSource.provenance.origin.includes(
        'connector source "codex:test"',
      ),
      true,
    );
    assertEquals(
      sessionRawSource.provenance.providerRetrieval?.includes(
        'producing driver "codex-app-server"',
      ),
      true,
    );
    assertEquals(
      sessionRawSource.provenance.providerRetrieval?.includes(
        '"threadId":"session-1"',
      ),
      true,
    );
    (nextPage as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    const thirdResult = await piece.result.get();
    const thirdPageLinkIds = cellLinkIds(
      (thirdResult as Record<string, unknown>)["$UI"],
      "Raw data",
    );
    assertEquals(
      countSessionRawDataLinks(
        (thirdResult as Record<string, unknown>)["$UI"],
      ),
      SESSION_PAGE_SIZE,
    );
    assertEquals(thirdPageLinkIds.length, SESSION_PAGE_SIZE);
    const thirdPageRunnerCount = runtime.runner.cancels.size;
    assertEquals(thirdPageRunnerCount < secondPageRunnerCount, true);
    (nextPage as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    const lastResult = await piece.result.get();
    assertEquals(
      countSessionRawDataLinks((lastResult as Record<string, unknown>)["$UI"]),
      trailingSessionCount,
    );
    const filterInput = renderedNodes(
      (lastResult as Record<string, unknown>)["$UI"],
    ).find((node) => node.name === "cf-input");
    const filter = filterInput?.props?.["$value"];
    assertEquals(
      typeof (filter as { set?: unknown } | undefined)?.set,
      "function",
    );
    const filterTx = runtime.edit();
    (filter as Cell<string>).withTx(filterTx).set("No matching session");
    await filterTx.commit();
    await runtime.settled();

    const filteredResult = await piece.result.get();
    assertEquals(
      countSessionRawDataLinks(
        (filteredResult as Record<string, unknown>)["$UI"],
      ),
      0,
    );
    const previousButton = renderedNodes(
      (filteredResult as Record<string, unknown>)["$UI"],
    ).find((node) =>
      node.name === "cf-button" && renderedText(node.children) === "Previous"
    );
    const previousPage = materializeCell(previousButton?.props?.onClick);
    assertEquals(
      typeof (previousPage as { send?: unknown } | undefined)?.send,
      "function",
    );
    (previousPage as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    const previousResult = await piece.result.get();
    assertEquals(
      countSessionRawDataLinks(
        (previousResult as Record<string, unknown>)["$UI"],
      ),
      0,
    );
    const clearFilterTx = runtime.edit();
    (filter as Cell<string>).withTx(clearFilterTx).set("");
    await clearFilterTx.commit();
    await runtime.settled();

    const unfilteredResult = await piece.result.get();
    assertEquals(
      countSessionRawDataLinks(
        (unfilteredResult as Record<string, unknown>)["$UI"],
      ),
      SESSION_PAGE_SIZE,
    );
    const firstPageButton = renderedNodes(
      (unfilteredResult as Record<string, unknown>)["$UI"],
    ).find((node) =>
      node.name === "cf-button" && renderedText(node.children) === "Previous"
    );
    const firstPage = materializeCell(firstPageButton?.props?.onClick);
    assertEquals(
      typeof (firstPage as { send?: unknown } | undefined)?.send,
      "function",
    );
    (firstPage as { send: (event: unknown) => void }).send({});
    await runtime.settled();
    (firstPage as { send: (event: unknown) => void }).send({});
    await runtime.settled();

    const returnedResult = await piece.result.get();
    assertEquals(
      cellLinkIds(
        (returnedResult as Record<string, unknown>)["$UI"],
        "Raw data",
      ),
      firstPageLinkIds,
    );
    assertEquals(runtime.runner.cancels.size < thirdPageRunnerCount, true);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment replaces a view when its pattern identity changes", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-pattern-replacement-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const defaultLocation = defaultDebugPatternLocation();
    const alternateLocation = {
      rootPath: defaultLocation.rootPath,
      mainPath: fromFileUrl(
        new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
      ),
    };
    const [originalPieceId, alternatePieceId] = await Promise.all([
      deployAgentSessionsDebugView(manager, target),
      deployAgentSessionsDebugView(manager, target, alternateLocation),
    ]);

    assertNotEquals(alternatePieceId, originalPieceId);
    assertEquals(
      await deployAgentSessionsDebugView(
        manager,
        target,
        alternateLocation,
      ),
      alternatePieceId,
    );
    const allIds = await registeredPieceIds(defaultPattern, "allPieces");
    assertEquals(allIds.includes(originalPieceId), false);
    assertEquals(allIds.filter((id) => id === alternatePieceId).length, 1);
    const originalPiece = await manager.getPieceCell(
      originalPieceId,
      false,
      SHALLOW_PIECE_SCHEMA,
    );
    assertNotEquals(originalPiece.getRaw(), undefined);
    assertNotEquals(originalPiece.getMetaRaw("patternIdentity"), undefined);
    const alternatePiece = await manager.get(
      alternatePieceId,
      false,
    );
    assertEquals(alternatePiece.name(), "Alternate agent sessions");
    const reinsertResult = await runtime.editWithRetry((tx) => {
      for (const name of ["allPieces", "recentPieces"] as const) {
        const list = defaultPattern.asSchema(undefined).key(name)
          .resolveAsCell().asSchema(SHALLOW_PIECE_LIST_SCHEMA) as Cell<
            Cell<unknown>[]
          >;
        const listWithTx = list.withTx(tx);
        const current = listWithTx.getRawUntyped({ frozen: false });
        if (!Array.isArray(current)) throw new Error(`${name} is not an array`);
        current.push(originalPiece.getAsLink({
          base: listWithTx,
          includeSchema: true,
        }));
        listWithTx.setRawUntyped(current);
      }
    });
    if (reinsertResult.error) throw reinsertResult.error;
    assertEquals(
      await deployAgentSessionsDebugView(manager, target, alternateLocation),
      alternatePieceId,
    );
    for (const name of ["allPieces", "recentPieces"] as const) {
      assertEquals(
        (await registeredPieceIds(defaultPattern, name)).includes(
          originalPieceId,
        ),
        false,
      );
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment starts and restarts its registered view", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-start-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const debugPieceId = await deployAgentSessionsDebugView(manager, target);
    const piece = await manager.get(debugPieceId, false);

    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    assertEquals(await piece.result.get(["sessionCount"]), 1);

    await manager.stopPiece(piece.getCell());
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1), sessionSnapshot(2)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    assertEquals(await piece.result.get(["sessionCount"]), 1);

    assertEquals(
      await deployAgentSessionsDebugView(manager, target),
      debugPieceId,
    );
    await runtime.settled();
    assertEquals(await piece.result.get(["sessionCount"]), 2);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment removes a view that fails to start", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-start-failure-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const originalStartPiece = manager.startPiece;
    manager.startPiece = (() =>
      Promise.reject(
        new Error("debug start rejected"),
      )) as typeof manager.startPiece;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target),
        Error,
        "debug start rejected",
      );
    } finally {
      manager.startPiece = originalStartPiece;
    }

    assertEquals(await registeredPieceIds(defaultPattern, "allPieces"), []);
    assertEquals(await registeredPieceIds(defaultPattern, "recentPieces"), []);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment preserves a view when its replacement fails", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-replacement-start-failure-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const originalPieceId = await deployAgentSessionsDebugView(
      manager,
      target,
    );
    const defaultLocation = defaultDebugPatternLocation();
    const alternateLocation = {
      rootPath: defaultLocation.rootPath,
      mainPath: fromFileUrl(
        new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
      ),
    };
    const originalStartPiece = manager.startPiece;
    manager.startPiece = (() =>
      Promise.reject(
        new Error("replacement start rejected"),
      )) as typeof manager.startPiece;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target, alternateLocation),
        Error,
        "replacement start rejected",
      );
    } finally {
      manager.startPiece = originalStartPiece;
    }

    assertEquals(
      await registeredPieceIds(defaultPattern, "allPieces"),
      [originalPieceId],
    );
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    const originalPiece = await manager.get(originalPieceId, false);
    assertEquals(await originalPiece.result.get(["sessionCount"]), 1);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug replacement stops every superseded local runner", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-stop-failures-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const originalPieceId = await deployAgentSessionsDebugView(manager, target);
    const registration = runtime.getCell(
      session.space,
      "agent-sessions-debug-registration-v1",
    );
    await registration.sync();
    const addRetiredResult = await runtime.editWithRetry((tx) => {
      const cell = registration.withTx(tx);
      const current = cell.getRawUntyped({ frozen: false });
      if (typeof current !== "object" || current === null) {
        throw new Error("debug registration is missing");
      }
      cell.setRawUntyped({
        ...current,
        retiredCauses: ["agent-sessions-debug:retired-test-piece"],
      });
    });
    if (addRetiredResult.error) throw addRetiredResult.error;

    const originalStop = runtime.runner.stop;
    let stopCalls = 0;
    runtime.runner.stop = ((piece) => {
      stopCalls++;
      originalStop.call(runtime.runner, piece);
      if (stopCalls === 1) {
        throw new Error("retired runner cancellation failed");
      }
    }) as typeof runtime.runner.stop;
    try {
      const defaultLocation = defaultDebugPatternLocation();
      await assertRejects(
        () =>
          deployAgentSessionsDebugView(manager, target, {
            rootPath: defaultLocation.rootPath,
            mainPath: fromFileUrl(
              new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
            ),
          }),
        AggregateError,
        "debug view runner cleanup failed",
      );
    } finally {
      runtime.runner.stop = originalStop;
    }

    assertEquals(stopCalls, 2);
    assertEquals(
      (await registeredPieceIds(defaultPattern, "allPieces")).includes(
        originalPieceId,
      ),
      false,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment rolls back an aborted registration", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-aborted-registration-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const originalPieceId = await deployAgentSessionsDebugView(
      manager,
      target,
    );
    const defaultLocation = defaultDebugPatternLocation();
    const alternateLocation = {
      rootPath: defaultLocation.rootPath,
      mainPath: fromFileUrl(
        new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
      ),
    };
    const recentPieces = defaultPattern.asSchema(undefined)
      .key("recentPieces")
      .resolveAsCell();
    const abortRegistration = async (
      location: ReturnType<typeof defaultDebugPatternLocation>,
      options: {
        addCandidateToRecent?: boolean;
        commitNumber?: number;
        abortAfterCommit?: boolean;
      } = {},
    ): Promise<void> => {
      const commitEntered = Promise.withResolvers<void>();
      const releaseCommit = Promise.withResolvers<void>();
      const controller = new AbortController();
      const originalStartPiece = manager.startPiece;
      const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
      let candidatePiece: Cell<unknown> | undefined;
      let interceptRegistrationCommit = false;
      let commitCount = 0;
      manager.startPiece = (async (piece, options) => {
        await originalStartPiece.call(manager, piece, options);
        if (typeof piece !== "string") candidatePiece = piece;
        interceptRegistrationCommit = true;
      }) as typeof manager.startPiece;
      runtime.editWithRetry = (async (action, maxRetries) => {
        if (interceptRegistrationCommit) commitCount++;
        const shouldIntercept = commitCount === (options.commitNumber ?? 1);
        const result = await originalEditWithRetry((transaction) => {
          const result = action(transaction);
          if (shouldIntercept) {
            const originalCommit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
              commitEntered.resolve();
              await releaseCommit.promise;
              const result = await originalCommit();
              if (options.abortAfterCommit) {
                controller.abort(new Error("debug deployment cancelled"));
              }
              return result;
            };
          }
          return result;
        }, maxRetries);
        if (shouldIntercept && options.addCandidateToRecent && !result.error) {
          const candidate = candidatePiece;
          if (candidate === undefined) {
            throw new Error("candidate piece was not started");
          }
          const concurrentUpdate = await originalEditWithRetry(
            (transaction) => {
              const list = recentPieces.withTx(transaction);
              const current = list.getRawUntyped({ frozen: false });
              if (!Array.isArray(current)) {
                throw new Error("recentPieces is not an array");
              }
              list.setRawUntyped([
                ...current,
                candidate.getAsLink({ base: list, includeSchema: true }),
              ]);
            },
          );
          if (concurrentUpdate.error) throw concurrentUpdate.error;
        }
        return result;
      }) as typeof runtime.editWithRetry;
      try {
        const deployment = deployAgentSessionsDebugView(
          manager,
          target,
          location,
          controller.signal,
        );
        await commitEntered.promise;
        if (!options.abortAfterCommit) {
          controller.abort(new Error("debug deployment cancelled"));
        }
        releaseCommit.resolve();
        await assertRejects(
          () => deployment,
          Error,
          "debug deployment cancelled",
        );
      } finally {
        releaseCommit.resolve();
        manager.startPiece = originalStartPiece;
        runtime.editWithRetry = originalEditWithRetry;
      }
    };

    const originalPiece = await manager.get(originalPieceId, false);
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1)],
      errors: [],
      complete: true,
    }]);
    await abortRegistration(alternateLocation, {
      addCandidateToRecent: true,
      abortAfterCommit: true,
    });
    assertEquals(
      await registeredPieceIds(defaultPattern, "allPieces"),
      [originalPieceId],
    );
    assertEquals(
      await registeredPieceIds(defaultPattern, "recentPieces"),
      [],
    );
    assertEquals(await originalPiece.result.get(["sessionCount"]), 1);

    const addRecentResult = await runtime.editWithRetry((transaction) => {
      const list = recentPieces.withTx(transaction);
      const current = list.getRawUntyped({ frozen: false });
      if (!Array.isArray(current)) {
        throw new Error("recentPieces is not an array");
      }
      list.setRawUntyped([
        ...current,
        originalPiece.getCell().getAsLink({
          base: list,
          includeSchema: true,
        }),
      ]);
    });
    if (addRecentResult.error) throw addRecentResult.error;
    await abortRegistration(defaultLocation);
    assertEquals(
      await registeredPieceIds(defaultPattern, "recentPieces"),
      [originalPieceId],
    );

    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1), sessionSnapshot(2)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    assertEquals(await originalPiece.result.get(["sessionCount"]), 2);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment rejects stale registration across runtimes", async () => {
  const server = newSharedServer();
  const spaceName = `debug-registration-race-${crypto.randomUUID()}`;
  const readerSession = await createSession({ identity, spaceName });
  const readerStorage = SharedServerStorageManager.connectTo(server, {
    as: readerSession.as,
  });
  const readerRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: readerStorage,
  });
  try {
    const readerManager = new PiecesController(readerSession, readerRuntime);
    await readerManager.synced();
    const defaultPattern = await installDefaultPattern(readerManager);
    const target = await AgentFabricTarget.open({
      runtime: readerRuntime,
      spaceDid: readerSession.space,
    });
    const originalPieceId = await deployAgentSessionsDebugView(
      readerManager,
      target,
    );
    await readerStorage.synced();

    const writerSession = await createSession({ identity, spaceName });
    const writerStorage = SharedServerStorageManager.connectTo(server, {
      as: writerSession.as,
    });
    const writerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    try {
      const writerManager = new PiecesController(writerSession, writerRuntime);
      await writerManager.synced();
      const registration = writerRuntime.getCell(
        writerSession.space,
        "agent-sessions-debug-registration-v1",
      );
      await registration.sync();
      const competingRegistration = {
        cause: "agent-sessions-debug:competing",
        pieceId: "fid1:competing-debug-piece",
        patternIdentity: "fid1:competing-debug-pattern",
        patternSymbol: "default",
        retiredCauses: [],
      };
      const commitEntered = Promise.withResolvers<void>();
      const releaseCommit = Promise.withResolvers<void>();
      const originalStartPiece = readerManager.startPiece;
      const originalEditWithRetry = readerRuntime.editWithRetry.bind(
        readerRuntime,
      );
      let interceptRegistrationCommit = false;
      let intercepted = false;
      readerManager.startPiece = (async (piece, options) => {
        await originalStartPiece.call(readerManager, piece, options);
        interceptRegistrationCommit = true;
      }) as typeof readerManager.startPiece;
      readerRuntime.editWithRetry = ((action, maxRetries) =>
        originalEditWithRetry((transaction) => {
          const result = action(transaction);
          if (interceptRegistrationCommit && !intercepted) {
            intercepted = true;
            const originalCommit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
              commitEntered.resolve();
              await releaseCommit.promise;
              return await originalCommit();
            };
          }
          return result;
        }, maxRetries)) as typeof readerRuntime.editWithRetry;
      try {
        const defaultLocation = defaultDebugPatternLocation();
        const deployment = deployAgentSessionsDebugView(
          readerManager,
          target,
          {
            rootPath: defaultLocation.rootPath,
            mainPath: fromFileUrl(
              new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
            ),
          },
        );
        await commitEntered.promise;
        const competingResult = await writerRuntime.editWithRetry((tx) => {
          registration.withTx(tx).setRawUntyped(competingRegistration);
        });
        if (competingResult.error) {
          throw competingResult.error;
        }
        releaseCommit.resolve();

        await assertRejects(
          () =>
            deployment,
          Error,
          "debug view registration changed during deployment",
        );
        assertEquals(registration.getRaw(), competingRegistration);
        const registeredIds = await registeredPieceIds(
          defaultPattern,
          "allPieces",
        );
        assertEquals(registeredIds.includes(originalPieceId), true);
        assertEquals(registeredIds.length, 1);
        await target.publish([{
          source: sourceDescriptor(),
          sessions: [sessionSnapshot(1)],
          errors: [],
          complete: true,
        }]);
        await readerRuntime.settled();
        const originalPiece = await readerManager.get(originalPieceId, false);
        assertEquals(await originalPiece.result.get(["sessionCount"]), 1);
      } finally {
        releaseCommit.resolve();
        readerManager.startPiece = originalStartPiece;
        readerRuntime.editWithRetry = originalEditWithRetry;
      }
    } finally {
      await writerRuntime.dispose();
      await writerStorage.close();
    }
  } finally {
    await readerRuntime.dispose();
    await readerStorage.close();
    await server.close();
  }
});

Deno.test("debug replacement preserves a piece owned by another runtime", async () => {
  const server = newSharedServer();
  const spaceName = `debug-cross-runtime-replacement-${crypto.randomUUID()}`;
  const firstSession = await createSession({ identity, spaceName });
  const firstStorage = SharedServerStorageManager.connectTo(server, {
    as: firstSession.as,
  });
  const firstRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: firstStorage,
  });
  try {
    const firstManager = new PiecesController(firstSession, firstRuntime);
    await firstManager.synced();
    await installDefaultPattern(firstManager);
    const firstTarget = await AgentFabricTarget.open({
      runtime: firstRuntime,
      spaceDid: firstSession.space,
    });
    const originalPieceId = await deployAgentSessionsDebugView(
      firstManager,
      firstTarget,
    );
    await firstStorage.synced();

    const secondSession = await createSession({ identity, spaceName });
    const secondStorage = SharedServerStorageManager.connectTo(server, {
      as: secondSession.as,
    });
    const secondRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: secondStorage,
    });
    try {
      const secondManager = new PiecesController(secondSession, secondRuntime);
      await secondManager.synced();
      const secondTarget = await AgentFabricTarget.open({
        runtime: secondRuntime,
        spaceDid: secondSession.space,
      });
      const defaultLocation = defaultDebugPatternLocation();
      await deployAgentSessionsDebugView(secondManager, secondTarget, {
        rootPath: defaultLocation.rootPath,
        mainPath: fromFileUrl(
          new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
        ),
      });

      await firstTarget.publish([{
        source: sourceDescriptor(),
        sessions: [sessionSnapshot(1)],
        errors: [],
        complete: true,
      }]);
      await firstRuntime.settled();
      const originalPiece = await firstManager.get(originalPieceId, false);
      assertEquals(await originalPiece.result.get(["sessionCount"]), 1);
      await firstStorage.synced();
      await secondStorage.synced();

      assertEquals(
        await deployAgentSessionsDebugView(secondManager, secondTarget),
        originalPieceId,
      );

      await deployAgentSessionsDebugView(secondManager, secondTarget, {
        rootPath: defaultLocation.rootPath,
        mainPath: fromFileUrl(
          new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
        ),
      });
      await firstTarget.publish([{
        source: sourceDescriptor(),
        sessions: [sessionSnapshot(1), sessionSnapshot(2)],
        errors: [],
        complete: true,
      }]);
      await firstRuntime.settled();
      assertEquals(await originalPiece.result.get(["sessionCount"]), 2);
      await firstStorage.synced();
      await secondStorage.synced();
      assertEquals(
        await deployAgentSessionsDebugView(secondManager, secondTarget),
        originalPieceId,
      );
    } finally {
      await secondRuntime.dispose();
      await secondStorage.close();
    }
  } finally {
    await firstRuntime.dispose();
    await firstStorage.close();
    await server.close();
  }
});

Deno.test("debug deployment reports malformed registration lists", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-registration-error-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const recentPieces = defaultPattern.asSchema(undefined)
      .key("recentPieces")
      .resolveAsCell();
    const malformedResult = await runtime.editWithRetry((tx) => {
      recentPieces.withTx(tx).setRawUntyped({ malformed: true });
    });
    if (malformedResult.error) throw malformedResult.error;
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });

    await assertRejects(
      () => deployAgentSessionsDebugView(manager, target),
      Error,
      "recentPieces is not an array",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment rejects a replaced default pattern", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-root-race-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const replacementRoot = runtime.getCell(
      session.space,
      `replacement-default-pattern-${crypto.randomUUID()}`,
    );
    const replacementResult = await runtime.editWithRetry((tx) => {
      replacementRoot.withTx(tx).setRawUntyped({ replacement: true });
    });
    if (replacementResult.error) throw replacementResult.error;

    const originalGetDefaultPattern = manager.getDefaultPattern;
    let replaced = false;
    manager.getDefaultPattern = (async (runIt = true) => {
      const found = await originalGetDefaultPattern.call(manager, runIt);
      if (!replaced) {
        replaced = true;
        await manager.linkDefaultPattern(replacementRoot);
      }
      return found;
    }) as typeof manager.getDefaultPattern;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target),
        Error,
        "default pattern changed during debug view deployment",
      );
    } finally {
      manager.getDefaultPattern = originalGetDefaultPattern;
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug pattern resumes sessions published while it was stopped", async () => {
  const server = newSharedServer();
  const spaceName = `debug-resume-published-${crypto.randomUUID()}`;
  let debugPieceId = "";

  const deploySession = await createSession({ identity, spaceName });
  const deployStorage = SharedServerStorageManager.connectTo(server, {
    as: deploySession.as,
  });
  const deployRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: deployStorage,
  });
  try {
    const manager = new PiecesController(deploySession, deployRuntime);
    await manager.synced();
    const target = await AgentFabricTarget.open({
      runtime: deployRuntime,
      spaceDid: deploySession.space,
    });
    debugPieceId = (await deployDebugPiece(manager, target)).id;
    await deployStorage.synced();
  } finally {
    await deployRuntime.dispose();
    await deployStorage.close();
  }

  const publishSession = await createSession({ identity, spaceName });
  const publishStorage = SharedServerStorageManager.connectTo(server, {
    as: publishSession.as,
  });
  const publishRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: publishStorage,
  });
  try {
    const target = await AgentFabricTarget.open({
      runtime: publishRuntime,
      spaceDid: publishSession.space,
    });
    const snapshots = Array.from({ length: SESSION_PAGE_SIZE }, (_, index) => {
      const snapshot = sessionSnapshot(index + 1);
      snapshot.summary.archived = null;
      snapshot.summary.active = null;
      return snapshot;
    });
    await target.publish([{
      source: sourceDescriptor(),
      sessions: snapshots,
      errors: [],
      complete: true,
    }]);
    await publishStorage.synced();
  } finally {
    await publishRuntime.dispose();
    await publishStorage.close();
  }

  const readerSession = await createSession({ identity, spaceName });
  const readerStorage = SharedServerStorageManager.connectTo(server, {
    as: readerSession.as,
  });
  const readerRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: readerStorage,
  });
  try {
    const manager = new PiecesController(readerSession, readerRuntime);
    await manager.synced();
    const piece = await manager.get(debugPieceId, false);
    await manager.startPiece(piece.getCell());
    const result = await piece.result.get() as Record<string, unknown>;

    assertEquals(await piece.result.get(["sessionCount"]), SESSION_PAGE_SIZE);
    assertEquals(countSessionRawDataLinks(result["$UI"]), SESSION_PAGE_SIZE);
    const publishedRows = publishedSessionTableRows(result["$UI"]);
    assertEquals(publishedRows.length, SESSION_PAGE_SIZE + 1);
    assertEquals(
      renderedTableCells(publishedRows[1]).slice(0, 4),
      ["codex:test", "Sharded session 1", "unknown", "complete"],
    );
  } finally {
    await readerRuntime.dispose();
    await readerStorage.close();
  }
});

Deno.test("debug pattern loads connector child cells on a cold replica", async () => {
  const server = newSharedServer();
  const spaceName = `debug-cold-${crypto.randomUUID()}`;
  const sessionCount = SESSION_PAGE_SIZE * 34;
  let debugPieceId = "";
  let rawPieceId = "";
  let manifestDocumentId = "";
  let eventChunkDocumentId = "";
  let lastSessionRowDocumentId = "";
  let indexSourceRowDocumentId = "";
  try {
    const writerSession = await createSession({ identity, spaceName });
    const writerStorage = SharedServerStorageManager.connectTo(server, {
      as: writerSession.as,
    });
    const writerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    try {
      const manager = new PiecesController(writerSession, writerRuntime);
      await manager.synced();
      const target = await AgentFabricTarget.open({
        runtime: writerRuntime,
        spaceDid: writerSession.space,
      });
      debugPieceId = (await deployDebugPiece(manager, target)).id;
      const source = sourceDescriptor();
      await target.publish([{
        source,
        sessions: Array.from(
          { length: sessionCount },
          (_, index) => sessionSnapshot(index + 1),
        ),
        errors: [],
        complete: true,
      }]);
      const allIndexValue = target.cells.allIndex.getRaw();
      const allIndexSources = allIndexValue &&
          typeof allIndexValue === "object" &&
          !Array.isArray(allIndexValue) &&
          "sources" in allIndexValue &&
          Array.isArray(allIndexValue.sources)
        ? allIndexValue.sources
        : [];
      const allIndexSessions = allIndexValue &&
          typeof allIndexValue === "object" &&
          !Array.isArray(allIndexValue) &&
          "sessions" in allIndexValue &&
          Array.isArray(allIndexValue.sessions)
        ? allIndexValue.sessions
        : [];
      const indexSourceRow = allIndexSources[0];
      if (!isLinkRef(indexSourceRow)) {
        throw new Error("complete index source row link is missing");
      }
      const indexSourceRowId = linkRefPayload(indexSourceRow).id;
      if (typeof indexSourceRowId !== "string") {
        throw new Error("complete index source row ID is missing");
      }
      indexSourceRowDocumentId = indexSourceRowId;
      const lastSessionRow = allIndexSessions.at(-1);
      if (!isLinkRef(lastSessionRow)) {
        throw new Error("complete index session row link is missing");
      }
      const lastSessionRowId = linkRefPayload(lastSessionRow).id;
      if (typeof lastSessionRowId !== "string") {
        throw new Error("complete index session row ID is missing");
      }
      lastSessionRowDocumentId = lastSessionRowId;
      await target.publishHealth({
        service: "agents-host",
        formatVersion: 1,
        status: "ready",
        startedAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:01:00.000Z",
        target: { spaceDid: writerSession.space, cells: {} },
        commandProcessing: {
          accepting: true,
          pendingReceiptPublications: 0,
          failedCommands: 0,
        },
        sources: [{
          ...source,
          status: "ready",
          sessionCount,
          complete: true,
          errors: [],
        }],
        activity: [{
          id: "activity-1",
          at: "2026-07-20T00:01:00.000Z",
          type: "sync-completed",
          message: "Full collection completed",
          details: { capabilities: source.capabilities },
        }],
      });
      const manifest = writerRuntime.getCell(writerSession.space, {
        spaceDid: writerSession.space,
        agentConnector: "session",
        version: 1,
        sourceId: "codex:test",
        nativeSessionId: "session-1",
      });
      manifestDocumentId = manifest.getAsNormalizedFullLink().id;
      const manifestValue = manifest.getRaw();
      const firstDescriptorLink = manifestValue &&
          typeof manifestValue === "object" &&
          !Array.isArray(manifestValue) &&
          "chunks" in manifestValue &&
          Array.isArray(manifestValue.chunks)
        ? manifestValue.chunks[0]
        : undefined;
      if (!isLinkRef(firstDescriptorLink)) {
        throw new Error("session manifest chunk descriptor link is missing");
      }
      const descriptorCell = writerRuntime.getCellFromLink(
        linkRefPayload(firstDescriptorLink) as unknown as Parameters<
          Runtime["getCellFromLink"]
        >[0],
      );
      await descriptorCell.sync();
      const descriptorValue = descriptorCell.getRaw();
      const eventChunkLink = descriptorValue &&
          typeof descriptorValue === "object" &&
          !Array.isArray(descriptorValue) &&
          "link" in descriptorValue
        ? descriptorValue.link
        : undefined;
      if (!isLinkRef(eventChunkLink)) {
        throw new Error("session chunk link is missing");
      }
      const eventChunkId = linkRefPayload(eventChunkLink).id;
      if (typeof eventChunkId !== "string") {
        throw new Error("session chunk ID is missing");
      }
      eventChunkDocumentId = eventChunkId;
      rawPieceId = (await deployRawDataPiece(manager, manifest)).id;
      await writerStorage.synced();
    } finally {
      await writerRuntime.dispose();
      await writerStorage.close();
    }

    const readerSession = await createSession({ identity, spaceName });
    const readerStorage = SharedServerStorageManager.connectTo(server, {
      as: readerSession.as,
    });
    const readerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    try {
      const manager = new PiecesController(readerSession, readerRuntime);
      await manager.synced();
      const controller = manager;
      server.returnedEntityIds.length = 0;
      const piece = await controller.get(debugPieceId, true);

      assertEquals(piece.id, debugPieceId);
      assertEquals(piece.name(), "Agent sessions");
      assertEquals(await piece.result.get(["sourceCount"]), 1);
      assertEquals(
        await piece.result.get(["sessionCount"]),
        sessionCount,
      );
      assertEquals(await piece.result.get(["activityCount"]), 1);
      const debugResult = await piece.result.get();
      assertEquals(
        countSessionRawDataLinks(
          (debugResult as Record<string, unknown>)["$UI"],
        ),
        SESSION_PAGE_SIZE,
      );
      const publishedRows = publishedSessionTableRows(
        (debugResult as Record<string, unknown>)["$UI"],
      );
      assertEquals(publishedRows.length, SESSION_PAGE_SIZE + 1);
      assertEquals(
        renderedTableCells(publishedRows[1]).slice(0, 4),
        ["codex:test", "Sharded session 1", "active", "complete"],
      );
      assertEquals(
        server.returnedEntityIds.includes(manifestDocumentId),
        false,
      );
      assertEquals(
        server.returnedEntityIds.includes(eventChunkDocumentId),
        false,
      );
      assertEquals(
        server.returnedEntityIds.includes(lastSessionRowDocumentId),
        false,
      );
      assertEquals(
        server.returnedEntityIds.includes(indexSourceRowDocumentId),
        false,
      );
      assertEquals(
        renderedText(
          (debugResult as Record<string, unknown>)["$UI"],
        ).includes("Session indexes"),
        true,
      );
      const topLevelRawLinks = cellLinkCells(
        (debugResult as Record<string, unknown>)["$UI"],
        "Open raw data",
      );
      assertEquals(topLevelRawLinks.length, 5);
      const expectedTopLevelOrigins = [
        "AgentsHost.health()",
        "preceding seven days",
        "all non-deleted session-row links",
        "shared action array",
        "latest 200 receipt-row links",
      ];
      for (const [index, link] of topLevelRawLinks.entries()) {
        if (index === 2) continue;
        const rawSource = await readRawDataProvenance(readerRuntime, link);
        assertEquals(rawSource.provenance.fabric.space, writerSession.space);
        assertEquals(
          rawSource.provenance.origin.includes(
            expectedTopLevelOrigins[index],
          ),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalCommand.includes(
            "cf inspect value-at",
          ),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalCommand.includes(
            "inspect pull",
          ),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalCommand.includes(
            "inspect history",
          ),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalCommand.includes("--force"),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalCommand.includes("--full-depth"),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalCommand.includes(
            "--seq REVISION_SEQ",
          ),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalSetup.includes("CF_API_URL"),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalSetup.includes("CF_IDENTITY"),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalSetup.includes(
            "MEMORY_DUMP_ENABLED must be true",
          ),
          true,
        );
        assertEquals(
          rawSource.provenance.retrievalSetup.includes(
            "exact raw SQLite scope key",
          ),
          true,
        );
        assertEquals(
          rawSource.rendered.includes("Where this data comes from"),
          true,
        );
        assertEquals(
          rawSource.rendered.includes("Declared scope"),
          true,
        );
      }

      const completeIndexRawViewLink = topLevelRawLinks[2];
      if (!completeIndexRawViewLink) {
        throw new Error("complete index raw view is missing");
      }
      const completeIndexRawView = completeIndexRawViewLink.resolveAsCell();
      await readerRuntime.start(completeIndexRawView);
      await completeIndexRawView.pull();
      server.returnedEntityIds.length = 0;
      completeIndexRawView.key("load").send({});
      await readerRuntime.settled();
      await completeIndexRawView.pull();
      const completeIndexJson = JSON.parse(
        String(completeIndexRawView.key("rawJson").get()),
      );
      const completeIndexSource = await readRawDataProvenance(
        readerRuntime,
        completeIndexRawViewLink,
      );
      assertEquals(
        completeIndexSource.provenance.origin.includes(
          expectedTopLevelOrigins[2],
        ),
        true,
      );
      assertEquals(
        completeIndexSource.provenance.retrievalCommand.includes(
          "cf inspect value-at",
        ),
        true,
      );
      const firstRawSession = completeIndexJson.sessions[0];
      assertEquals(
        isLinkRef(firstRawSession),
        true,
      );
      assertEquals(
        typeof linkRefPayload(firstRawSession).id,
        "string",
      );
      assertEquals(
        server.returnedEntityIds.includes(manifestDocumentId),
        false,
      );
      assertEquals(
        server.returnedEntityIds.includes(eventChunkDocumentId),
        false,
      );
      assertEquals(
        server.returnedEntityIds.includes(lastSessionRowDocumentId),
        false,
      );

      server.returnedEntityIds.length = 0;
      const rawPiece = await controller.get(rawPieceId, true);
      const rawPieceValue = await rawPiece.result.get() as Record<
        string,
        unknown
      >;
      assertEquals(
        rawPieceValue.rawJson,
        "Loading raw conversation data…",
      );
      const sessionProvenance = rawPieceValue.provenance as RawDataProvenance;
      assertEquals(sessionProvenance.fabric.space, writerSession.space);
      assertEquals(
        sessionProvenance.origin.includes(
          'connector source "codex:test"',
        ),
        true,
      );
      assertEquals(
        sessionProvenance.providerRetrieval?.includes(
          "reads the producing driver from the session manifest",
        ),
        true,
      );
      assertEquals(
        sessionProvenance.retrievalCommand.includes(
          "every $link in the manifest",
        ),
        true,
      );
      assertEquals(
        sessionProvenance.retrievalCommand.includes(
          "Recursively follow every $link",
        ),
        true,
      );
      assertEquals(
        renderedText(rawPieceValue["$UI"]).includes(
          "Retrieve it from the provider",
        ),
        true,
      );
      assertEquals(
        server.returnedEntityIds.includes(manifestDocumentId),
        false,
      );
      assertEquals(
        server.returnedEntityIds.includes(eventChunkDocumentId),
        false,
      );
      const rawResult = await rawPiece.result.getCell();
      rawResult.key("load").send({});
      await readerRuntime.settled();
      const rawJson = await rawPiece.result.get(["rawJson"]);
      const raw = JSON.parse(String(rawJson));
      const loadedSessionProvenance = await rawPiece.result.get([
        "provenance",
      ]) as RawDataProvenance;
      assertEquals(
        loadedSessionProvenance.providerRetrieval?.includes(
          'producing driver "codex-app-server"',
        ),
        true,
      );
      assertEquals(
        loadedSessionProvenance.providerRetrieval?.includes('"thread/read"'),
        true,
      );
      assertEquals(raw.manifest.nativeSessionId, "session-1");
      assertEquals(raw.manifest.metadata.labels[0], "debug");
      assertEquals(raw.manifest.normalized.messages[0].textPreview, "hello");
      assertEquals(raw.eventChunks[0].events[0].content[0].text, "hello");
    } finally {
      await readerRuntime.dispose();
      await readerStorage.close();
    }
  } finally {
    await server.close();
  }
});
