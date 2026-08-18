import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import { stableCellId } from "@commonfabric/agents-connector/fabric-graph";
import type {
  FabricPlainObject,
  FabricValue,
} from "@commonfabric/data-model/fabric-value";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { pieceId } from "@commonfabric/piece";
import type { PiecesController } from "@commonfabric/piece/ops";
import {
  areLinksSame,
  asPatternIdentityRef,
  type Cell,
  compileAndSavePattern,
  type Pattern,
} from "@commonfabric/runner";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import type { AgentsHostTargetDescription } from "./host.ts";

const AGENT_SESSIONS_DEBUG_CAUSE_PREFIX = "agent-sessions-debug";
const AGENT_SESSIONS_DEBUG_REGISTRATION_CAUSE =
  "agent-sessions-debug-registration-v1";
const SUPERSEDED_PIECE_META_FIELDS = [
  "pattern",
  "argument",
  "result",
  "patternIdentity",
  "patternSource",
  "patternRepository",
  "internal",
  "schema",
  "slug",
] as const;

const SHALLOW_PIECE_LINK_LIST_SCHEMA = internSchema({
  type: "array",
  items: { type: "unknown" },
  default: [],
});
const SHALLOW_DEBUG_PIECE_SCHEMA = internSchema({
  type: "object",
  properties: {},
});
const DEBUG_REGISTRATION_SCHEMA = internSchema({
  type: "object",
  properties: {
    cause: { type: "string" },
    pieceId: { type: "string" },
    patternIdentity: { type: "string" },
    patternSymbol: { type: "string" },
    retiredCauses: {
      type: "array",
      items: { type: "string" },
      default: [],
    },
  },
  required: [
    "cause",
    "pieceId",
    "patternIdentity",
    "patternSymbol",
    "retiredCauses",
  ],
});

interface DebugRegistration extends FabricPlainObject {
  cause: string;
  pieceId: string;
  patternIdentity: string;
  patternSymbol: string;
  retiredCauses: string[];
}

interface DebugRegistrationState {
  link: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>;
  value: DebugRegistration | undefined;
}

const debugDeploymentTails = new Map<string, Promise<void>>();

async function serializeDebugDeployment<T>(
  key: string,
  deploy: () => Promise<T>,
): Promise<T> {
  const preceding = debugDeploymentTails.get(key) ?? Promise.resolve();
  const gate = Promise.withResolvers<void>();
  const tail = preceding.then(() => gate.promise);
  debugDeploymentTails.set(key, tail);
  await preceding;
  try {
    return await deploy();
  } finally {
    gate.resolve();
    if (debugDeploymentTails.get(key) === tail) {
      debugDeploymentTails.delete(key);
    }
  }
}

function debugPieceCause(patternRef: {
  identity: string;
  symbol: string;
}): string {
  return `${AGENT_SESSIONS_DEBUG_CAUSE_PREFIX}:${patternRef.identity}:` +
    encodeURIComponent(patternRef.symbol);
}

async function syncDocumentRoot(
  manager: PiecesController,
  cell: Cell<unknown>,
): Promise<void> {
  const link = cell.getAsNormalizedFullLink();
  const { error } = await manager.runtime.storageManager.open(link.space).sync(
    link.id,
    { path: [], schema: false },
    link.scope,
  );
  if (error) throw error;
}

function readDocumentValue(
  manager: PiecesController,
  cell: Cell<unknown>,
): FabricValue {
  const tx = manager.runtime.readTx();
  return tx.readValueOrThrow(cell.getAsNormalizedFullLink());
}

function readDocumentMeta(
  manager: PiecesController,
  cell: Cell<unknown>,
  field: string,
): FabricValue {
  const link = cell.getAsNormalizedFullLink();
  const tx = manager.runtime.readTx();
  return tx.readOrThrow({
    space: link.space,
    id: link.id,
    path: [field],
    ...(link.scope !== undefined && { scope: link.scope }),
  });
}

async function currentDebugPiece(
  manager: PiecesController,
  pattern: Pattern,
  cause: string,
): Promise<Cell<unknown> | undefined> {
  const expectedPattern = manager.runtime.patternManager.getArtifactEntryRef(
    pattern,
  );
  if (!expectedPattern) return undefined;
  const shallowPiece = manager.runtime.getCell(
    manager.getSpace(),
    cause,
    SHALLOW_DEBUG_PIECE_SCHEMA,
  );
  await syncDocumentRoot(manager, shallowPiece);
  const storedPattern = asPatternIdentityRef(
    readDocumentMeta(manager, shallowPiece, "patternIdentity"),
  );
  const argument = readDocumentMeta(manager, shallowPiece, "argument");
  if (
    storedPattern === undefined && argument === undefined &&
    readDocumentValue(manager, shallowPiece) === undefined
  ) {
    return undefined;
  }
  if (
    storedPattern === undefined ||
    storedPattern.identity !== expectedPattern.identity ||
    storedPattern.symbol !== expectedPattern.symbol ||
    argument === undefined
  ) {
    throw new Error(
      `debug view cause ${cause} contains a different prepared piece`,
    );
  }
  return shallowPiece.asSchema(pattern.resultSchema);
}

function asDebugRegistration(
  value: FabricValue,
): DebugRegistration | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
  ) {
    throw new Error("debug view registration is malformed");
  }
  const candidate = value as unknown as Record<string, unknown>;
  if (
    typeof candidate.cause !== "string" ||
    typeof candidate.pieceId !== "string" ||
    typeof candidate.patternIdentity !== "string" ||
    typeof candidate.patternSymbol !== "string" ||
    !Array.isArray(candidate.retiredCauses) ||
    candidate.retiredCauses.some((cause) => typeof cause !== "string")
  ) {
    throw new Error("debug view registration is malformed");
  }
  return {
    cause: candidate.cause,
    pieceId: candidate.pieceId,
    patternIdentity: candidate.patternIdentity,
    patternSymbol: candidate.patternSymbol,
    retiredCauses: candidate.retiredCauses as string[],
  };
}

function debugRegistrationsMatch(
  left: DebugRegistration | undefined,
  right: DebugRegistration | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.cause === right.cause &&
    left.pieceId === right.pieceId &&
    left.patternIdentity === right.patternIdentity &&
    left.patternSymbol === right.patternSymbol &&
    left.retiredCauses.length === right.retiredCauses.length &&
    left.retiredCauses.every((cause, index) =>
      cause === right.retiredCauses[index]
    );
}

async function debugRegistration(
  manager: PiecesController,
): Promise<DebugRegistrationState> {
  const registration = manager.runtime.getCell<DebugRegistration>(
    manager.getSpace(),
    AGENT_SESSIONS_DEBUG_REGISTRATION_CAUSE,
    DEBUG_REGISTRATION_SCHEMA,
  );
  await syncDocumentRoot(manager, registration);
  return {
    link: registration.getAsNormalizedFullLink(),
    value: asDebugRegistration(readDocumentValue(manager, registration)),
  };
}

async function debugRegistrationLists(
  defaultPattern: Cell<unknown>,
): Promise<Map<"allPieces" | "recentPieces", Cell<FabricValue[]>>> {
  const lists = new Map<
    "allPieces" | "recentPieces",
    Cell<FabricValue[]>
  >();
  const root = defaultPattern.asSchema(undefined);
  for (const name of ["allPieces", "recentPieces"] as const) {
    const slot = root.key(name);
    if (slot.getRaw() === undefined) {
      if (name === "allPieces") {
        throw new Error("default pattern does not expose allPieces");
      }
      continue;
    }
    const list = slot.resolveAsCell().asSchema(
      SHALLOW_PIECE_LINK_LIST_SCHEMA,
    ) as Cell<FabricValue[]>;
    await list.sync();
    lists.set(name, list);
  }
  return lists;
}

async function registerDebugPiece(
  manager: PiecesController,
  defaultPattern: Cell<unknown>,
  piece: Cell<unknown>,
  cause: string,
  patternRef: { identity: string; symbol: string },
): Promise<void> {
  const [lists, registration] = await Promise.all([
    debugRegistrationLists(defaultPattern),
    debugRegistration(manager),
  ]);
  const precedingPiece = registration.value?.cause !== undefined &&
      registration.value.cause !== cause
    ? manager.runtime.getCell(
      manager.getSpace(),
      registration.value.cause,
      SHALLOW_DEBUG_PIECE_SCHEMA,
    )
    : undefined;
  const retiredPieces = (registration.value?.retiredCauses ?? [])
    .filter((retiredCause) => retiredCause !== cause)
    .map((retiredCause) =>
      manager.runtime.getCell(
        manager.getSpace(),
        retiredCause,
        SHALLOW_DEBUG_PIECE_SCHEMA,
      )
    );
  const piecesToUnregister = [
    ...retiredPieces,
    ...(precedingPiece === undefined ? [] : [precedingPiece]),
  ];
  const piecesToRetire = precedingPiece === undefined ? [] : [precedingPiece];
  await Promise.all(
    piecesToRetire.map((supersededPiece) =>
      syncDocumentRoot(manager, supersededPiece)
    ),
  );
  const nextRegistration: DebugRegistration = {
    cause,
    pieceId: pieceId(piece) ?? "",
    patternIdentity: patternRef.identity,
    patternSymbol: patternRef.symbol,
    retiredCauses: [
      ...new Set([
        ...(registration.value?.retiredCauses ?? []).filter((retiredCause) =>
          retiredCause !== cause
        ),
        ...(precedingPiece === undefined ? [] : [registration.value!.cause]),
      ]),
    ],
  };
  if (!nextRegistration.pieceId) {
    throw new Error("debug view piece has no entity ID");
  }
  const { error } = await manager.runtime.editWithRetry((tx) => {
    const activeRegistration = asDebugRegistration(
      tx.readValueOrThrow(registration.link),
    );
    if (!debugRegistrationsMatch(activeRegistration, registration.value)) {
      throw new Error(
        "debug view registration changed during deployment",
      );
    }
    const activeDefaultPatternCell = manager.getSpaceCellContents().withTx(tx)
      .key("defaultPattern");
    const activeDefaultPattern = activeDefaultPatternCell.get();
    if (
      !activeDefaultPattern ||
      !areLinksSame(
        activeDefaultPattern,
        defaultPattern,
        activeDefaultPatternCell,
      )
    ) {
      throw new Error("default pattern changed during debug view deployment");
    }
    let changed = false;
    for (const [name, list] of lists) {
      const listWithTx = list.withTx(tx);
      const current = listWithTx.getRawUntyped({ frozen: false });
      if (!Array.isArray(current)) {
        throw new Error(`default pattern ${name} is not an array`);
      }
      const remove = name === "allPieces"
        ? [...piecesToUnregister, piece]
        : piecesToUnregister;
      const retained = current.filter((value) =>
        !remove.some((target) => areLinksSame(value, target, listWithTx))
      );
      if (name === "allPieces") {
        retained.push(piece.getAsLink({
          base: listWithTx,
          includeSchema: true,
        }));
      }
      if (retained.length !== current.length || name === "allPieces") {
        listWithTx.setRawUntyped(retained);
        changed = true;
      }
    }
    for (const supersededPiece of piecesToRetire) {
      const link = supersededPiece.getAsNormalizedFullLink();
      tx.writeValueOrThrow(link, undefined);
      for (const field of SUPERSEDED_PIECE_META_FIELDS) {
        tx.writeOrThrow({
          space: link.space,
          id: link.id,
          path: [field],
          ...(link.scope !== undefined && { scope: link.scope }),
        }, undefined);
      }
      changed = true;
    }
    tx.writeValueOrThrow(registration.link, nextRegistration);
    changed = true;
    return changed;
  });
  if (error) {
    const message = typeof error === "object" && error !== null &&
        "message" in error
      ? String(error.message)
      : String(error);
    throw new Error(`Could not update debug view registrations: ${message}`, {
      cause: error,
    });
  }
  for (const supersededPiece of piecesToUnregister) {
    manager.runtime.runner.stop(supersededPiece);
  }
  await manager.runtime.idle();
}

export function defaultDebugPatternLocation(): {
  mainPath: string;
  rootPath: string;
} {
  const rootPath = resolve(dirname(fromFileUrl(import.meta.url)), "../../..");
  return {
    rootPath,
    mainPath: join(
      rootPath,
      "packages/patterns/agent-sessions-debug/main.tsx",
    ),
  };
}

export function deployAgentSessionsDebugView(
  manager: PiecesController,
  target: AgentFabricTarget,
  location = defaultDebugPatternLocation(),
  signal?: AbortSignal,
): Promise<string> {
  return serializeDebugDeployment(
    manager.getSpace(),
    () => deployAgentSessionsDebugViewNow(manager, target, location, signal),
  );
}

async function deployAgentSessionsDebugViewNow(
  manager: PiecesController,
  target: AgentFabricTarget,
  location: ReturnType<typeof defaultDebugPatternLocation>,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  let defaultPattern: Cell<unknown> | undefined = await manager
    .getDefaultPattern(false);
  if (!defaultPattern) {
    await manager.ensureDefaultPattern();
    defaultPattern = await manager.getDefaultPattern(false);
    if (!defaultPattern) {
      throw new Error("default pattern was not created");
    }
  }
  signal?.throwIfAborted();
  const program = await manager.runtime.harness.resolve(
    new FileSystemProgramResolver(location.mainPath, location.rootPath),
  );
  signal?.throwIfAborted();
  const pattern = await compileAndSavePattern(manager.runtime, program, {
    space: manager.getSpace(),
  });
  const patternRef = manager.runtime.patternManager.getArtifactEntryRef(
    pattern,
  );
  if (!patternRef) throw new Error("debug view pattern has no identity");
  const cause = debugPieceCause(patternRef);
  const currentPiece = await currentDebugPiece(manager, pattern, cause);
  const piece = currentPiece ?? await manager.setupPersistent(
    pattern,
    {
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
    cause,
  );
  const existingRegistration = (await debugRegistration(manager)).value;
  const pieceWasRegistered = existingRegistration?.cause === cause &&
    existingRegistration.pieceId === pieceId(piece) &&
    existingRegistration.patternIdentity === patternRef.identity &&
    existingRegistration.patternSymbol === patternRef.symbol;
  const stopStartingPiece = () => manager.runtime.runner.stop(piece);
  if (!pieceWasRegistered) {
    signal?.addEventListener("abort", stopStartingPiece, { once: true });
  }
  try {
    await manager.startPiece(piece);
    signal?.throwIfAborted();
  } catch (error) {
    if (!pieceWasRegistered) {
      stopStartingPiece();
      await manager.runtime.idle();
    }
    throw error;
  } finally {
    if (!pieceWasRegistered) {
      signal?.removeEventListener("abort", stopStartingPiece);
    }
  }
  try {
    await registerDebugPiece(manager, defaultPattern, piece, cause, patternRef);
  } catch (error) {
    if (!pieceWasRegistered) {
      manager.runtime.runner.stop(piece);
      await manager.runtime.idle();
    }
    throw error;
  }
  signal?.throwIfAborted();
  const id = pieceId(piece);
  if (!id) throw new Error("debug view piece has no entity ID");
  return id;
}

export function describeAgentFabricTarget(
  target: AgentFabricTarget,
  spaceDid: string,
  debugPieceId?: string,
): AgentsHostTargetDescription {
  return {
    spaceDid,
    ...(debugPieceId ? { debugPieceId } : {}),
    cells: {
      recentIndex: stableCellId(target.cells.index),
      allIndex: stableCellId(target.cells.allIndex),
      health: stableCellId(target.cells.health),
      commands: target.commandCellId(),
      receipts: target.receiptCellId(),
    },
  };
}
