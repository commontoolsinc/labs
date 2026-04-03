/**
 * Shared type definitions for commontools module used in tests.
 *
 * Loads types from the same source as production: types/commontools.d.ts
 * via StaticCacheFS (which is a symlink to packages/api/index.ts).
 */
import { StaticCacheFS } from "@commontools/static";

const staticCache = new StaticCacheFS();

/**
 * The commontools type definitions, loaded from the same source as production.
 * This is a symlink to packages/api/index.ts.
 */
export const commontoolsTypes = await staticCache.getText(
  "types/commontools.d.ts",
);

/**
 * Types in the format expected by test utilities.
 */
export const COMMONTOOLS_TYPES: Record<string, string> = {
  "commontools.d.ts": commontoolsTypes,
};
