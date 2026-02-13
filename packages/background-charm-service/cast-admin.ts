import { parseArgs } from "@std/cli/parse-args";
import { compilePattern, PieceManager } from "@commontools/piece";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type DID } from "@commontools/identity";
import { createSession } from "@commontools/identity";
import {
  BG_CELL_CAUSE,
  BG_SYSTEM_SPACE_ID,
  BGCharmEntriesSchema,
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
      address: new URL("/api/storage/memory", toolshedUrl),
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
      BGCharmEntriesSchema,
    );

    // Ensure the cell is synced
    await targetCell.sync();
    await runtime.storageManager.synced();

    console.log("Getting cell...");

    // Cast the pattern on the cell or with undefined if no cell
    console.log("Casting pattern...");

    // Create session and charm manager (matching main.ts pattern)
    const session = await createSession({
      identity,
      spaceDid: spaceId as DID,
    });

    // Create charm manager for the specified space
    const charmManager = new PieceManager(session, runtime);
    await charmManager.ready;
    const pattern = await compilePattern(
      patternSrc,
      "pattern",
      runtime,
      spaceId,
    );
    console.log("Pattern compiled successfully");

    const charm = await charmManager.runPersistent(pattern, {
      charms: targetCell,
    });

    console.log("Pattern cast successfully!");
    console.log("Result charm ID:", charm.entityId);

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
