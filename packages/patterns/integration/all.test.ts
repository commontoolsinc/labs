import { env } from "@commonfabric/integration";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { initializePiecesController } from "./pieces-controller.ts";

const { API_URL } = env;

// Optional sharding for CI fan-out: PATTERN_INTEGRATION_SHARD="i/n" (1-based)
// runs only the patterns where (sorted index % n) == (i - 1), so the pattern
// compiles spread across the n parallel "Pattern Integration Tests (i/n)" jobs
// instead of all landing in one. Mirrors the CFCHECK_SHARD fan-out in
// tasks/cfcheck.ts. Unset (local dev) runs every pattern.
function parsePatternShard(): { index: number; count: number } {
  const raw = Deno.env.get("PATTERN_INTEGRATION_SHARD");
  if (!raw) return { index: 0, count: 1 };
  const match = raw.match(/^(\d+)\/(\d+)$/);
  if (!match) {
    throw new Error(
      `Invalid PATTERN_INTEGRATION_SHARD "${raw}"; expected "i/n" (1-based).`,
    );
  }
  const index = Number(match[1]) - 1;
  const count = Number(match[2]);
  if (count < 1 || index < 0 || index >= count) {
    throw new Error(`PATTERN_INTEGRATION_SHARD "${raw}" out of range.`);
  }
  return { index, count };
}

describe("Compile all patterns", () => {
  const skippedPatterns = [
    "system/link-tool.tsx", // Utility handlers, not a standalone pattern
  ];

  const shard = parsePatternShard();
  const patterns = [...Deno.readDirSync(join(import.meta.dirname!, ".."))]
    .filter((file) => file.name.endsWith(".tsx"))
    .map((file) => file.name)
    // `.test.tsx` files are pattern tests, not authored patterns: they wrap a
    // pattern in a test harness and are compiled and executed by the separate
    // pattern unit-test job (`cf test`). Compiling them here too repeats that
    // work — and recompiles the real pattern they import — on the pattern
    // integration critical path. Match the pattern-source definition in
    // tasks/cfcheck.ts, which already excludes `.test.tsx`/`.test.ts`.
    .filter((name) => !name.endsWith(".test.tsx") && !name.endsWith(".test.ts"))
    .filter((name) => !skippedPatterns.includes(name))
    .sort();

  // Add a test for each pattern in this shard's slice.
  for (const [i, name] of patterns.entries()) {
    if (i % shard.count !== shard.index) continue;

    it(`Executes: ${name}`, async () => {
      // Heap monitoring for bisection experiments (CT-1148)
      const heapBefore = Deno.memoryUsage().heapUsed;

      // Create a fresh PiecesController per test to prevent memory accumulation
      // The PatternManager caches compiled patterns indefinitely, so we need a
      // fresh Runtime (via PiecesController) each time to avoid OOM in CI
      const identity = await Identity.generate();
      const cc = await initializePiecesController({
        spaceName: `${name}-${crypto.randomUUID()}`,
        apiUrl: new URL(API_URL),
        identity: identity,
      });

      try {
        const sourcePath = join(import.meta.dirname!, "..", name);
        const rootPath = join(import.meta.dirname!, "..");
        const program = await cc.manager().runtime.harness
          .resolve(
            new FileSystemProgramResolver(sourcePath, rootPath),
          );
        const piece = await cc!.create(program, { start: false });
        assert(piece.id, `Received piece ID ${piece.id} for ${name}.`);
      } finally {
        // Dispose the entire controller to free all memory including pattern cache
        await cc.dispose();

        // Log heap usage for analysis
        const heapAfter = Deno.memoryUsage().heapUsed;
        const deltaMB = Math.round((heapAfter - heapBefore) / 1024 / 1024);
        const totalMB = Math.round(heapAfter / 1024 / 1024);
        console.log(`[HEAP] ${name}: delta=${deltaMB}MB, total=${totalMB}MB`);
      }
    });
  }
});
