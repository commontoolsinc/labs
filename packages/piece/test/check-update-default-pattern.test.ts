import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getPatternIdentityRef,
  getPatternSource,
  resolveEntryIdentity,
  Runtime,
  type VersionSkewInfo,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createSession, Identity } from "@commonfabric/identity";
import { PieceManager } from "../src/manager.ts";
import {
  DEFAULT_APP_PATTERN_URL,
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

/** Content identity a toolshed at this build would serve for `source`. */
function identityForSource(source: string): Promise<string> {
  return resolveEntryIdentity(
    DEFAULT_APP_PATTERN_URL, // /api/patterns/system/default-app.tsx
    (name) =>
      name === DEFAULT_APP_PATTERN_URL
        ? Promise.resolve(source)
        : Promise.reject(new Error(`not found: ${name}`)),
  );
}

interface StubControls {
  setSource(source: string): void;
  setGitSha(sha: string | null): void;
  failIdentity(fail: boolean): void;
  identityFetches(): number;
  restore(): void;
}

function installFetchStub(): StubControls {
  const original = globalThis.fetch;
  let source = SOURCE_V1;
  let gitSha: string | null = BUILD_SHA;
  let failIdentityFetch = false;
  let identityFetchCount = 0;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const url = new URL(href);

    if (url.pathname === "/api/meta") {
      return new Response(JSON.stringify({ did: "did:x", gitSha }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === DEFAULT_APP_PATTERN_URL) {
      if (url.searchParams.has("identity")) {
        identityFetchCount++;
        if (failIdentityFetch) throw new Error("identity fetch failed");
        return new Response(await identityForSource(source), {
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response(source, {
        headers: { "content-type": "text/typescript-jsx" },
      });
    }

    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    setSource: (s) => (source = s),
    setGitSha: (s) => (gitSha = s),
    failIdentity: (f) => (failIdentityFetch = f),
    identityFetches: () => identityFetchCount,
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

  it("skips a legacy non-home root with no patternSource (custom-app safety)", async () => {
    await setup({ systemPatternAutoUpdate: true });
    // recreateDefaultPattern does NOT stamp patternSource — it stands in for a
    // legacy root created before provenance existed (which might be a custom app
    // seeded from home's defaultAppUrl, NOT the default app).
    await controller.recreateDefaultPattern();
    const root = (await manager.getDefaultPattern(false))!;
    expect(getPatternSource(root)).toBeUndefined();
    const before = getPatternIdentityRef(root)?.identity;

    // Even though the toolshed serves a (different) default-app identity, we must
    // NOT roll this space to default-app: skip without touching it or fetching.
    stub.setSource(SOURCE_V2);
    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(root)?.identity).toBe(before);
    expect(stub.identityFetches()).toBe(0);
  });

  it("holds the home root behind its own flag (M4.2)", async () => {
    // A home space (session space == the identity DID), with the base flag on
    // but the home flag off, must not auto-update — it short-circuits before
    // any fetch.
    versionSkews = [];
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      clientVersion: BUILD_SHA,
      experimental: { systemPatternAutoUpdate: true },
    });
    const homeSession = await createSession({
      identity: signer,
      spaceDid: signer.did(),
    });
    expect(homeSession.space).toBe(runtime.userIdentityDID);
    manager = new PieceManager(homeSession, runtime);
    await manager.synced();
    controller = new PiecesController(manager);

    expect(await controller.checkAndUpdateDefaultPattern()).toBe(
      "skipped-disabled",
    );
    expect(stub.identityFetches()).toBe(0);
  });
});
