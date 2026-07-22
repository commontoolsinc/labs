import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getPatternIdentityRef,
  getPatternRepository,
  getPatternSource,
  PATTERN_RESPONSE_BUILD_HEADER,
  resolveEntryIdentity,
  Runtime,
  type VersionSkewInfo,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createSession, Identity } from "@commonfabric/identity";
import { PieceManager } from "../src/manager.ts";
import {
  DEFAULT_APP_PATTERN_URL,
  HOME_PATTERN_URL,
  PiecesController,
} from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("check update default pattern");

const patternSource = (marker: string) =>
  [
    "import { pattern } from 'commonfabric';",
    `export default pattern<{ items: string[] }>(({ items }) => ({ items, marker: "${marker}" }));`,
    "",
  ].join("\n");

const SOURCE_V1 = patternSource("v1");
const SOURCE_V2 = patternSource("v2");

const BUILD_SHA = "build-sha-1";
const IMPORTED_MODULE_URL = "/api/patterns/system/update-marker.ts";

// A same-host custom-app path, as home config would supply via
// `defaultAppUrl` (a published custom app, NOT a system pattern).
const CUSTOM_APP_URL = "/api/patterns/custom/my-app.tsx";

/** Content identity a toolshed at this build would serve for `source`. */
function identityForSource(
  source: string,
  imports: Record<string, string> = {},
  entry = DEFAULT_APP_PATTERN_URL,
): Promise<string> {
  return resolveEntryIdentity(
    entry,
    (name) => {
      if (name === entry) return Promise.resolve(source);
      if (Object.hasOwn(imports, name)) return Promise.resolve(imports[name]);
      return Promise.reject(new Error(`not found: ${name}`));
    },
  );
}

interface StubControls {
  setSource(source: string): void;
  setCustomSource(source: string | null): void;
  setIdentitySource(source: string): void;
  setGitSha(sha: string | null): void;
  setIdentityBuildSha(sha: string | null): void;
  setSourceBuildSha(sha: string | null): void;
  setImport(path: string, source: string): void;
  setImportBuildSha(sha: string | null): void;
  failIdentity(fail: boolean): void;
  identityFetches(): number;
  sourceFetches(): number;
  requestedHrefs(): string[];
  restore(): void;
}

function installFetchStub(): StubControls {
  const original = globalThis.fetch;
  let source = SOURCE_V1;
  // Served at CUSTOM_APP_URL when set; null keeps the path unserved (404).
  let customSource: string | null = null;
  let identitySource: string | undefined;
  let gitSha: string | null = BUILD_SHA;
  let identityBuildSha: string | null = BUILD_SHA;
  let sourceBuildSha: string | null = BUILD_SHA;
  let importBuildSha: string | null = BUILD_SHA;
  const imports: Record<string, string> = {};
  let failIdentityFetch = false;
  let identityFetchCount = 0;
  let sourceFetchCount = 0;
  const requestedHrefs: string[] = [];

  const patternHeaders = (
    contentType: string,
    buildSha: string | null,
  ): HeadersInit => ({
    "content-type": contentType,
    ...(buildSha === null ? {} : { [PATTERN_RESPONSE_BUILD_HEADER]: buildSha }),
  });

  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const url = new URL(href);
    requestedHrefs.push(url.href);

    if (url.pathname === "/api/meta") {
      return new Response(JSON.stringify({ did: "did:x", gitSha }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (
      url.pathname === DEFAULT_APP_PATTERN_URL ||
      url.pathname === HOME_PATTERN_URL
    ) {
      if (url.searchParams.has("identity")) {
        identityFetchCount++;
        if (failIdentityFetch) throw new Error("identity fetch failed");
        return new Response(
          await identityForSource(
            identitySource ?? source,
            imports,
            url.pathname,
          ),
          { headers: patternHeaders("text/plain", identityBuildSha) },
        );
      }
      sourceFetchCount++;
      return new Response(source, {
        headers: patternHeaders("text/typescript-jsx", sourceBuildSha),
      });
    }

    if (url.pathname === CUSTOM_APP_URL && customSource !== null) {
      if (url.searchParams.has("identity")) {
        identityFetchCount++;
        if (failIdentityFetch) throw new Error("identity fetch failed");
        return new Response(
          await identityForSource(customSource, imports, CUSTOM_APP_URL),
          { headers: patternHeaders("text/plain", identityBuildSha) },
        );
      }
      sourceFetchCount++;
      return new Response(customSource, {
        headers: patternHeaders("text/typescript-jsx", sourceBuildSha),
      });
    }

    if (Object.hasOwn(imports, url.pathname)) {
      sourceFetchCount++;
      return new Response(imports[url.pathname], {
        headers: patternHeaders("text/typescript", importBuildSha),
      });
    }

    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    setSource: (s) => (source = s),
    setCustomSource: (s) => (customSource = s),
    setIdentitySource: (s) => (identitySource = s),
    setGitSha: (s) => (gitSha = s),
    setIdentityBuildSha: (s) => (identityBuildSha = s),
    setSourceBuildSha: (s) => (sourceBuildSha = s),
    setImport: (path, s) => (imports[path] = s),
    setImportBuildSha: (s) => (importBuildSha = s),
    failIdentity: (f) => (failIdentityFetch = f),
    identityFetches: () => identityFetchCount,
    sourceFetches: () => sourceFetchCount,
    requestedHrefs: () => [...requestedHrefs],
    restore: () => (globalThis.fetch = original),
  };
}

describe("checkAndUpdateDefaultPattern", () => {
  let stub: StubControls;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;
  let controller: PiecesController;
  let versionSkews: VersionSkewInfo[];

  async function setup(
    experimental: Record<string, boolean>,
    clientVersion: string | undefined = BUILD_SHA,
  ) {
    versionSkews = [];
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      clientVersion,
      experimental,
      onVersionSkew: (info) => versionSkews.push(info),
    });
    const session = await createSession({
      identity: signer,
      spaceName: "update-space-" + crypto.randomUUID(),
    });
    manager = new PieceManager(session, runtime);
    await manager.synced();
    controller = new PiecesController(manager);
  }

  async function setupHome(
    experimental: Record<string, boolean>,
    clientVersion: string | undefined = BUILD_SHA,
    extraRuntimeOptions: { cfcEnforcementMode?: "disabled" } = {},
  ) {
    versionSkews = [];
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      clientVersion,
      experimental,
      onVersionSkew: (info) => versionSkews.push(info),
      ...extraRuntimeOptions,
    });
    const session = await createSession({
      identity: signer,
      spaceDid: signer.did(),
    });
    expect(session.space).toBe(runtime.userIdentityDID);
    manager = new PieceManager(session, runtime);
    await manager.synced();
    controller = new PiecesController(manager);
  }

  beforeEach(() => {
    stub = installFetchStub();
    stub.setSource(SOURCE_V1);
  });

  afterEach(async () => {
    try {
      await controller?.dispose();
    } catch { /* already disposed */ }
    await storageManager?.close();
    stub.restore();
  });

  it("returns skipped-disabled when the flag is off", async () => {
    await setup({});
    await controller.ensureDefaultPattern();
    expect(await controller.checkAndUpdateDefaultPattern()).toBe(
      "skipped-disabled",
    );
  });

  it("returns current when the identity is unchanged (no write)", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell())?.identity;

    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");

    const after = getPatternIdentityRef(piece.getCell())?.identity;
    expect(after).toBe(before);
    expect(after).toBe(await identityForSource(SOURCE_V1));
  });

  it("leaves a root without a pattern identity untouched", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const identityFetchesBefore = stub.identityFetches();
    const { error } = await runtime.editWithRetry((tx) => {
      piece.getCell().withTx(tx).setMetaRaw("patternIdentity", "missing");
    });
    expect(error).toBeUndefined();
    const root = (await manager.getDefaultPattern(false))!;

    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(root)).toBeUndefined();
    expect(stub.identityFetches()).toBe(identityFetchesBefore);
  });

  it("rolls the root forward in place on a changed identity", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const rootLinkBefore = JSON.stringify(piece.getCell().getAsLink());
    const idV1 = getPatternIdentityRef(piece.getCell())?.identity;

    stub.setSource(SOURCE_V2);
    expect(await controller.checkAndUpdateDefaultPattern()).toBe("updated");
    await runtime.idle();

    const root = (await manager.getDefaultPattern(false))!;
    // Same piece entity — no new piece minted; the update wrote a new
    // patternIdentity onto the existing result cell (the watcher re-instantiates
    // the new pattern in place — its own machinery, exercised elsewhere).
    expect(JSON.stringify(root.getAsLink())).toBe(rootLinkBefore);
    const idV2 = getPatternIdentityRef(root)?.identity;
    expect(idV2).toBe(await identityForSource(SOURCE_V2));
    expect(idV2).not.toBe(idV1);
  });

  it("reconciles an unloadable stale root before ensure starts it", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    const rootLinkBefore = JSON.stringify(root.getAsLink());

    // Simulate a root left behind by an older runtime whose stored pattern can
    // no longer be loaded by this one. The identity is well-formed but its
    // source closure was never persisted, so any attempt to start it fails.
    const staleIdentity = await identityForSource(
      patternSource("unloadable-stale-root"),
    );
    await manager.stopPiece(root);
    const { error } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: staleIdentity,
        symbol: "default",
      });
    });
    expect(error).toBeUndefined();
    const staleRoot = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(staleRoot)?.identity).toBe(staleIdentity);

    // A newer system root is available from the matching toolshed build. The
    // ensure path must install this identity before start() sees the stale one.
    stub.setSource(SOURCE_V2);
    runtime.clearPatternUpdateCaches();

    const updated = await controller.ensureDefaultPattern();
    await runtime.idle();

    expect(JSON.stringify(updated.getCell().getAsLink())).toBe(rootLinkBefore);
    expect(getPatternIdentityRef(updated.getCell())?.identity).toBe(
      await identityForSource(SOURCE_V2),
    );
  });

  it("repairs persisted artifacts when the served identity is unchanged", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const currentRef = getPatternIdentityRef(piece.getCell())!;
    const sourceFetchesBefore = stub.sourceFetches();
    const originalLoad = runtime.patternManager.loadPatternByIdentity;
    let loadAttempts = 0;
    runtime.patternManager.loadPatternByIdentity =
      ((identity, symbol, space) => {
        loadAttempts++;
        if (loadAttempts === 1 && identity === currentRef.identity) {
          return Promise.resolve(undefined);
        }
        return originalLoad.call(
          runtime.patternManager,
          identity,
          symbol,
          space,
        );
      }) as typeof runtime.patternManager.loadPatternByIdentity;

    try {
      expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
      expect(loadAttempts).toBe(1);
      expect(stub.sourceFetches()).toBe(sourceFetchesBefore + 1);
      await expect(
        originalLoad.call(
          runtime.patternManager,
          currentRef.identity,
          currentRef.symbol,
          manager.getSpace(),
        ),
      ).resolves.toBeDefined();
    } finally {
      runtime.patternManager.loadPatternByIdentity = originalLoad;
    }
  });

  it("reconciles a persisted root discovered after a creation race", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const existing = await controller.ensureDefaultPattern();
    const rootLinkBefore = JSON.stringify(existing.getCell().getAsLink());
    const originalGetDefaultPattern = manager.getDefaultPattern;
    const originalGetSpaceCellContents = manager.getSpaceCellContents;
    const originalCheck = controller.checkAndUpdateDefaultPattern;
    let firstLookup = true;
    let updateChecks = 0;

    // Model the retry after another writer wins: the first pre-transaction
    // lookup saw no root, while the transaction's double-check now sees one.
    manager.getDefaultPattern = ((runIt?: boolean) => {
      if (firstLookup) {
        firstLookup = false;
        return Promise.resolve(undefined);
      }
      return originalGetDefaultPattern.call(manager, runIt);
    }) as typeof manager.getDefaultPattern;
    manager.getSpaceCellContents = (() => ({
      withTx: () => ({
        key: (key: string) => {
          expect(key).toBe("defaultPattern");
          return { get: () => ({ get: () => ({}) }) };
        },
      }),
    })) as unknown as typeof manager.getSpaceCellContents;
    controller.checkAndUpdateDefaultPattern = ((root) => {
      updateChecks++;
      return originalCheck.call(controller, root);
    }) as typeof controller.checkAndUpdateDefaultPattern;

    try {
      const raced = await controller.ensureDefaultPattern();
      expect(JSON.stringify(raced.getCell().getAsLink())).toBe(rootLinkBefore);
      expect(updateChecks).toBe(1);
    } finally {
      manager.getDefaultPattern = originalGetDefaultPattern;
      manager.getSpaceCellContents = originalGetSpaceCellContents;
      controller.checkAndUpdateDefaultPattern = originalCheck;
    }
  });

  it("skips and reports version skew when builds differ", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell())?.identity;

    stub.setSource(SOURCE_V2);
    stub.setGitSha("a-different-build");

    expect(await controller.checkAndUpdateDefaultPattern()).toBe(
      "skipped-skew",
    );
    // No write.
    expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(before);
    // Exactly one versionSkew signal, with the mismatched builds.
    expect(versionSkews.length).toBe(1);
    expect(versionSkews[0].clientVersion).toBe(BUILD_SHA);
    expect(versionSkews[0].toolshedVersion).toBe("a-different-build");
  });

  it("rejects identity served by a different build than /api/meta", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell());
    const sourceFetchesBefore = stub.sourceFetches();

    stub.setSource(SOURCE_V2);
    stub.setIdentityBuildSha("rolling-deploy-build");

    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
    expect(stub.identityFetches()).toBe(1);
    expect(stub.sourceFetches()).toBe(sourceFetchesBefore);
  });

  it("rejects source served by a different build than its identity", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell());
    const sourceFetchesBefore = stub.sourceFetches();

    stub.setSource(SOURCE_V2);
    stub.setSourceBuildSha("rolling-deploy-build");

    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
    expect(stub.identityFetches()).toBe(1);
    expect(stub.sourceFetches()).toBe(sourceFetchesBefore + 1);
  });

  it("rejects an imported module served by a different build", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell());
    const sourceFetchesBefore = stub.sourceFetches();

    stub.setImport(
      IMPORTED_MODULE_URL,
      'export const marker = "v2-from-import";\n',
    );
    stub.setSource([
      "import { pattern } from 'commonfabric';",
      "import { marker } from './update-marker.ts';",
      "export default pattern<{ items: string[] }>(({ items }) => ({ items, marker }));",
      "",
    ].join("\n"));
    stub.setImportBuildSha("rolling-deploy-build");

    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
    expect(stub.identityFetches()).toBe(1);
    expect(stub.sourceFetches()).toBe(sourceFetchesBefore + 2);
  });

  it("rejects source whose compiled identity differs from ?identity", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell());
    const sourceFetchesBefore = stub.sourceFetches();

    stub.setIdentitySource(SOURCE_V2);
    stub.setSource(patternSource("different-source-response"));

    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
    expect(stub.identityFetches()).toBe(1);
    expect(stub.sourceFetches()).toBe(sourceFetchesBefore + 1);
  });

  it("skips silently when both builds are unknown (dev servers)", async () => {
    // Local dev: a source-run toolshed serves gitSha null and a dev shell
    // build carries no COMMIT_SHA. Nothing is provably newer, so the check
    // must skip WITHOUT the versionSkew signal — the signal raises the
    // shell's "reload to update" banner, which would appear on every space
    // open in local dev where no reload can help.
    await setup({ systemPatternAutoUpdate: true }, undefined);
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell())?.identity;

    stub.setSource(SOURCE_V2);
    stub.setGitSha(null);

    expect(await controller.checkAndUpdateDefaultPattern()).toBe(
      "skipped-unknown-build",
    );
    // No write, no signal, and the gate failed before any ?identity fetch.
    expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(before);
    expect(versionSkews.length).toBe(0);
    expect(stub.identityFetches()).toBe(0);
  });

  it("skips silently when only the toolshed build is unknown", async () => {
    // A known client build against a sha-less toolshed proves nothing either
    // — only a KNOWN, DIFFERENT pair is a skew worth surfacing.
    await setup({ systemPatternAutoUpdate: true });
    await controller.ensureDefaultPattern();

    stub.setGitSha(null);

    expect(await controller.checkAndUpdateDefaultPattern()).toBe(
      "skipped-unknown-build",
    );
    expect(versionSkews.length).toBe(0);
    expect(stub.identityFetches()).toBe(0);
  });

  it("caches ?identity and re-fetches after the caches are cleared", async () => {
    await setup({ systemPatternAutoUpdate: true });
    await controller.ensureDefaultPattern();

    await controller.checkAndUpdateDefaultPattern();
    await controller.checkAndUpdateDefaultPattern();
    expect(stub.identityFetches()).toBe(1);

    runtime.clearPatternUpdateCaches();
    await controller.checkAndUpdateDefaultPattern();
    expect(stub.identityFetches()).toBe(2);
  });

  it("never throws when identity lookup fails or rejects unexpectedly", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell())?.identity;

    stub.failIdentity(true);
    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");

    // The Runtime normally converts fetch failures to undefined. Also defend
    // the controller boundary against an unexpected rejected lookup.
    const originalCachedIdentity = runtime.cachedPatternIdentity;
    runtime.cachedPatternIdentity = () =>
      Promise.reject(new Error("unexpected identity lookup rejection"));
    try {
      expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    } finally {
      runtime.cachedPatternIdentity = originalCachedIdentity;
    }

    expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(before);
  });

  it("back-fills provenance when a legacy root is the current official identity", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const { error } = await runtime.editWithRetry((tx) => {
      piece.getCell().withTx(tx).setMetaRaw("patternSource", undefined);
    });
    expect(error).toBeUndefined();
    const legacyRoot = (await manager.getDefaultPattern(false))!;
    expect(getPatternSource(legacyRoot)).toBeUndefined();

    expect(await controller.checkAndUpdateDefaultPattern()).toBe(
      "repaired-provenance",
    );

    const root = (await manager.getDefaultPattern(false))!;
    expect(getPatternSource(root)).toBe(DEFAULT_APP_PATTERN_URL);
    expect(getPatternIdentityRef(root)?.identity).toBe(
      await identityForSource(SOURCE_V1),
    );
  });

  it("keeps a legacy root unchanged when provenance repair cannot commit", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const { error } = await runtime.editWithRetry((tx) => {
      piece.getCell().withTx(tx).setMetaRaw("patternSource", undefined);
    });
    expect(error).toBeUndefined();
    const root = (await manager.getDefaultPattern(false))!;
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    runtime.editWithRetry = (() =>
      Promise.resolve({
        error: {
          name: "StorageTransactionAborted" as const,
          message: "provenance repair rejected",
          reason: new Error("test rejection"),
        },
      })) as typeof runtime.editWithRetry;

    try {
      expect(await controller.checkAndUpdateDefaultPattern(root)).toBe(
        "current",
      );
      expect(getPatternSource(root)).toBeUndefined();
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("repairs provenance through the source path when loading the current artifact throws", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const { error } = await runtime.editWithRetry((tx) => {
      piece.getCell().withTx(tx).setMetaRaw("patternSource", undefined);
    });
    expect(error).toBeUndefined();

    const originalLoad = runtime.patternManager.loadPatternByIdentity;
    const sourceFetchesBefore = stub.sourceFetches();
    let firstLoad = true;
    runtime.patternManager.loadPatternByIdentity =
      ((identity, symbol, space) => {
        if (firstLoad) {
          firstLoad = false;
          throw new Error("persisted artifact is unreadable");
        }
        return originalLoad.call(
          runtime.patternManager,
          identity,
          symbol,
          space,
        );
      }) as typeof runtime.patternManager.loadPatternByIdentity;

    try {
      expect(await controller.checkAndUpdateDefaultPattern()).toBe(
        "repaired-provenance",
      );
      expect(stub.sourceFetches()).toBe(sourceFetchesBefore + 1);
      expect(getPatternSource(piece.getCell())).toBe(DEFAULT_APP_PATTERN_URL);
    } finally {
      runtime.patternManager.loadPatternByIdentity = originalLoad;
    }
  });

  it("does not stamp provenance after a concurrent custom-root replacement", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    await manager.stopPiece(root);
    const { error } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternSource", undefined);
    });
    expect(error).toBeUndefined();
    const legacyRoot = (await manager.getDefaultPattern(false))!;

    const loadStarted = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<void>();
    const originalLoad = runtime.patternManager.loadPatternByIdentity;
    runtime.patternManager.loadPatternByIdentity = (async () => {
      loadStarted.resolve();
      await releaseLoad.promise;
      return undefined;
    }) as typeof runtime.patternManager.loadPatternByIdentity;

    try {
      const update = controller.checkAndUpdateDefaultPattern(legacyRoot);
      await loadStarted.promise;

      const customRef = {
        identity: await identityForSource(patternSource("concurrent-custom")),
        symbol: "default",
      };
      const repository = "https://github.com/example/concurrent-pattern";
      const replacement = await runtime.editWithRetry((tx) => {
        const txRoot = legacyRoot.withTx(tx);
        txRoot.setMetaRaw("patternIdentity", customRef);
        txRoot.setMetaRaw("patternRepository", repository);
      });
      expect(replacement.error).toBeUndefined();

      releaseLoad.resolve();
      expect(await update).toBe("current");

      const current = (await manager.getDefaultPattern(false))!;
      expect(getPatternIdentityRef(current)).toEqual(customRef);
      expect(getPatternRepository(current)).toBe(repository);
      expect(getPatternSource(current)).toBeUndefined();
    } finally {
      releaseLoad.resolve();
      runtime.patternManager.loadPatternByIdentity = originalLoad;
    }
  });

  it("does not swap identity after a concurrent custom-root replacement", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    await manager.stopPiece(root);

    const compileStarted = Promise.withResolvers<void>();
    const releaseCompile = Promise.withResolvers<void>();
    const originalCompile = runtime.patternManager.compilePattern;
    runtime.patternManager.compilePattern = (async (input, cacheCtx) => {
      compileStarted.resolve();
      await releaseCompile.promise;
      return await originalCompile.call(
        runtime.patternManager,
        input,
        cacheCtx,
      );
    }) as typeof runtime.patternManager.compilePattern;
    stub.setSource(SOURCE_V2);

    try {
      const update = controller.checkAndUpdateDefaultPattern(root);
      await compileStarted.promise;

      const customRef = {
        identity: await identityForSource(patternSource("concurrent-custom")),
        symbol: "default",
      };
      const repository = "https://github.com/example/concurrent-pattern";
      const replacement = await runtime.editWithRetry((tx) => {
        const txRoot = root.withTx(tx);
        txRoot.setMetaRaw("patternIdentity", customRef);
        txRoot.setMetaRaw("patternSource", undefined);
        txRoot.setMetaRaw("patternRepository", repository);
      });
      expect(replacement.error).toBeUndefined();

      releaseCompile.resolve();
      expect(await update).toBe("current");

      const current = (await manager.getDefaultPattern(false))!;
      expect(getPatternIdentityRef(current)).toEqual(customRef);
      expect(getPatternRepository(current)).toBe(repository);
      expect(getPatternSource(current)).toBeUndefined();
    } finally {
      releaseCompile.resolve();
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("leaves a repository-pinned sourceless root untouched", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.recreateDefaultPattern({
      customProgram: {
        main: "/repository-root.tsx",
        files: [{ name: "/repository-root.tsx", contents: SOURCE_V1 }],
      },
      repository: "https://github.com/example/patterns",
    });
    const before = getPatternIdentityRef(piece.getCell());
    const identityFetchesBefore = stub.identityFetches();
    expect(getPatternSource(piece.getCell())).toBeUndefined();

    stub.setSource(SOURCE_V2);
    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
    expect(stub.identityFetches()).toBe(identityFetchesBefore);
  });

  it("leaves a cross-origin tracked root untouched", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell());
    const identityFetchesBefore = stub.identityFetches();
    const externalSource = "https://patterns.example/root.tsx";
    const { error } = await runtime.editWithRetry((tx) => {
      piece.getCell().withTx(tx).setMetaRaw("patternSource", externalSource);
    });
    expect(error).toBeUndefined();
    const root = (await manager.getDefaultPattern(false))!;
    expect(getPatternSource(root)).toBe(externalSource);

    stub.setSource(SOURCE_V2);
    expect(await controller.checkAndUpdateDefaultPattern(root)).toBe("current");
    expect(getPatternIdentityRef(root)).toEqual(before);
    expect(getPatternSource(root)).toBe(externalSource);
    expect(stub.identityFetches()).toBe(identityFetchesBefore);
    expect(
      stub.requestedHrefs().some((href) => href.startsWith(externalSource)),
    ).toBe(false);
  });

  it("does not infer provenance from an official-looking filename", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.recreateDefaultPattern({
      customProgram: {
        main: DEFAULT_APP_PATTERN_URL,
        files: [{ name: DEFAULT_APP_PATTERN_URL, contents: SOURCE_V1 }],
      },
    });
    const oldRef = getPatternIdentityRef(piece.getCell())!;
    expect(getPatternSource(piece.getCell())).toBeUndefined();
    stub.setSource(SOURCE_V2);

    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    const pinned = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(pinned)).toEqual(oldRef);
    expect(getPatternSource(pinned)).toBeUndefined();
    expect(stub.identityFetches()).toBe(1);
    expect(stub.sourceFetches()).toBe(0);
  });

  it("leaves a stale root untouched when replacement compilation fails", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    const oldRef = getPatternIdentityRef(root)!;
    const originalCompile = runtime.patternManager.compilePattern;
    runtime.patternManager.compilePattern = (() =>
      Promise.reject(
        new Error("replacement compilation failed"),
      )) as typeof runtime.patternManager.compilePattern;
    stub.setSource(SOURCE_V2);

    try {
      expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");

      const unchanged = (await manager.getDefaultPattern(false))!;
      expect(getPatternIdentityRef(unchanged)).toEqual(oldRef);
      expect(getPatternSource(unchanged)).toBe(DEFAULT_APP_PATTERN_URL);
      expect(stub.identityFetches()).toBe(1);
      expect(versionSkews).toEqual([]);
    } finally {
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("leaves the current root untouched when the identity swap cannot commit", async () => {
    await setup({ systemPatternAutoUpdate: true });
    await controller.ensureDefaultPattern();
    const root = (await manager.getDefaultPattern(false))!;
    const before = getPatternIdentityRef(root);
    const originalWithTx = root.withTx;
    root.withTx = (() => {
      throw new Error("pattern identity swap rejected");
    }) as typeof root.withTx;
    stub.setSource(SOURCE_V2);

    try {
      expect(await controller.checkAndUpdateDefaultPattern(root)).toBe(
        "current",
      );
      expect(getPatternIdentityRef(root)).toEqual(before);
    } finally {
      root.withTx = originalWithTx;
    }
  });

  it("skips a custom root with no patternSource", async () => {
    await setup({ systemPatternAutoUpdate: true });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-root.tsx",
        files: [{ name: "/custom-root.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    expect(getPatternSource(root)).toBeUndefined();
    const before = getPatternIdentityRef(root)?.identity;

    // Even though the toolshed serves a (different) default-app identity, we must
    // NOT roll this space to default-app. The identity probe may establish that
    // it is not a known official identity; source must never be fetched/applied.
    stub.setSource(SOURCE_V2);
    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(root)?.identity).toBe(before);
    expect(stub.identityFetches()).toBe(1);
  });

  it("skips a custom home root with the update flag on", async () => {
    await setupHome({ systemPatternAutoUpdate: true });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    const before = getPatternIdentityRef(root);
    expect(getPatternSource(root)).toBeUndefined();

    stub.setSource(SOURCE_V2);
    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(root)).toEqual(before);
    expect(getPatternSource(root)).toBeUndefined();
    expect(stub.identityFetches()).toBe(1);
  });

  it("rolls the home root forward under the one update flag", async () => {
    // A home space (session space == the identity DID) auto-updates under the
    // same single flag as every other tracked system root — the home-specific
    // second gate is gone. Same in-place semantics: no new piece minted.
    await setupHome({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const rootLinkBefore = JSON.stringify(piece.getCell().getAsLink());
    const idV1 = getPatternIdentityRef(piece.getCell())?.identity;

    stub.setSource(SOURCE_V2);
    expect(await controller.checkAndUpdateDefaultPattern()).toBe("updated");
    await runtime.idle();

    const root = (await manager.getDefaultPattern(false))!;
    expect(JSON.stringify(root.getAsLink())).toBe(rootLinkBefore);
    const idV2 = getPatternIdentityRef(root)?.identity;
    // The home root compiles at HOME_PATTERN_URL — identity includes the entry.
    expect(idV2).toBe(await identityForSource(SOURCE_V2, {}, HOME_PATTERN_URL));
    expect(idV2).not.toBe(idV1);
  });

  // The unloadability tiebreak. A stale sourceless root is ambiguous between
  // an obsolete system root and a deliberate custom program (custom recreation
  // stamps no provenance), so a LOADABLE one stays pinned — the test above.
  // One that cannot cold-load is a dead page under either reading: replace it
  // with the official system root and record the displaced ref for recovery.
  // (The 2026-07-21 estuary migration bricked every pre-provenance home root;
  // the pin alone kept them bricked after the update flag opened.)
  function shadowLoadProbe(
    staleIdentity: string,
    outcome: "undefined" | "reject",
  ): () => void {
    const pm = runtime.patternManager as unknown as {
      loadPatternByIdentity: (
        identity: string,
        symbol: string,
        space: unknown,
      ) => Promise<unknown>;
    };
    const original = pm.loadPatternByIdentity.bind(runtime.patternManager);
    // The harness compiled the stale program for real, so the probe outcome
    // (on estuary: a runtime migration invalidated the stored source) is
    // injected at the probe seam itself.
    pm.loadPatternByIdentity = (identity, symbol, space) =>
      identity !== staleIdentity
        ? original(identity, symbol, space)
        : outcome === "undefined"
        ? Promise.resolve(undefined)
        : Promise.reject(new Error("probe backend unavailable"));
    return () => {
      pm.loadPatternByIdentity = original;
    };
  }

  it("replaces an unloadable stale sourceless home root", async () => {
    await setupHome({ systemPatternAutoUpdate: true });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    const staleRef = getPatternIdentityRef(root)!;
    expect(getPatternSource(root)).toBeUndefined();

    stub.setSource(SOURCE_V2);
    const restore = shadowLoadProbe(staleRef.identity, "undefined");
    try {
      expect(await controller.checkAndUpdateDefaultPattern()).toBe("updated");
    } finally {
      restore();
    }
    await runtime.idle();

    const after = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(
      await identityForSource(SOURCE_V2, {}, HOME_PATTERN_URL),
    );
    // Provenance back-filled: the root now tracks the official URL.
    expect(getPatternSource(after)).toBe(HOME_PATTERN_URL);
    // The displaced ref is the only record of the replaced sourceless root.
    const displaced = (after as unknown as {
      getMetaRaw: (key: string) => unknown;
    }).getMetaRaw("displacedPattern") as {
      identity?: string;
      symbol?: string;
      displacedAt?: number;
    };
    expect(displaced?.identity).toBe(staleRef.identity);
    expect(displaced?.symbol).toBe(staleRef.symbol);
    expect(typeof displaced?.displacedAt).toBe("number");
  });

  it("replaces an unloadable stale sourceless space root", async () => {
    // The fallback covers every space's DEFAULT pattern, not just home
    // (widened by the flag owner after a non-home field report): a root
    // that cannot load is a dead space regardless of kind. The displaced
    // ref is recorded for non-home too — it is the recovery pointer if
    // the replaced root was a custom program.
    await setup({ systemPatternAutoUpdate: true });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-app.tsx",
        files: [{ name: "/custom-app.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    const staleRef = getPatternIdentityRef(root)!;
    expect(getPatternSource(root)).toBeUndefined();

    stub.setSource(SOURCE_V2);
    const restore = shadowLoadProbe(staleRef.identity, "undefined");
    try {
      expect(await controller.checkAndUpdateDefaultPattern()).toBe("updated");
    } finally {
      restore();
    }
    await runtime.idle();

    const after = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(
      await identityForSource(SOURCE_V2),
    );
    expect(getPatternSource(after)).toBe(DEFAULT_APP_PATTERN_URL);
    const displaced = (after as unknown as {
      getMetaRaw: (key: string) => unknown;
    }).getMetaRaw("displacedPattern") as {
      identity?: string;
      symbol?: string;
      displacedAt?: number;
    };
    expect(displaced?.identity).toBe(staleRef.identity);
    expect(displaced?.symbol).toBe(staleRef.symbol);
    expect(typeof displaced?.displacedAt).toBe("number");
  });

  it("keeps the home root pinned when the load probe fails", async () => {
    // A thrown probe is a failed CHECK, not evidence of a dead root — a
    // transient storage/backend failure must not authorize replacing an
    // ambiguous sourceless root. Fail closed, mutate nothing.
    await setupHome({ systemPatternAutoUpdate: true });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    const staleRef = getPatternIdentityRef(root)!;

    stub.setSource(SOURCE_V2);
    const restore = shadowLoadProbe(staleRef.identity, "reject");
    try {
      expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    } finally {
      restore();
    }
    expect(getPatternIdentityRef(root)).toEqual(staleRef);
    expect(getPatternSource(root)).toBeUndefined();
    const displaced = (root as unknown as {
      getMetaRaw: (key: string) => unknown;
    }).getMetaRaw("displacedPattern");
    expect(displaced).toBeUndefined();
  });

  it("keeps the home root pinned when by-identity recovery is disabled", async () => {
    // Under cfcEnforcementMode "disabled" the probe returns undefined
    // unconditionally — "probe unsupported" must not read as "artifact
    // dead". No shadow here: the real probe short-circuits.
    await setupHome({ systemPatternAutoUpdate: true }, BUILD_SHA, {
      cfcEnforcementMode: "disabled",
    });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    const staleRef = getPatternIdentityRef(root)!;

    stub.setSource(SOURCE_V2);
    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(root)).toEqual(staleRef);
    expect(getPatternSource(root)).toBeUndefined();
  });

  describe("recreateDefaultPattern provenance (CT-1890)", () => {
    it("stamps a recreated non-home root so it can auto-update", async () => {
      await setup({ systemPatternAutoUpdate: true });
      await controller.recreateDefaultPattern();
      const root = (await manager.getDefaultPattern(false))!;
      expect(getPatternSource(root)).toBe(DEFAULT_APP_PATTERN_URL);

      // The stamp is the point: it makes the recreated root eligible for
      // auto-update. A newer toolshed identity must roll it forward instead
      // of being skipped forever at the sourceless-root gate.
      stub.setSource(SOURCE_V2);
      expect(await controller.checkAndUpdateDefaultPattern()).toBe("updated");
      await runtime.idle();
      const updated = (await manager.getDefaultPattern(false))!;
      expect(getPatternIdentityRef(updated)?.identity).toBe(
        await identityForSource(SOURCE_V2),
      );
    });

    it("stamps the configured custom defaultAppUrl and updates through it", async () => {
      await setup({ systemPatternAutoUpdate: true });

      // Home config supplies a custom-app URL for new space roots: the home
      // root's `defaultAppUrl`, read via getDefaultAppUrlFromHome().
      const homeSpaceCell = runtime.getHomeSpaceCell();
      await homeSpaceCell.sync();
      const homeRoot = runtime.getCell(
        runtime.userIdentityDID,
        "home-root-config",
      );
      const { error } = await runtime.editWithRetry((tx) => {
        homeRoot.withTx(tx).set({ defaultAppUrl: CUSTOM_APP_URL });
        // deno-lint-ignore no-explicit-any
        (homeSpaceCell.withTx(tx) as any).key("defaultPattern").set(homeRoot);
      });
      expect(error).toBeUndefined();
      await runtime.idle();

      const customV1 = patternSource("custom-v1");
      stub.setCustomSource(customV1);
      await controller.recreateDefaultPattern();
      const root = (await manager.getDefaultPattern(false))!;
      // patternSource freezes the exact source selected at birth — the
      // configured custom path, not the default-app fallback.
      expect(getPatternSource(root)).toBe(CUSTOM_APP_URL);
      expect(getPatternIdentityRef(root)?.identity).toBe(
        await identityForSource(customV1, {}, CUSTOM_APP_URL),
      );

      // ...and update lookup continues THROUGH that custom path: a newer
      // custom-app source rolls the root forward to the custom identity,
      // untouched by whatever the default-app path serves.
      const customV2 = patternSource("custom-v2");
      stub.setCustomSource(customV2);
      stub.setSource(SOURCE_V2);
      expect(await controller.checkAndUpdateDefaultPattern()).toBe("updated");
      await runtime.idle();
      const updated = (await manager.getDefaultPattern(false))!;
      expect(getPatternSource(updated)).toBe(CUSTOM_APP_URL);
      expect(getPatternIdentityRef(updated)?.identity).toBe(
        await identityForSource(customV2, {}, CUSTOM_APP_URL),
      );
    });

    it("stamps a recreated home root with home.tsx", async () => {
      await setupHome({});

      await controller.recreateDefaultPattern();
      const root = (await manager.getDefaultPattern(false))!;
      expect(getPatternSource(root)).toBe(HOME_PATTERN_URL);
    });
  });
});
