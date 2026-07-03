import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { exists } from "@std/fs";
import { fromFileUrl, join } from "@std/path";

import {
  BuildConfig,
  type BuildSignalApi,
  installBuildSignalCleanup,
  prepareWorkspace,
  revertWorkspace,
  runBuildWithSignalCleanup,
} from "./build-binaries.ts";
import {
  computeCompilerVersion,
  renderVersionModule,
  VERSION_NAMESPACE,
} from "../packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts";
import { SOURCE_COMPILE_CACHE_RUNTIME_VERSION } from "../packages/runner/src/compilation-cache/compile-cache-version.ts";

const FAKE_MANIFEST = `{
  // Frontend-only types, stripped for the shipped binary and restored on revert.
  "name": "fake",
  "compilerOptions": { "types": ["./x.d.ts"] }
}
`;

const SOURCE_VERSION_MODULE = renderVersionModule(
  SOURCE_COMPILE_CACHE_RUNTIME_VERSION,
);
const buildBinariesScript = fromFileUrl(
  new URL("./build-binaries.ts", import.meta.url),
);

type BuildSignal = Parameters<BuildSignalApi["addSignalListener"]>[0];
type BuildSignalHandler = Parameters<BuildSignalApi["addSignalListener"]>[1];

class FakeExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function makeFakeSignalApi(): {
  api: BuildSignalApi;
  listeners: Map<BuildSignal, BuildSignalHandler>;
  removed: [BuildSignal, BuildSignalHandler][];
  exitCodes: number[];
} {
  const listeners = new Map<BuildSignal, BuildSignalHandler>();
  const removed: [BuildSignal, BuildSignalHandler][] = [];
  const exitCodes: number[] = [];
  return {
    listeners,
    removed,
    exitCodes,
    api: {
      addSignalListener(signal, handler) {
        listeners.set(signal, handler);
      },
      removeSignalListener(signal, handler) {
        removed.push([signal, handler]);
        if (listeners.get(signal) === handler) {
          listeners.delete(signal);
        }
      },
      exit(code) {
        exitCodes.push(code);
        throw new FakeExit(code);
      },
    },
  };
}

async function writeFile(filePath: string, contents: string): Promise<void> {
  await Deno.mkdir(filePath.slice(0, filePath.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.writeTextFile(filePath, contents);
}

async function renderComputedVersionModule(root: string): Promise<string> {
  return renderVersionModule(await computeCompilerVersion(root));
}

/**
 * Build a minimal tree holding the files `build-binaries` reads and writes: a
 * manifest with a frontend-only `compilerOptions.types`, a lockfile, the
 * fingerprint input paths, the committed version module, and the toolshed
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
    `${root}/packages/runner/src/harness/pretransform.ts`,
    "export const pretransform = 1;",
  );
  await writeFile(
    `${root}/packages/runner/src/pattern-coverage.ts`,
    "export const patternCoverage = 1;",
  );
  await writeFile(
    `${root}/packages/runner/src/sandbox/module-record-verifier.ts`,
    "export const verifier = 1;",
  );
  await writeFile(
    `${root}/packages/static/assets/types/es2023.d.ts`,
    "declare const es2023: unique symbol;",
  );
  await writeFile(
    `${root}/packages/runner/src/compilation-cache/compile-cache-version.ts`,
    SOURCE_VERSION_MODULE,
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

Deno.test("BuildConfig captures the checked-in version module and its path", async () => {
  const root = await makeFakeRepo();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
    assertEquals(config.compileCacheVersionOriginal(), SOURCE_VERSION_MODULE);
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

Deno.test("prepareWorkspace writes the fingerprint; revertWorkspace restores the source version", async () => {
  const root = await makeFakeRepo();
  const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
  const versionPath = config.compileCacheVersionPath();
  const compiledPath = join(root, "packages", "toolshed", "COMPILED");
  const sourceModule = await Deno.readTextFile(versionPath);
  const computedModule = await renderComputedVersionModule(root);
  try {
    await prepareWorkspace(config);

    // The version module holds the compiler-input fingerprint baked into binaries.
    const stamped = await Deno.readTextFile(versionPath);
    assertEquals(stamped, computedModule);
    assertNotEquals(stamped, sourceModule);
    assertStringIncludes(stamped, `${VERSION_NAMESPACE}/`);

    // The frontend-only compiler option is stripped; the build marker is written.
    const prepared = JSON.parse(await Deno.readTextFile(`${root}/deno.jsonc`));
    assertEquals(prepared.compilerOptions.types, undefined);
    assert(await exists(compiledPath), "COMPILED marker should be written");

    await revertWorkspace(config);

    // The version module, manifest bytes, and build marker are restored.
    assertEquals(await Deno.readTextFile(versionPath), sourceModule);
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
    // The error path leaves the source version module untouched.
    assertEquals(
      await Deno.readTextFile(config.compileCacheVersionPath()),
      config.compileCacheVersionOriginal(),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("signal cleanup restores workspace and exits once", async () => {
  const root = await makeFakeRepo();
  const fakeSignals = makeFakeSignalApi();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
    const versionPath = config.compileCacheVersionPath();
    const compiledPath = join(root, "packages", "toolshed", "COMPILED");
    await prepareWorkspace(config);
    assertNotEquals(
      await Deno.readTextFile(versionPath),
      SOURCE_VERSION_MODULE,
    );
    assert(await exists(compiledPath), "COMPILED marker should exist");

    const cleanup = installBuildSignalCleanup(config, fakeSignals.api);
    assert(fakeSignals.listeners.has("SIGINT"));
    assert(fakeSignals.listeners.has("SIGTERM"));

    let thrown: unknown;
    try {
      await fakeSignals.listeners.get("SIGTERM")!();
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof FakeExit);
    assertEquals(thrown.code, 143);
    assertEquals(fakeSignals.exitCodes, [143]);
    assertEquals(await Deno.readTextFile(versionPath), SOURCE_VERSION_MODULE);
    assertEquals(await Deno.readTextFile(`${root}/deno.jsonc`), FAKE_MANIFEST);
    assert(!(await exists(compiledPath)), "COMPILED marker should be removed");

    await fakeSignals.listeners.get("SIGTERM")!();
    assertEquals(fakeSignals.exitCodes, [143]);

    cleanup();
    assertEquals(fakeSignals.listeners.size, 0);
    assertEquals(
      fakeSignals.removed.map(([signal]) => signal).sort(),
      ["SIGINT", "SIGTERM"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runBuildWithSignalCleanup removes listeners after build", async () => {
  const root = await makeFakeRepo();
  const fakeSignals = makeFakeSignalApi();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
    const seenConfigs: BuildConfig[] = [];
    await runBuildWithSignalCleanup(config, {
      signalApi: fakeSignals.api,
      build: (received) => {
        seenConfigs.push(received);
        return Promise.resolve();
      },
    });

    assertEquals(seenConfigs, [config]);
    assertEquals(fakeSignals.listeners.size, 0);
    assertEquals(
      fakeSignals.removed.map(([signal]) => signal).sort(),
      ["SIGINT", "SIGTERM"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main build path reverts workspace when command spawn fails", async () => {
  const root = await makeFakeRepo();
  try {
    const config = new BuildConfig({ root, toolshedFlags: [], cliOnly: true });
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--deny-run",
        buildBinariesScript,
        "--cli-only",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.success, false);
    assertEquals(
      await Deno.readTextFile(config.compileCacheVersionPath()),
      SOURCE_VERSION_MODULE,
    );
    assertEquals(await Deno.readTextFile(`${root}/deno.jsonc`), FAKE_MANIFEST);
    assert(
      !(await exists(config.toolshedEnvPath())),
      "COMPILED marker should be removed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
