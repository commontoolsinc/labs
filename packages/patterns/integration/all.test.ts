import { env } from "@commontools/integration";
import { CharmsController } from "@commontools/charm/ops";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-compiler";

const { API_URL, SPACE_NAME } = env;

describe("Compile all recipes", () => {
  const skippedPatterns = [
    "chatbot-list-view.tsx",
    "chatbot-note-composed.tsx",
    "system/link-tool.tsx", // Utility handlers, not a standalone pattern
    // photo.tsx is temporarily skipped to reduce cumulative runtime memory in CI.
    // The TypeScript compilation fix (explicit output types) is in place, but
    // running 50+ patterns sequentially in CI's 4GB heap limit still OOMs.
    // photo.tsx works correctly - this is purely a CI memory constraint.
    "photo.tsx",
  ];

  // Add a test for each pattern, but skip ones that have issues
  for (const file of Deno.readDirSync(join(import.meta.dirname!, ".."))) {
    const { name } = file;
    if (!name.endsWith(".tsx")) continue;
    if (skippedPatterns.includes(name)) continue;

    it(`Executes: ${name}`, async () => {
      // Create a fresh CharmsController per test to prevent memory accumulation
      // The RecipeManager caches compiled recipes indefinitely, so we need a
      // fresh Runtime (via CharmsController) each time to avoid OOM in CI
      const identity = await Identity.generate();
      const cc = await CharmsController.initialize({
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
        const charm = await cc!.create(program, { start: false });
        assert(charm.id, `Received charm ID ${charm.id} for ${name}.`);
      } finally {
        // Dispose the entire controller to free all memory including recipe cache
        await cc.dispose();
      }
    });
  }
});
