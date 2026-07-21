import { parseArgs } from "@std/cli/parse-args";
import { PieceManager } from "@commonfabric/piece";
import {
  clientVersionFromEnv,
  compileAndSavePattern,
  experimentalOptionsFromEnv,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type DID } from "@commonfabric/identity";
import { createSession } from "@commonfabric/identity";
import {
  BG_CELL_CAUSE,
  BG_SYSTEM_SPACE_ID,
  BGPieceEntriesSchema,
} from "./src/schema.ts";
import { getIdentity } from "./src/utils.ts";
import type { Identity, Session } from "@commonfabric/identity";

export interface CastAdminDependencies {
  args: string[];
  envGet: typeof Deno.env.get;
  getIdentity: typeof getIdentity;
  createRuntime: (
    toolshedUrl: string,
    identity: Identity,
    envGet: typeof Deno.env.get,
  ) => Runtime;
  readTextFile: typeof Deno.readTextFile;
  createSession: typeof createSession;
  createPieceManager: (
    session: Session,
    runtime: Runtime,
  ) => {
    ready: Promise<unknown>;
    runPersistent: (
      pattern: unknown,
      inputs: Record<string, unknown>,
    ) => Promise<{ entityId: unknown }>;
  };
  compileAndSavePattern: (
    runtime: Runtime,
    patternSrc: string,
    options: { space: string },
  ) => Promise<unknown>;
  exit: typeof Deno.exit;
  log: typeof console.log;
  error: typeof console.error;
}

export function createRuntime(
  toolshedUrl: string,
  identity: Identity,
  envGet: typeof Deno.env.get = Deno.env.get,
): Runtime {
  // Shared first-party posture for client runtimes against a deployed API
  // (CT-1814); this admin CLI now honors EXPERIMENTAL_* like the rest of the
  // service instead of silently ignoring it, read through the same injected
  // env boundary as every other env consultation here (CastAdminDependencies).
  return new Runtime(runtimePresets.remoteClient({
    apiUrl: new URL(toolshedUrl),
    storageManager: StorageManager.open({
      as: identity,
      memoryHost: new URL(toolshedUrl),
    }),
    experimental: experimentalOptionsFromEnv(envGet),
    clientVersion: clientVersionFromEnv(envGet),
  }));
}

export function requireCellCause(cause: string | undefined): string {
  if (!cause) {
    throw new Error("Cell ID is required");
  }
  return cause;
}

export async function castPattern(
  patternPath: string,
  quit: boolean,
  toolshedUrl: string,
  identity: Identity,
  dependencies: CastAdminDependencies,
) {
  const spaceId = BG_SYSTEM_SPACE_ID;
  const cause = requireCellCause(BG_CELL_CAUSE);
  dependencies.log(`Casting pattern from ${patternPath} in space ${spaceId}`);

  dependencies.log("params:", {
    spaceId,
    patternPath,
    cause,
    toolshedUrl,
    quit,
  });

  const runtime = dependencies.createRuntime(
    toolshedUrl,
    identity,
    dependencies.envGet,
  );

  try {
    // Load and compile the pattern first
    dependencies.log("Loading pattern...");
    const patternSrc = await dependencies.readTextFile(patternPath);

    const targetCell = runtime.getCell(
      spaceId as DID,
      cause,
      BGPieceEntriesSchema,
    );

    // Ensure the cell is synced
    await targetCell.sync();
    await runtime.storageManager.synced();

    dependencies.log("Getting cell...");

    // Cast the pattern on the cell or with undefined if no cell
    dependencies.log("Casting pattern...");

    // Create session and piece manager (matching main.ts pattern)
    const session = await dependencies.createSession({
      identity,
      spaceDid: spaceId as DID,
    });

    // Create piece manager for the specified space
    const pieceManager = dependencies.createPieceManager(session, runtime);
    await pieceManager.ready;
    const pattern = await dependencies.compileAndSavePattern(
      runtime,
      patternSrc,
      { space: spaceId },
    );
    dependencies.log("Pattern compiled successfully");

    const piece = await pieceManager.runPersistent(pattern, {
      pieces: targetCell,
    });

    dependencies.log("Pattern cast successfully!");
    dependencies.log("Result piece ID:", piece.entityId);

    await runtime.storageManager.synced();
    dependencies.log("Storage synced, exiting");
    dependencies.exit(0);
  } catch (error) {
    dependencies.error("Error casting pattern:", error);
    if (quit) {
      await runtime.storageManager.synced();
      dependencies.exit(1);
    }
  }
}

export function defaultCastAdminDependencies(): CastAdminDependencies {
  return {
    args: Deno.args,
    envGet: Deno.env.get,
    getIdentity,
    createRuntime,
    readTextFile: Deno.readTextFile,
    createSession,
    createPieceManager: (session, runtime) =>
      new PieceManager(session, runtime) as unknown as ReturnType<
        CastAdminDependencies["createPieceManager"]
      >,
    compileAndSavePattern: compileAndSavePattern as CastAdminDependencies[
      "compileAndSavePattern"
    ],
    exit: Deno.exit,
    log: console.log,
    error: console.error,
  };
}

export async function main(
  dependencies: CastAdminDependencies = defaultCastAdminDependencies(),
): Promise<void> {
  const { patternPath, quit } = parseArgs(
    dependencies.args,
    {
      string: ["patternPath"],
      boolean: ["quit"],
      default: {
        name: "pattern-caster",
        quit: false,
      },
    },
  );

  if (!patternPath) {
    dependencies.error(
      "Usage: deno task castPattern --patternPath <path to pattern>",
    );
    dependencies.exit(1);
    return;
  }

  const toolshedUrl = dependencies.envGet("API_URL") ??
    "https://toolshed.saga-castor.ts.net/";

  const identity = await dependencies.getIdentity(
    dependencies.envGet("IDENTITY"),
    dependencies.envGet("OPERATOR_PASS"),
  );

  await castPattern(
    patternPath,
    quit,
    toolshedUrl,
    identity,
    dependencies,
  );
}

export async function runIfMain(
  isMain = import.meta.main,
  run: () => Promise<void> = main,
): Promise<void> {
  if (isMain) await run();
}

await runIfMain();
