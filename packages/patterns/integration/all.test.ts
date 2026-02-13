import { env } from "@commontools/integration";
import { PiecesController } from "@commontools/piece/ops";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-compiler";

const { API_URL, SPACE_NAME } = env;

describe("Compile all recipes", () => {
  const skippedPatterns = [
    "system/link-tool.tsx", // Utility handlers, not a standalone pattern
  ];

  // Add a test for each pattern, but skip ones that have issues
  for (const file of Deno.readDirSync(join(import.meta.dirname!, ".."))) {
    const { name } = file;
    if (!name.endsWith(".tsx")) continue;
    if (skippedPatterns.includes(name)) continue;

    it(`Executes: ${name}`, async () => {
      // Heap monitoring for bisection experiments (CT-1148)
      const heapBefore = Deno.memoryUsage().heapUsed;

      // Create a fresh PiecesController per test to prevent memory accumulation
      // The PatternManager caches compiled patterns indefinitely, so we need a
      // fresh Runtime (via PiecesController) each time to avoid OOM in CI
      const identity = await Identity.generate();
      const cc = await PiecesController.initialize({
        spaceName: SPACE_NAME,
        apiUrl: new URL(API_URL),
        identity: identity,
      });

      try {
        const sourcePath = join(import.meta.dirname!, "..", name);
        const program = await cc.manager().runtime.harness
          .resolve(
            new FileSystemProgramResolver(sourcePath),
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
