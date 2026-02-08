/**
 * Run cell.test.ts against v2 storage.
 */
import { patchForV2 } from "./run-with-v2.ts";
patchForV2();

// Import the original test — all StorageManager.emulate() calls
// will now use memoryVersion: "v2".
import "../cell.test.ts";
