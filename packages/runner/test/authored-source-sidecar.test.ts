import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Module, Pattern } from "../src/builder/types.ts";
import type { Engine } from "../src/harness/engine.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { CachedCompiledModule } from "../src/sandbox/module-record-compiler.ts";

const signer = await Identity.fromPassphrase("authored source sidecar test");

const SOURCE = [
  "import { computed, lift, pattern } from 'commonfabric';",
  "const local = lift((n: number) => n * 2);",
  "const aliased = lift((n: number) => n + 1);",
  "export { aliased as first, aliased as second };",
  "export default pattern<{ value: number }>(({ value }) => {",
  "  const hoisted = computed(() => (value as number) + 100);",
  "  return { a: local(value), b: aliased(value), hoisted };",
  "});",
].join("\n");

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: SOURCE }],
};

type DebugAnnotated = { src?: string; name?: string };

/** Returns the source suffix for the beginning of `anchor`. */
function authoredAt(line: number, anchor: string): string {
  const text = SOURCE.split("\n")[line - 1]!;
  const col = text.indexOf(anchor);
  if (col < 0) throw new Error(`Line ${line} has no \`${anchor}\`.`);
  return `/main.tsx:${line}:${col}`;
}

/** Returns the implementation whose body preview contains `marker`. */
function nodeImplementation(patternFactory: unknown, marker: string) {
  const nodes = (patternFactory as Pattern & { nodes: { module: Module }[] })
    .nodes;
  const implementation = nodes
    .map((node) => node.module.implementation)
    .find((candidate) =>
      typeof candidate === "function" &&
      (candidate as { preview?: string }).preview?.includes(marker)
    );
  if (typeof implementation !== "function") {
    throw new Error(`No node implementation previews \`${marker}\`.`);
  }
  return implementation as DebugAnnotated;
}

function exportedImplementation(main: unknown, exportName: string) {
  return (main as Record<string, Module>)[exportName]!
    .implementation as DebugAnnotated;
}

function toCached(
  modules: readonly CacheableModule[],
): CachedCompiledModule[] {
  return modules.map((module) => ({
    identity: module.identity,
    filename: module.filename,
    code: module.js,
    ...(module.builderSourceSites === undefined
      ? {}
      : { builderSourceSites: module.builderSourceSites }),
    imports: module.imports,
  }));
}

describe("authored source sidecar", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  const makeEngine = (): Engine => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    return runtime.harness;
  };

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("reports authored positions for exports, registrations, and hoists", async () => {
    const { main } = await makeEngine().compileAndEvaluateModules(PROGRAM);
    const first = exportedImplementation(main, "first");
    const second = exportedImplementation(main, "second");
    const local = nodeImplementation(
      (main as { default?: unknown }).default,
      "n * 2",
    );
    const hoisted = nodeImplementation(
      (main as { default?: unknown }).default,
      "value + 100",
    );

    expect(first.src?.endsWith(authoredAt(3, "(n: number) => n + 1")))
      .toBe(true);
    expect(second.src).toBe(first.src);
    expect(first.name).toBe("aliased");
    expect(local.src?.endsWith(authoredAt(2, "(n: number) => n * 2")))
      .toBe(true);
    expect(local.name).toBe("local");
    expect(
      hoisted.src?.endsWith(
        authoredAt(6, "() => (value as number) + 100"),
      ),
    ).toBe(true);
    expect(hoisted.name).toBe("hoisted");
  });

  it("preserves authored positions on a source-free warm load", async () => {
    const engine = makeEngine();
    const { modules, entryIdentity } = await engine.compileToRecordGraph(
      PROGRAM,
    );
    expect(
      modules.find((module) => module.filename === "/main.tsx")
        ?.builderSourceSites,
    ).toBeDefined();

    const { main } = await engine.evaluateCachedModules(
      toCached(modules),
      entryIdentity,
    );
    const first = exportedImplementation(main, "first");

    expect(first.src?.endsWith(authoredAt(3, "(n: number) => n + 1")))
      .toBe(true);
    expect(first.name).toBe("aliased");
  });

  it("hides cached filename-collision prefixes from debug sources", async () => {
    const dependencySource = [
      "import { lift } from 'commonfabric';",
      "export const dep = lift((n: number) => n + 9);",
    ].join("\n");
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { dep } from './dep.ts';",
            "export default dep;",
          ].join("\n"),
        },
        { name: "/dep.ts", contents: dependencySource },
      ],
    };
    const engine = makeEngine();
    const { modules, entryIdentity } = await engine.compileToRecordGraph(
      program,
    );
    const dependency = modules.find((module) => module.filename === "/dep.ts");
    if (!dependency) throw new Error("Dependency module was not compiled.");

    // Fabric closures routinely contain several modules persisted as
    // `/main.tsx`. The warm loader disambiguates those record source URLs with
    // `/~cf/<identity>/`; that loader-only prefix must not leak into `fn.src`.
    const cached = toCached(modules).map((module) => ({
      ...module,
      filename: "/main.tsx",
    }));
    const evaluated = await engine.evaluateCachedModules(cached, entryIdentity);
    const implementation = exportedImplementation(
      evaluated.exportsByIdentity?.get(dependency.identity),
      "dep",
    );

    expect(implementation.src).toBe(
      `cf:module/${dependency.identity}/main.tsx:2:24`,
    );
    expect(implementation.src).not.toContain("/~cf/");
  });
});
