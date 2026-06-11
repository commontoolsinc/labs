import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("test operator");

// A shared module whose identity must be stable regardless of which entry
// point pulls it into a compilation. It carries a default export so it can also
// serve as a program entry point.
const SHARED =
  "export const shared = (x: number) => x + 1;\nexport default shared;\n";

describe("Engine implementation identity", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  async function loadAndResolve(
    program: RuntimeProgram,
    modulePath: string,
  ): Promise<{ id: string; implementationId: string | undefined }> {
    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    engine.evaluateRecordGraph(id, graph, mainSpecifier, program.files);
    const implementationId = engine.implementationHashForSource(
      `/${id}${modulePath}:1:1`,
    );
    return { id, implementationId };
  }

  it("gives a shared module the same content-addressed identity across entry points", async () => {
    // Program A: entry imports the shared module (and so includes an extra file).
    const programA: RuntimeProgram = {
      main: "/a.tsx",
      files: [
        {
          name: "/a.tsx",
          contents:
            `import { shared } from "./shared.ts";\nexport default () => shared(1);\n`,
        },
        { name: "/shared.ts", contents: SHARED },
      ],
    };
    // Program B: the shared module is itself the entry point — a different file
    // set and a different program id.
    const programB: RuntimeProgram = {
      main: "/shared.ts",
      files: [
        { name: "/shared.ts", contents: SHARED },
      ],
    };

    const a = await loadAndResolve(programA, "/shared.ts");
    const b = await loadAndResolve(programB, "/shared.ts");

    // The whole-program ids differ (entry-point dependent), which is exactly
    // what used to make the implementation fingerprint unstable.
    expect(a.id).not.toBe(b.id);

    // The content-addressed implementation identity is stable.
    expect(a.implementationId).toBeTruthy();
    expect(a.implementationId).toBe(b.implementationId);
    expect(a.implementationId!.startsWith("cf:module/")).toBe(true);
  });

  it("changes the identity when the shared module's source changes", async () => {
    const program = (body: string): RuntimeProgram => ({
      main: "/shared.ts",
      files: [{ name: "/shared.ts", contents: body }],
    });

    const before = await loadAndResolve(program(SHARED), "/shared.ts");
    const after = await loadAndResolve(
      program(
        "export const shared = (x: number) => x + 2;\nexport default shared;\n",
      ),
      "/shared.ts",
    );

    expect(after.implementationId).not.toBe(before.implementationId);
  });

  it("returns undefined for a source location with no loaded module", () => {
    expect(engine.implementationHashForSource("/unknown/x.tsx:1:1")).toBe(
      undefined,
    );
  });
});
