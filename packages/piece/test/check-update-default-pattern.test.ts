import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getPatternIdentityRef,
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

  async function setup(experimental: Record<string, boolean>) {
    versionSkews = [];
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      clientVersion: BUILD_SHA,
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
    // Same piece entity — no new piece minted.
    expect(JSON.stringify(root.getAsLink())).toBe(rootLinkBefore);
    // patternIdentity now points at v2.
    const idV2 = getPatternIdentityRef(root)?.identity;
    expect(idV2).toBe(await identityForSource(SOURCE_V2));
    expect(idV2).not.toBe(idV1);
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

  it("never throws when a fetch fails (space open is not broken)", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell())?.identity;

    stub.failIdentity(true);
    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(before);
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
