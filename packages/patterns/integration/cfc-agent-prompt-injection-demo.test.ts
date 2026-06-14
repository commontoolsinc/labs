import { env } from "@commonfabric/integration";
import { PiecesController } from "@commonfabric/piece/ops";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";

const { API_URL } = env;

// Compile-load guard for the CFC agent prompt-injection demo. The demo lives in
// a subdirectory, so the top-level "Compile all patterns" sweep (all.test.ts,
// which only scans `*.tsx` directly under packages/patterns) never covered it —
// which is why it sat broken at module load for weeks (the shared `cfcAtom`
// methods-namespace dragged into the SES bundle, #3691). This test compiles the
// demo through the harness; a SES/plain-data load regression throws here.
describe("cfc-agent-prompt-injection-demo compiles", () => {
  it("loads the demo pattern through the harness", async () => {
    const identity = await Identity.generate();
    const cc = await PiecesController.initialize({
      spaceName: `cfc-agent-prompt-injection-demo-${crypto.randomUUID()}`,
      apiUrl: new URL(API_URL),
      identity,
    });

    try {
      const sourcePath = join(
        import.meta.dirname!,
        "..",
        "cfc-agent-prompt-injection-demo",
        "main.tsx",
      );
      const rootPath = join(import.meta.dirname!, "..");
      const program = await cc.manager().runtime.harness.resolve(
        new FileSystemProgramResolver(sourcePath, rootPath),
      );
      // `start: false` compiles + SES-verifies + evaluates the module graph
      // (the step that previously threw `PlainDataValidationError`) without
      // running the reactive pattern.
      const piece = await cc.create(program, { start: false });
      assert(piece.id, "demo pattern produced a piece id");
    } finally {
      await cc.dispose();
    }
  });
});
