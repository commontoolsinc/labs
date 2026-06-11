import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  InMemoryProgram,
  type Program,
  type Source,
} from "@commonfabric/js-compiler";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  computeModuleHashes,
  resolveModuleImports,
} from "../src/harness/module-identity.ts";
import type { CacheableModule } from "../src/harness/types.ts";
import {
  sourceDocKey,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";
import { FabricAwareResolver } from "../src/harness/fabric-resolver.ts";
import { FABRIC_MOUNT_ROOT } from "../src/sandbox/module-record-compiler.ts";

const signer = await Identity.fromPassphrase("fabric resolver test");
const space = signer.did();
const otherSpace = "did:key:z6MkFabricResolverOtherSpace";
const MISSING_HASH = "Bvcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";

const PROGRAM: Program = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        `import { value } from "./dep.ts";`,
        `export const result = value + 1;`,
      ].join("\n"),
    },
    {
      name: "/dep.ts",
      contents: `export const value = 41;`,
    },
  ],
};

function toModules(
  program: Program,
): { modules: CacheableModule[]; entryIdentity: string } {
  const ids = computeModuleHashes(program);
  const edges = resolveModuleImports(program);
  const modules = program.files.map((file) => ({
    identity: ids.get(file.name)!,
    filename: file.name,
    source: file.contents,
    js: `/* compiled */ ${file.name}`,
    imports: (edges.get(file.name)?.internalDeps ?? []).map((dep) => ({
      specifier: dep.specifier,
      targetIdentity: ids.get(dep.target)!,
    })),
  }));
  return { modules, entryIdentity: ids.get(program.main)! };
}

function innerProgram(source = `export {};`) {
  return new InMemoryProgram("/importer.tsx", { "/importer.tsx": source });
}

describe("FabricAwareResolver", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  async function publish(program: Program = PROGRAM): Promise<string> {
    const { modules, entryIdentity } = toModules(program);
    const tx = runtime.edit();
    writeSourceDocs(runtime, space, modules, entryIdentity, tx);
    await tx.commit();
    return entryIdentity;
  }

  it("fetches a pinned same-space pattern and mounts its verified source closure", async () => {
    const entryIdentity = await publish();
    const specifier = `cf:pattern:${entryIdentity}`;
    const resolver = new FabricAwareResolver(innerProgram(), {
      runtime,
      space,
    });

    const entry = await resolver.resolveSource(specifier);
    const entryPath = `${FABRIC_MOUNT_ROOT}${entryIdentity}/main.tsx`;

    expect(entry).toEqual({
      name: entryPath,
      contents: PROGRAM.files[0].contents,
    });
    expect(await resolver.resolveSource(entryPath)).toBe(entry);
    expect(resolver.specifierAliases().get(specifier)).toBe(entryPath);
    expect(resolver.mounts()).toEqual([
      { entryIdentity, entryPath, specifiers: [specifier] },
    ]);

    const depPath = `${FABRIC_MOUNT_ROOT}${entryIdentity}/dep.ts`;
    expect((await resolver.resolveSource(depPath))?.contents).toBe(
      PROGRAM.files[1].contents,
    );
  });

  it("reports missing or tampered source closures as not found", async () => {
    const resolver = new FabricAwareResolver(innerProgram(), {
      runtime,
      space,
    });
    await expect(
      resolver.resolveSource(`cf:pattern:${MISSING_HASH}`),
    ).rejects.toThrow(
      `source for pattern:${MISSING_HASH} not found in space ${space} (or failed integrity verification)`,
    );

    const entryIdentity = await publish({
      main: "/main.tsx",
      files: [
        { name: "/main.tsx", contents: "export const value = 1;" },
      ],
    });
    const tx = runtime.edit();
    runtime.getCell(space, sourceDocKey(entryIdentity), undefined, tx).set({
      kind: "source",
      identity: entryIdentity,
      code: "export const value = 2;",
      filename: "/main.tsx",
      imports: [],
    });
    await tx.commit();

    await expect(
      resolver.resolveSource(`cf:pattern:${entryIdentity}`),
    ).rejects.toThrow(
      `source for pattern:${entryIdentity} not found in space ${space} (or failed integrity verification)`,
    );
  });

  it("rejects root-absolute imports inside imported patterns", async () => {
    const program: Program = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents:
            `import { value } from "/dep.ts"; export const result = value;`,
        },
        { name: "/dep.ts", contents: `export const value = 1;` },
      ],
    };
    const entryIdentity = await publish(program);
    const resolver = new FabricAwareResolver(innerProgram(), {
      runtime,
      space,
    });

    await expect(
      resolver.resolveSource(`cf:pattern:${entryIdentity}`),
    ).rejects.toThrow(
      `imported pattern ${entryIdentity} uses root-absolute imports; not supported`,
    );
  });

  it("dedupes different specifier texts pinned to the same identity", async () => {
    const entryIdentity = await publish();
    const direct = `cf:pattern:${entryIdentity}`;
    const pinnedSlug = `cf:dep@${entryIdentity}`;
    const resolver = new FabricAwareResolver(innerProgram(), {
      runtime,
      space,
    });

    const first = await resolver.resolveSource(direct);
    const second = await resolver.resolveSource(pinnedSlug);

    expect(second).toBe(first);
    expect(resolver.mounts()).toEqual([
      {
        entryIdentity,
        entryPath: `${FABRIC_MOUNT_ROOT}${entryIdentity}/main.tsx`,
        specifiers: [direct, pinnedSlug],
      },
    ]);
    expect(resolver.specifierAliases()).toEqual(
      new Map([
        [direct, `${FABRIC_MOUNT_ROOT}${entryIdentity}/main.tsx`],
        [pinnedSlug, `${FABRIC_MOUNT_ROOT}${entryIdentity}/main.tsx`],
      ]),
    );
  });

  it("throws M1 scope errors for mutable, cross-space, cross-host, and subpath refs", async () => {
    const entryIdentity = await publish();
    const resolver = new FabricAwareResolver(innerProgram(), {
      runtime,
      space,
    });
    const cases: Array<[string, string]> = [
      [
        "cf:dep",
        "fabric ref requires resolution of a mutable pointer — not yet supported (M2)",
      ],
      [
        `cf:/${otherSpace}/pattern:${entryIdentity}`,
        "cross-space fabric refs not yet supported (M2)",
      ],
      [
        `cf://example.com/${space}/pattern:${entryIdentity}`,
        "cross-host fabric refs not yet supported (M3)",
      ],
      [
        `cf:pattern:${entryIdentity}/schema`,
        "subpaths not yet supported (M4)",
      ],
    ];

    for (const [specifier, message] of cases) {
      await expect(resolver.resolveSource(specifier)).rejects.toThrow(message);
    }
  });

  it("delegates non-fabric specifiers and main() to the wrapped resolver", async () => {
    const source: Source = {
      name: "/dep.ts",
      contents: "export const value = 1;",
    };
    const resolver = new FabricAwareResolver(
      new InMemoryProgram("/main.tsx", {
        "/main.tsx": `import { value } from "./dep.ts";`,
        "/dep.ts": source.contents,
      }),
      { runtime, space },
    );

    expect(await resolver.main()).toEqual({
      name: "/main.tsx",
      contents: `import { value } from "./dep.ts";`,
    });
    expect(await resolver.resolveSource(source.name)).toEqual(source);
  });
});
