import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  computeEntryIdentity,
  resolveEntryIdentity,
} from "../src/harness/entry-identity.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import { transformInjectHelperModule } from "../src/harness/pretransform.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";

// `computeEntryIdentity` and `resolveModuleImports` parse with the TS parser, so
// the compiler stack must be loaded before any standalone (no-engine) call.
await ensureCompilerStack();

const signer = await Identity.fromPassphrase("test operator");

// A shared module carrying a default export so it can be an entry point too.
const SHARED =
  "export const shared = (x: number) => x + 1;\nexport default shared;\n";
const ENTRY =
  `import { shared } from "./shared.ts";\nexport default () => shared(1);\n`;

describe("computeEntryIdentity (light, drift-free)", () => {
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

  it("matches the engine's stored entryIdentity (the linchpin)", async () => {
    // A representative multi-file program: entry imports a sibling.
    const program: RuntimeProgram = {
      main: "/entry.tsx",
      files: [
        { name: "/entry.tsx", contents: ENTRY },
        { name: "/shared.ts", contents: SHARED },
      ],
    };

    const { entryIdentity } = await engine.compileToRecordGraph(program);
    const light = computeEntryIdentity(program.main, program.files);

    expect(light).toBe(entryIdentity);
  });

  it("hashes PRISTINE authored bytes, not the helper-injected form", () => {
    // The engine restores pre-injection bytes before hashing; a helper that
    // hashed `pretransformProgramForModules(...).files` (the injected form)
    // would drift. Prove the two byte-forms genuinely differ, and that we
    // picked pristine.
    const files = [{ name: "/m.tsx", contents: SHARED }];
    const pristineId = computeModuleHashes({ main: "/m.tsx", files })
      .get("/m.tsx")!;
    const injectedId = computeModuleHashes(
      transformInjectHelperModule({ main: "/m.tsx", files }),
    ).get("/m.tsx")!;

    expect(pristineId).not.toBe(injectedId);
    expect(computeEntryIdentity("/m.tsx", files)).toBe(pristineId);
  });

  it("is independent of the entry-point / program id", async () => {
    // The engine's id is a content hash of the whole program; ours is a
    // constant. Same source ⇒ same identity regardless.
    const asEntry: RuntimeProgram = {
      main: "/shared.ts",
      files: [{ name: "/shared.ts", contents: SHARED }],
    };
    const withSibling: RuntimeProgram = {
      main: "/entry.tsx",
      files: [
        { name: "/entry.tsx", contents: ENTRY },
        { name: "/shared.ts", contents: SHARED },
      ],
    };

    const idFromEntryProgram = await engine.compileToRecordGraph(asEntry);
    // /shared.ts has the same identity whether it is the entry or a sibling.
    const lightAsEntry = computeEntryIdentity("/shared.ts", asEntry.files);
    const lightAsSibling = computeEntryIdentity(
      "/shared.ts",
      withSibling.files,
    );

    expect(lightAsEntry).toBe(idFromEntryProgram.entryIdentity);
    expect(lightAsSibling).toBe(lightAsEntry);
  });

  it("throws when the entry's import closure is incomplete", () => {
    // Drop the sibling: `./shared.ts` no longer resolves to an included file.
    expect(() =>
      computeEntryIdentity("/entry.tsx", [
        { name: "/entry.tsx", contents: ENTRY },
      ])
    ).toThrow(/incomplete closure/);
  });

  it("ignores unreachable files (a superset is safe)", () => {
    // An unrelated file with a dangling relative import must NOT trip the
    // entry's closure guard — the guard is scoped to the entry's reachable set.
    const identity = computeEntryIdentity("/entry.tsx", [
      { name: "/entry.tsx", contents: ENTRY },
      { name: "/shared.ts", contents: SHARED },
      {
        name: "/unrelated.tsx",
        contents:
          `import { x } from "./does-not-exist.ts";\nexport default x;\n`,
      },
    ]);
    expect(identity).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects a fabric (cf:) import in the reachable closure", () => {
    expect(() =>
      computeEntryIdentity("/entry.tsx", [
        {
          name: "/entry.tsx",
          contents:
            `import { thing } from "cf:pattern/abc";\nexport default () => thing;\n`,
        },
      ])
    ).toThrow(/fabric import/);
  });

  it("is transitively sensitive to source changes", () => {
    const base = computeEntryIdentity("/entry.tsx", [
      { name: "/entry.tsx", contents: ENTRY },
      { name: "/shared.ts", contents: SHARED },
    ]);
    // Change a byte in the entry.
    const entryChanged = computeEntryIdentity("/entry.tsx", [
      { name: "/entry.tsx", contents: ENTRY + "\n" },
      { name: "/shared.ts", contents: SHARED },
    ]);
    // Change a byte in the (transitively imported) sibling.
    const siblingChanged = computeEntryIdentity("/entry.tsx", [
      { name: "/entry.tsx", contents: ENTRY },
      {
        name: "/shared.ts",
        contents: "export const shared = (x: number) => x + 2;\n" +
          "export default shared;\n",
      },
    ]);

    expect(entryChanged).not.toBe(base);
    expect(siblingChanged).not.toBe(base);
  });

  it("produces a 43-char base64url identity", () => {
    const identity = computeEntryIdentity("/shared.ts", [
      { name: "/shared.ts", contents: SHARED },
    ]);
    expect(identity).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("resolveEntryIdentity (closure walk via readFile)", () => {
  const APP =
    `import { shared } from "../lib/shared.ts";\nexport default () => shared(1);\n`;
  const disk = new Map<string, string>([
    ["/system/app.tsx", APP],
    ["/lib/shared.ts", SHARED],
    ["/system/unused.tsx", `import { gone } from "./missing.ts";\n`],
  ]);
  const reads: string[] = [];
  const readFile = (name: string): Promise<string> => {
    reads.push(name);
    const contents = disk.get(name);
    if (contents === undefined) {
      return Promise.reject(new Error(`not found: ${name}`));
    }
    return Promise.resolve(contents);
  };

  it("walks only the reachable closure and matches computeEntryIdentity", async () => {
    reads.length = 0;
    const walked = await resolveEntryIdentity("system/app.tsx", readFile);

    // Same value as feeding the closure explicitly.
    const explicit = computeEntryIdentity("/system/app.tsx", [
      { name: "/system/app.tsx", contents: APP },
      { name: "/lib/shared.ts", contents: SHARED },
    ]);
    expect(walked).toBe(explicit);

    // It read exactly the entry and its one sibling — never the unrelated
    // (broken) file.
    expect(new Set(reads)).toEqual(
      new Set(["/system/app.tsx", "/lib/shared.ts"]),
    );
  });

  it("propagates a read failure for a genuinely missing dependency", async () => {
    const broken = new Map([[
      "/system/app.tsx",
      `import { gone } from "./missing.ts";\nexport default gone;\n`,
    ]]);
    await expect(
      resolveEntryIdentity(
        "/system/app.tsx",
        (name) =>
          broken.has(name)
            ? Promise.resolve(broken.get(name)!)
            : Promise.reject(new Error(`not found: ${name}`)),
      ),
    ).rejects.toThrow(/not found/);
  });
});
