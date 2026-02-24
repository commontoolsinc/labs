/**
 * Live reproduction: exercises the exact code path from the runtime-processor
 * that triggers the crash: convertCellsToLinks(value, { doNotConvertCellResults: true })
 * on a cell that contains deeply nested notebook data with cyclic references.
 *
 * Run: deno run --allow-ffi --allow-env --allow-read --allow-net --allow-write --no-check packages/runner/test/nest-bug-live.ts
 */

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { convertCellsToLinks } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const API_URL = "http://localhost:8000";
const SPACE_NAME = "nest-bug";

// Notebook A piece ID
const NOTEBOOK_A_ID = "baedreiafh76ez5k3y4medmh6hq6bkg7p623fu3l7gcjjaltenu3cjvgsna";

async function main() {
  console.log("=== Nest Bug Live Repro ===");
  console.log(`Connecting to ${API_URL}, space: ${SPACE_NAME}`);

  const signer = await Identity.fromPassphrase("implicit trust");
  const space = signer.did();

  const storageManager = StorageManager.create({
    as: signer,
    apiUrl: new URL(API_URL),
    syncParticipants: true,
  });

  const runtime = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager,
  });

  const tx = runtime.edit();

  try {
    // Get the Notebook A cell
    console.log(`\nGetting cell for Notebook A: ${NOTEBOOK_A_ID}`);
    const cell = runtime.getCell(space, NOTEBOOK_A_ID, undefined, tx);

    console.log("Syncing cell...");
    await cell.sync();

    console.log("Getting value...");
    const value = cell.get();
    console.log("Cell value type:", typeof value);
    console.log("Cell value keys:", value ? Object.keys(value as object).slice(0, 10) : "null");

    // This is the exact code path from runtime-processor handleCellGet:
    console.log("\n--- Testing convertCellsToLinks with doNotConvertCellResults: true ---");
    try {
      const converted = convertCellsToLinks(value, {
        includeSchema: true,
        keepAsCell: true,
        doNotConvertCellResults: true,
      });
      console.log("SUCCESS:", JSON.stringify(converted).slice(0, 500));
    } catch (e) {
      console.error("FAILED:", (e as Error).message);
      console.error("Stack:", (e as Error).stack?.split("\n").slice(0, 15).join("\n"));
    }

    // Also test without doNotConvertCellResults (should always work)
    console.log("\n--- Testing convertCellsToLinks WITHOUT doNotConvertCellResults ---");
    try {
      const converted = convertCellsToLinks(value, {
        includeSchema: true,
        keepAsCell: true,
      });
      console.log("SUCCESS:", JSON.stringify(converted).slice(0, 500));
    } catch (e) {
      console.error("FAILED:", (e as Error).message);
    }

  } finally {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  }
}

main().catch(console.error);
