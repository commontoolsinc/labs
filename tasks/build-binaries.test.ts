import { assert, assertEquals, assertRejects } from "@std/assert";
import { exists } from "@std/fs";
import { join } from "@std/path";

import {
  BuildConfig,
  prepareWorkspace,
  revertWorkspace,
} from "./build-binaries.ts";

// A workspace manifest carrying a comment, so the revert test can prove the
// file is restored byte-for-byte rather than reserialized (which would drop the
// comment and reformat the file).
const FAKE_MANIFEST = `{
  // Frontend-only types, stripped for the shipped binary and restored on revert.
  "name": "fake",
  "compilerOptions": { "types": ["./x.d.ts"] }
}
`;

async function writeFile(filePath: string, contents: string): Promise<void> {
  await Deno.mkdir(filePath.slice(0, filePath.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.writeTextFile(filePath, contents);
}

// Build a minimal tree holding the files `prepareWorkspace`/`revertWorkspace`
// touch: the workspace manifest, a lockfile, and the toolshed directory that
// receives the COMPILED build marker.
async function makeFakeRepo(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "build-binaries-" });
  await writeFile(`${root}/deno.jsonc`, FAKE_MANIFEST);
  await writeFile(`${root}/deno.lock`, '{"version":"4"}\n');
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

Deno.test("prepareWorkspace strips frontend types and writes the build marker; revertWorkspace restores both", async () => {
  const root = await makeFakeRepo();
  const compiledPath = join(root, "packages", "toolshed", "COMPILED");
  try {
    // One config captures the original manifest bytes up front, exactly as the
    // build does before `prepareWorkspace` mutates the file.
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });

    await prepareWorkspace(config);

    // The frontend-only compiler option is stripped during the build.
    const prepared = JSON.parse(await Deno.readTextFile(`${root}/deno.jsonc`));
    assertEquals(prepared.compilerOptions.types, undefined);
    assert(await exists(compiledPath), "COMPILED marker should be written");

    await revertWorkspace(config);

    // The manifest is restored byte-for-byte, comment included.
    assertEquals(
      await Deno.readTextFile(`${root}/deno.jsonc`),
      FAKE_MANIFEST,
      "revert must restore the manifest byte-for-byte",
    );
    assert(
      !(await exists(compiledPath)),
      "COMPILED marker should be removed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("prepareWorkspace refuses to build without a lockfile", async () => {
  const root = await makeFakeRepo();
  try {
    await Deno.remove(`${root}/deno.lock`);
    await assertRejects(
      () =>
        prepareWorkspace(
          new BuildConfig({ root, toolshedFlags: [], cliOnly: true }),
        ),
      Error,
      "Cannot build binaries without",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
