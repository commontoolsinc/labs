import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { exists } from "@std/fs";

import {
  BuildConfig,
  prepareWorkspace,
  revertWorkspace,
} from "./build-binaries.ts";
import {
  renderVersionModule,
  SENTINEL_VERSION,
  VERSION_NAMESPACE,
} from "../packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts";

const SENTINEL_MODULE = renderVersionModule(SENTINEL_VERSION);

async function writeFile(filePath: string, contents: string): Promise<void> {
  await Deno.mkdir(filePath.slice(0, filePath.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.writeTextFile(filePath, contents);
}

/**
 * Build a minimal tree holding the files `build-binaries` reads and writes: a
 * manifest with a frontend-only `compilerOptions.types`, a lockfile, the
 * fingerprint input packages, the committed version module, and the toolshed
 * directory for the COMPILED build marker.
 */
async function makeFakeRepo(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "build-binaries-" });
  await writeFile(
    `${root}/deno.json`,
    JSON.stringify({ name: "fake", compilerOptions: { types: ["./x.d.ts"] } }),
  );
  await writeFile(`${root}/deno.lock`, '{"version":"4"}\n');
  for (
    const pkg of ["ts-transformers", "js-compiler", "schema-generator", "api"]
  ) {
    await writeFile(
      `${root}/packages/${pkg}/src/mod.ts`,
      "export const x = 1;",
    );
  }
  await writeFile(
    `${root}/packages/runner/src/compilation-cache/compile-cache-version.ts`,
    SENTINEL_MODULE,
  );
  await Deno.mkdir(`${root}/packages/toolshed`, { recursive: true });
  return root;
}

Deno.test("BuildConfig captures the committed version module and its path", async () => {
  const root = await makeFakeRepo();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
    assertEquals(config.compileCacheVersionOriginal(), SENTINEL_MODULE);
    assertEquals(
      config.compileCacheVersionPath(),
      `${root}/packages/runner/src/compilation-cache/compile-cache-version.ts`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("prepareWorkspace bakes the fingerprint; revertWorkspace restores the sentinel", async () => {
  const root = await makeFakeRepo();
  const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
  const versionPath = config.compileCacheVersionPath();
  const compiledPath = `${root}/packages/toolshed/COMPILED`;
  try {
    await prepareWorkspace(config);

    // The version module now holds a baked fingerprint, not the sentinel.
    const stamped = await Deno.readTextFile(versionPath);
    assertNotEquals(stamped, SENTINEL_MODULE);
    assertStringIncludes(stamped, `${VERSION_NAMESPACE}/`);
    assert(
      !stamped.includes(SENTINEL_VERSION),
      "the baked module must not keep the from-source sentinel",
    );

    // The frontend-only compiler option is stripped; the build marker is written.
    const manifest = JSON.parse(await Deno.readTextFile(`${root}/deno.json`));
    assertEquals(manifest.compilerOptions.types, undefined);
    assert(await exists(compiledPath), "COMPILED marker should be written");

    await revertWorkspace(config);

    // The version module and manifest are restored; the build marker is removed.
    assertEquals(await Deno.readTextFile(versionPath), SENTINEL_MODULE);
    const restored = JSON.parse(await Deno.readTextFile(`${root}/deno.json`));
    assertEquals(restored.compilerOptions.types, ["./x.d.ts"]);
    assert(!(await exists(compiledPath)), "COMPILED marker should be removed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("prepareWorkspace refuses to build without a lockfile", async () => {
  const root = await makeFakeRepo();
  try {
    await Deno.remove(`${root}/deno.lock`);
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
    await assertRejects(() => prepareWorkspace(config), Error, "deno.lock");
    // The early bail-out leaves the committed version module untouched.
    assertEquals(
      await Deno.readTextFile(config.compileCacheVersionPath()),
      SENTINEL_MODULE,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
