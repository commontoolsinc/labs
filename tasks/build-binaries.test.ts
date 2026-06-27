import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { exists } from "@std/fs";
import { join } from "@std/path";

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

const FAKE_MANIFEST = `{
  // Frontend-only types, stripped for the shipped binary and restored on revert.
  "name": "fake",
  "compilerOptions": { "types": ["./x.d.ts"] }
}
`;

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
  await writeFile(`${root}/deno.jsonc`, FAKE_MANIFEST);
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

Deno.test("BuildConfig resolves workspace paths against the root", async () => {
  const root = await makeFakeRepo();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });

    assertEquals(config.root, root);
    assertEquals(config.cliOnly, true);
    assertEquals(config.workspaceManifestPath(), join(root, "deno.jsonc"));
    assertEquals(config.workspaceLockPath(), join(root, "deno.lock"));
    assertEquals(config.shellProjectPath(), join(root, "packages", "shell"));
    assertEquals(
      config.shellOutPath(),
      join(root, "packages", "shell", "dist"),
    );
    assertEquals(
      config.toolshedProjectPath(),
      join(root, "packages", "toolshed"),
    );
    assertEquals(
      config.toolshedShellFrontendPath(),
      join(root, "packages", "toolshed", "shell-frontend"),
    );
    assertEquals(
      config.toolshedShellFrontendPathDev(),
      join(root, "packages", "toolshed", "shell-frontend-dev"),
    );
    assertEquals(
      config.toolshedEntryPath(),
      join(root, "packages", "toolshed", "index.ts"),
    );
    assertEquals(
      config.bgPieceServiceEntryPath(),
      join(root, "packages", "background-piece-service", "src", "main.ts"),
    );
    assertEquals(
      config.bgPieceServiceWorkerPath(),
      join(root, "packages", "background-piece-service", "src", "worker.ts"),
    );
    assertEquals(
      config.toolshedEnvPath(),
      join(root, "packages", "toolshed", "COMPILED"),
    );
    assertEquals(
      config.staticAssetsPath(),
      join(root, "packages", "static", "assets"),
    );
    assertEquals(config.patternsPath(), join(root, "packages", "patterns"));
    assertEquals(
      config.staticTypesPath(),
      join(root, "packages", "static", "assets", "types"),
    );
    assertEquals(config.docsCommonPath(), join(root, "docs", "common"));
    assertEquals(
      config.cliEntryPath(),
      join(root, "packages", "cli", "mod.ts"),
    );
    assertEquals(
      config.cliMultiUserTestWorkerPath(),
      join(root, "packages", "cli", "lib", "multi-user-test-worker.ts"),
    );
    assertEquals(config.fusePackagePath(), join(root, "packages", "fuse"));
    assertEquals(config.distDir(), join(root, "dist"));
    assertEquals(config.distPath("cf"), join(root, "dist", "cf"));
    assertEquals(
      config.compileCacheVersionPath(),
      join(
        root,
        "packages",
        "runner",
        "src",
        "compilation-cache",
        "compile-cache-version.ts",
      ),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("manifest() returns an independent parsed copy each call", async () => {
  const root = await makeFakeRepo();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });

    const a = config.manifest();
    assertEquals(a.name, "fake");
    assertEquals(a.compilerOptions.types, ["./x.d.ts"]);

    // Mutating one copy must not affect the next: each call reparses the
    // original bytes.
    delete a.compilerOptions.types;
    const b = config.manifest();
    assertEquals(b.compilerOptions.types, ["./x.d.ts"]);

    // The original bytes are kept verbatim, comment included.
    assertEquals(config.manifestOriginal(), FAKE_MANIFEST);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("BuildConfig captures the committed version module and its path", async () => {
  const root = await makeFakeRepo();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
    assertEquals(config.compileCacheVersionOriginal(), SENTINEL_MODULE);
    assertEquals(
      config.compileCacheVersionPath(),
      join(
        root,
        "packages",
        "runner",
        "src",
        "compilation-cache",
        "compile-cache-version.ts",
      ),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("prepareWorkspace bakes the fingerprint; revertWorkspace restores the sentinel", async () => {
  const root = await makeFakeRepo();
  const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
  const versionPath = config.compileCacheVersionPath();
  const compiledPath = join(root, "packages", "toolshed", "COMPILED");
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
    const prepared = JSON.parse(await Deno.readTextFile(`${root}/deno.jsonc`));
    assertEquals(prepared.compilerOptions.types, undefined);
    assert(await exists(compiledPath), "COMPILED marker should be written");

    await revertWorkspace(config);

    // The version module, manifest bytes, and build marker are restored.
    assertEquals(await Deno.readTextFile(versionPath), SENTINEL_MODULE);
    assertEquals(await Deno.readTextFile(`${root}/deno.jsonc`), FAKE_MANIFEST);
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
