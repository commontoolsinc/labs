/**
 * Shared type definitions for commonfabric module used in tests.
 *
 * Loads types from the same source as production: types/commonfabric.d.ts
 * via StaticCacheFS (which is a symlink to packages/api/index.ts).
 */
import { StaticCacheFS } from "@commonfabric/static";

const staticCache = new StaticCacheFS();

/**
 * The commonfabric type definitions, loaded from the same source as production.
 * This is a symlink to packages/api/index.ts.
 */
export const commonfabricTypes = await staticCache.getText(
  "types/commonfabric.d.ts",
);

/**
 * Types in the format expected by test utilities.
 */
export const COMMONFABRIC_TYPES: Record<string, string> = {
  "commonfabric.d.ts": commonfabricTypes,
};
