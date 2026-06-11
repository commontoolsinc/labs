import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Program } from "@commonfabric/js-compiler";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { writeSourceDocs } from "../src/compilation-cache/cell-cache.ts";
import { FABRIC_MOUNT_ROOT } from "../src/sandbox/module-record-compiler.ts";
import { createRef } from "../src/create-ref.ts";
import { fromURI, toURI } from "../src/uri-utils.ts";
import { type PatternMeta, patternMetaSchema } from "../src/pattern-manager.ts";
import { slugIdForSpace } from "../src/slugs.ts";
import type { Cell } from "../src/cell.ts";
import type { URI } from "../src/sigil-types.ts";

const signer = await Identity.fromPassphrase("fabric imports engine test");
const space = signer.did();

describe("Engine fabric imports", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let engine: Engine;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  function dependencyProgram(value: number): RuntimeProgram {
    return {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: `export const x = ${value};`,
        },
      ],
    };
  }

  function importerProgram(specifier: string): RuntimeProgram {
    return {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            `import { pattern } from "commonfabric";`,
            `import { x } from "${specifier}";`,
            `export function y() { return x + 1; }`,
            `export default pattern<{ value: number }>(({ value }) => ({ result: value + x }));`,
          ].join("\n"),
        },
      ],
    };
  }

  async function publish(program: RuntimeProgram) {
    const compiled = await engine.compileToRecordGraph(program);
    const tx = runtime.edit();
    writeSourceDocs(
      runtime,
      space,
      compiled.modules,
      compiled.entryIdentity,
      tx,
    );
    await tx.commit();
    return compiled;
  }

  function newPatternId(label: string): URI {
    return toURI(createRef({ pattern: label }, "fabric imports engine test"));
  }

  function patternMetaCell(patternId: URI): Cell<PatternMeta> {
    return runtime.getCellFromEntityId(
      space,
      { "/": fromURI(patternId) },
      [],
      patternMetaSchema,
    );
  }

  async function writePatternMeta(
    entryIdentity: string,
  ): Promise<{ patternId: URI; cell: Cell<PatternMeta> }> {
    const patternId = newPatternId(entryIdentity);
    const cell = patternMetaCell(patternId);
    await runtime.editWithRetry((tx) => {
      cell.withTx(tx).set({
        spec: "pattern",
        entryIdentity,
      } as PatternMeta);
    });
    return { patternId, cell };
  }

  async function writeSlug(slug: string, target: Cell<unknown>): Promise<void> {
    const slugCell = runtime.getCellFromEntityId(space, {
      "/": slugIdForSpace(space, slug),
    });
    await runtime.editWithRetry((tx) => {
      const slugWithTx = slugCell.withTx(tx);
      slugWithTx.setRawUntyped(
        target.withTx(tx).getAsWriteRedirectLink({ base: slugWithTx }),
      );
    });
  }

  async function poisonSlug(slug: string): Promise<void> {
    const slugCell = runtime.getCellFromEntityId(space, {
      "/": slugIdForSpace(space, slug),
    });
    await runtime.editWithRetry((tx) => {
      slugCell.withTx(tx).setRawUntyped("not a redirect");
    });
  }

  async function runPattern(pattern: unknown, value: number): Promise<unknown> {
    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      `fabric import result ${value}`,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const result = runtime.run(tx, pattern as any, { value }, resultCell);
    await tx.commit();
    await result.pull();
    return result.getAsQueryResult();
  }

  it("compiles, type-checks, evaluates, and describes pinned same-space imports", async () => {
    const dependency = await publish(dependencyProgram(41));
    const specifier = `cf:pattern:${dependency.entryIdentity}`;
    const program = importerProgram(specifier);

    const compiled = await engine.compileToRecordGraph(program, {
      fabricImports: { space },
    });

    const mountedPath =
      `${FABRIC_MOUNT_ROOT}${dependency.entryIdentity}/main.tsx`;
    const mountedSpecifier = compiled.graph.specifierByPath.get(mountedPath);
    expect(mountedSpecifier).toBe(`cf:module/${dependency.entryIdentity}`);
    expect(compiled.graph.records.has(`cf:module/${dependency.entryIdentity}`))
      .toBe(true);

    const importerRecord = compiled.graph.records.get(compiled.mainSpecifier)!;
    expect(importerRecord.resolutions?.[specifier]).toBe(
      `cf:module/${dependency.entryIdentity}`,
    );

    const importedModule = compiled.modules.find((module) =>
      module.identity === dependency.entryIdentity
    );
    expect(importedModule?.filename).toBe("/main.tsx");
    expect(importedModule?.source).toBe(dependency.modules[0].source);

    const importerModule = compiled.modules.find((module) =>
      module.identity === compiled.entryIdentity
    );
    expect(importerModule?.imports).toContainEqual({
      specifier,
      targetIdentity: dependency.entryIdentity,
    });

    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      program.files,
    );
    expect(evaluated.main?.y()).toBe(42);
    expect(await runPattern(evaluated.main?.default, 1)).toEqual({
      result: 42,
    });
  });

  it("uses the mounted source for TypeScript diagnostics", async () => {
    const dependency = await publish(dependencyProgram(1));
    const specifier = `cf:pattern:${dependency.entryIdentity}`;
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents:
            `import { missing } from "${specifier}";\nexport const y = missing;`,
        },
      ],
    };

    await expect(
      engine.compileToRecordGraph(program, { fabricImports: { space } }),
    ).rejects.toThrow("has no exported member 'missing'");
  });

  it("rejects fabric imports without a space context before generic resolution errors", async () => {
    const dependency = await publish(dependencyProgram(1));
    await expect(
      engine.compileToRecordGraph(
        importerProgram(`cf:pattern:${dependency.entryIdentity}`),
      ),
    ).rejects.toThrow(
      "fabric imports require a space context (options.fabricImports)",
    );
  });

  it("rejects unpinned fabric imports unless explicitly allowed", async () => {
    await expect(
      engine.compileToRecordGraph(importerProgram("cf:dep"), {
        fabricImports: { space },
      }),
    ).rejects.toThrow(
      "unpinned fabric import 'cf:dep'; pin it (cf deps update) or deploy to pin",
    );
  });

  it("resolves unpinned fabric imports in dev mode and surfaces resolved pins", async () => {
    const dependency = await publish(dependencyProgram(9));
    const { patternId, cell } = await writePatternMeta(
      dependency.entryIdentity,
    );
    await writeSlug("dep", cell);

    const compiled = await engine.compileToRecordGraph(
      importerProgram("cf:dep"),
      {
        fabricImports: { space, allowUnpinned: true },
      },
    );

    expect(compiled.resolvedPins).toEqual([
      {
        specifier: "cf:dep",
        resolvedIdentity: dependency.entryIdentity,
        chain: [
          "slug:dep",
          `patternMeta:${patternId}`,
          `entryIdentity:${dependency.entryIdentity}`,
        ],
      },
    ]);
    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      importerProgram("cf:dep").files,
    );
    expect(evaluated.main?.y()).toBe(10);
  });

  it("does not chase the slug for already-pinned mutable refs", async () => {
    const dependency = await publish(dependencyProgram(11));
    const { cell } = await writePatternMeta(dependency.entryIdentity);
    await writeSlug("dep", cell);
    await poisonSlug("dep");

    const compiled = await engine.compileToRecordGraph(
      importerProgram(`cf:dep@${dependency.entryIdentity}`),
      { fabricImports: { space } },
    );

    expect(compiled.resolvedPins).toEqual([]);
    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      importerProgram(`cf:dep@${dependency.entryIdentity}`).files,
    );
    expect(evaluated.main?.y()).toBe(12);
  });

  it("dedupes mounted files when different specifier texts pin the same identity", async () => {
    const dependency = await publish(dependencyProgram(2));
    const direct = `cf:pattern:${dependency.entryIdentity}`;
    const pinnedSlug = `cf:dep@${dependency.entryIdentity}`;
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            `import { x as a } from "${direct}";`,
            `import { x as b } from "${pinnedSlug}";`,
            `export function total() { return a + b; }`,
          ].join("\n"),
        },
      ],
    };

    const compiled = await engine.compileToRecordGraph(program, {
      fabricImports: { space },
    });

    expect(
      compiled.modules.filter((module) =>
        module.identity === dependency.entryIdentity
      ),
    ).toHaveLength(1);
    expect(compiled.graph.records.has(`cf:module/${dependency.entryIdentity}`))
      .toBe(true);

    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      program.files,
    );
    expect(evaluated.main?.total()).toBe(4);
  });

  it("keeps old pins stable and changes importer identity when the pin text changes", async () => {
    const oldDependency = await publish(dependencyProgram(3));
    const oldSpecifier = `cf:pattern:${oldDependency.entryIdentity}`;
    const oldImporter = await engine.compileToRecordGraph(
      importerProgram(oldSpecifier),
      { fabricImports: { space } },
    );

    const newDependency = await publish(dependencyProgram(4));
    const oldImporterAgain = await engine.compileToRecordGraph(
      importerProgram(oldSpecifier),
      { fabricImports: { space } },
    );
    const newImporter = await engine.compileToRecordGraph(
      importerProgram(`cf:pattern:${newDependency.entryIdentity}`),
      { fabricImports: { space } },
    );

    expect(oldImporterAgain.entryIdentity).toBe(oldImporter.entryIdentity);
    expect(newImporter.entryIdentity).not.toBe(oldImporter.entryIdentity);
    expect(
      oldImporterAgain.modules.some((module) =>
        module.identity === oldDependency.entryIdentity
      ),
    ).toBe(true);
    expect(
      newImporter.modules.some((module) =>
        module.identity === newDependency.entryIdentity
      ),
    ).toBe(true);
  });

  it("surfaces mounted files in getTransformedProgram", async () => {
    const dependency = await publish(dependencyProgram(5));
    let transformed: Program | undefined;

    await engine.compileToRecordGraph(
      importerProgram(`cf:pattern:${dependency.entryIdentity}`),
      {
        fabricImports: { space },
        getTransformedProgram: (program) => {
          transformed = program;
        },
      },
    );

    expect(
      transformed?.files.some((file) =>
        file.name === `${FABRIC_MOUNT_ROOT}${dependency.entryIdentity}/main.tsx`
      ),
    ).toBe(true);
  });

  it("compiles already-resolved stored sources with fabric imports", async () => {
    const dependency = await publish(dependencyProgram(7));
    const modules = await engine.compileResolvedToRecordGraph(
      [
        {
          name: "/main.tsx",
          contents:
            `import { x } from "cf:pattern:${dependency.entryIdentity}";\nexport function y() { return x + 1; }`,
        },
      ],
      "/main.tsx",
      { fabricImports: { space } },
    );

    expect(
      modules.modules.some((module) =>
        module.identity === dependency.entryIdentity
      ),
    ).toBe(true);
  });
});
