import * as Memory from "@commontools/memory";
import * as Path from "@std/path";
import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";

// Determine store URL: DB_PATH (single-file mode) or MEMORY_DIR (directory mode)
let storeUrl: URL;

if (env.DB_PATH) {
  // Single file mode: use explicit database file (must be absolute path)
  storeUrl = Path.toFileUrl(env.DB_PATH);
  console.log(`Memory: Using single database file: ${env.DB_PATH}`);
} else {
  // Directory mode: use MEMORY_DIR (existing behavior)
  storeUrl = new URL(env.MEMORY_DIR);
  console.log(`Memory: Using directory mode: ${env.MEMORY_DIR}`);
}

// Initialize memory provider using top-level await
console.log("Memory: Initializing provider...");
const result = await Memory.Provider.open({
  store: storeUrl,
  serviceDid: identity.did(),
});

if (result.error) {
  throw result.error;
}

export const memory = result.ok;
console.log("Memory: Provider initialized successfully");

export { Memory };
