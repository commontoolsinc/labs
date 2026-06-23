import { parseArgs } from "@std/cli/parse-args";
import { PieceManager } from "@commonfabric/piece";
import { compileAndSavePattern, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type DID } from "@commonfabric/identity";
import { createSession } from "@commonfabric/identity";
import {
  BG_CELL_CAUSE,
  BG_SYSTEM_SPACE_ID,
  BGPieceEntriesSchema,
} from "./src/schema.ts";
import { getIdentity } from "./src/utils.ts";

const { patternPath, quit } = parseArgs(
  Deno.args,
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
  console.error(
    "Usage: deno task castPattern --patternPath <path to pattern>",
  );
  Deno.exit(1);
}

const toolshedUrl = Deno.env.get("API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

const identity = await getIdentity(
  Deno.env.get("IDENTITY"),
  Deno.env.get("OPERATOR_PASS"),
);

// Storage and blobby server URL are now configured in Runtime constructor

async function castPattern() {
  const spaceId = BG_SYSTEM_SPACE_ID;
  const cause = BG_CELL_CAUSE;
  console.log(`Casting pattern from ${patternPath} in space ${spaceId}`);

  console.log("params:", {
    spaceId,
    patternPath,
    cause,
    toolshedUrl,
    quit,
  });

  // Create runtime with proper configuration
  const runtime = new Runtime({
    apiUrl: new URL(toolshedUrl),
    storageManager: StorageManager.open({
      as: identity,
      memoryHost: new URL(toolshedUrl),
    }),
  });

  try {
    // Load and compile the pattern first
    console.log("Loading pattern...");
    const patternSrc = await Deno.readTextFile(patternPath!);

    if (!cause) {
      throw new Error("Cell ID is required");
    }

    const targetCell = runtime.getCell(
      spaceId as DID,
      cause,
      BGPieceEntriesSchema,
    );

    // Ensure the cell is synced
    await targetCell.sync();
    await runtime.storageManager.synced();

    console.log("Getting cell...");

    // Cast the pattern on the cell or with undefined if no cell
    console.log("Casting pattern...");

    // Create session and piece manager (matching main.ts pattern)
    const session = await createSession({
      identity,
      spaceDid: spaceId as DID,
    });

    // Create piece manager for the specified space
    const pieceManager = new PieceManager(session, runtime);
    await pieceManager.ready;
    const pattern = await compileAndSavePattern(
      runtime,
      patternSrc,
      { space: spaceId },
    );
    console.log("Pattern compiled successfully");

    const piece = await pieceManager.runPersistent(pattern, {
      pieces: targetCell,
    });

    console.log("Pattern cast successfully!");
    console.log("Result piece ID:", piece.entityId);

    await runtime.storageManager.synced();
    console.log("Storage synced, exiting");
    Deno.exit(0);
  } catch (error) {
    console.error("Error casting pattern:", error);
    if (quit) {
      await runtime.storageManager.synced();
      Deno.exit(1);
    }
  }
}

castPattern();
