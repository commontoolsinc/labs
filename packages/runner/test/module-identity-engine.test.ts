import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import { transformInjectHelperModule } from "../src/harness/pretransform.ts";

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

  // The reload-stable, content-addressed MODULE identity is what action
  // identity now roots on (the scheduler fingerprint was re-rooted off `.src`
  // onto content-addressed provenance). We assert it via `canonicalModuleSource`
  // — the live canonicalizer that maps a per-program bundle path onto the
  // per-module `cf:module/<hash>/<path>` identity. That is exactly the
  // `moduleHashByPrefixedSource` machinery the (removed) `implementationHashForSource`
  // reduced, so this preserves the invariant without the dead `.src`-reduction path.
  async function loadAndResolve(
    program: RuntimeProgram,
    modulePath: string,
  ): Promise<{ id: string; moduleIdentity: string | undefined }> {
    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    engine.evaluateRecordGraph(id, graph, mainSpecifier, program.files);
    const moduleIdentity = engine.canonicalModuleSource(`/${id}${modulePath}`);
    return { id, moduleIdentity };
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

    // The content-addressed module identity is stable across entry points.
    expect(a.moduleIdentity).toBeTruthy();
    expect(a.moduleIdentity).toBe(b.moduleIdentity);
    expect(a.moduleIdentity!.startsWith("cf:module/")).toBe(true);
  });

  it("hashes module identity over PRISTINE authored source, not the helper-injected form (CT-1740)", async () => {
    // module-loading.md:204-207, 531-535, 543: a module's identity is over its
    // AUTHORED TypeScript, BEFORE the pretransform helper-injection decoration,
    // so it is TCB-version independent. Folding in the injection (the bug)
    // rotates a module's identity whenever the decoration changes between
    // compiles — which is the CT-1740 `writeAuthorizedBy` stamp divergence
    // (a profile stamped under an older decoration vs. recompiled today).
    const program: RuntimeProgram = {
      main: "/m.tsx",
      files: [{ name: "/m.tsx", contents: SHARED }],
    };
    const { entryIdentity } = await engine.compileToRecordGraph(program);

    const pristineId = computeModuleHashes({
      main: "/m.tsx",
      files: [{ name: "/m.tsx", contents: SHARED }],
    }).get("/m.tsx")!;
    const injectedId = computeModuleHashes(
      transformInjectHelperModule({
        main: "/m.tsx",
        files: [{ name: "/m.tsx", contents: SHARED }],
      }),
    ).get("/m.tsx")!;

    // The two candidate byte-forms genuinely hash differently — the choice is
    // real, not a no-op.
    expect(pristineId).not.toBe(injectedId);
    // The invariant: identity is over the pristine authored source.
    expect(entryIdentity).toBe(pristineId);
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

    expect(after.moduleIdentity).not.toBe(before.moduleIdentity);
  });

  it("returns undefined for a source path with no loaded module", () => {
    expect(engine.canonicalModuleSource("/unknown/x.tsx")).toBe(undefined);
  });
});
