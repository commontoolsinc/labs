/**
 * V2 compatibility test harness.
 *
 * Patches StorageManager.emulate to inject memoryVersion: "v2",
 * then dynamically imports the target test file so all its
 * StorageManager.emulate() calls use v2 storage.
 *
 * Usage:
 *   deno test --allow-all --no-check packages/runner/test/v2-compat/run-with-v2.ts -- --target=cell.test.ts
 *
 * Or import this module's patchForV2() in a test file.
 */

import { StorageManager } from "@commontools/runner/storage/cache.deno";

const originalEmulate = StorageManager.emulate.bind(StorageManager);

/**
 * Patch StorageManager.emulate to always pass memoryVersion: "v2".
 * Returns a restore function.
 */
export function patchForV2(): () => void {
  StorageManager.emulate = (options) => {
    return originalEmulate({ ...options, memoryVersion: "v2" });
  };
  return () => {
    StorageManager.emulate = originalEmulate;
  };
}
