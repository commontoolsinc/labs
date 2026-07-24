import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getPatternIdentityRef,
  getPatternRepository,
  getPatternSource,
  resolveEntryIdentity,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON } from "@commonfabric/runner/cfc/migration-reason";
import { createSession, Identity } from "@commonfabric/identity";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
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
    `export default pattern<{ items?: string[] }>(({ items }) => ({ items, marker: "${marker}" }));`,
    "",
  ].join("\n");

const SOURCE_V1 = patternSource("v1");
const SOURCE_V2 = patternSource("v2");
// A roll target WITH a handler: handler nodes need their { "$stream": true }
// markers materialized on the (reused) root doc — the dimension the plain
// sources above never exercise, and the estuary post-swap failure class.
const SOURCE_V3_HANDLER = [
  "import { Writable, handler, pattern } from 'commonfabric';",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "export default pattern<{ items?: string[] }>(({ items }) => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { items, count, bump: bump({ count }) };",
  "});",
  "",
].join("\n");

// The estuary brick, distilled to two home-shaped patterns that differ by ONE
// thing: whether the required `favorites` output field carries a default. Both
// carry a handler (its `{ "$stream": true }` markers are missing on an aged
// doc → the "Handler used as lift" cold start that gets us into the repair).
//
// OLD: `favorites` is required with NO default. Run over a favorites-less
// vintage doc, its own setup repair is REJECTED by the CFC additive-required
// migration ("favorites needs a default") — loadable, but not runnable.
const SOURCE_HOME_OLD_REQUIRED = [
  "import { Writable, handler, pattern } from 'commonfabric';",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "interface Output { items: Writable<string[]>; favorites: Writable<string[]>; }",
  "export default pattern<{ items?: string[] }, Output>(() => {",
  "  const items = new Writable<string[]>([]).for('items');",
  "  const favorites = new Writable<string[]>([]).for('favorites');",
  "  const count = new Writable<number>(0).for('count');",
  "  return { items, favorites, count, bump: bump({ count }) };",
  "});",
  "",
].join("\n");

// OFFICIAL: identical, except `favorites` rides `Default<[]>` (post-fix
// home.tsx). Migrates the same aged doc cleanly, so the roll-forward heals.
const SOURCE_HOME_OFFICIAL_DEFAULTED = [
  "import { Default, Writable, handler, pattern } from 'commonfabric';",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "interface Output { items: Writable<string[]>; favorites: Writable<string[] | Default<[]>>; }",
  "export default pattern<{ items?: string[] }, Output>(() => {",
  "  const items = new Writable<string[]>([]).for('items');",
  "  const favorites = new Writable<string[]>([]).for('favorites');",
  "  const count = new Writable<number>(0).for('count');",
  "  return { items, favorites, count, bump: bump({ count }) };",
  "});",
  "",
].join("\n");

// A single module exporting BOTH a defaulted `default` (official) and an
// obsolete `legacyHome` named export (old required, un-migratable). Because
// entry identity is content-addressed over the whole module source, both
// exports share ONE identity and differ only by symbol — exactly the state a
// root pinned to `{ currentArtifact, obsoleteSymbol }` is in. Compiling
// `legacyHome` gives a loadable-but-unrunnable entry; the heal must roll it
// forward to the `default` entry rather than short-circuit on the shared
// identity.
const SOURCE_HOME_TWO_EXPORT = [
  "import { Default, Writable, handler, pattern } from 'commonfabric';",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "interface OldOutput { items: Writable<string[]>; favorites: Writable<string[]>; }",
  "interface NewOutput { items: Writable<string[]>; favorites: Writable<string[] | Default<[]>>; }",
  "export const legacyHome = pattern<{ items?: string[] }, OldOutput>(() => {",
  "  const items = new Writable<string[]>([]).for('items');",
  "  const favorites = new Writable<string[]>([]).for('favorites');",
  "  const count = new Writable<number>(0).for('count');",
  "  return { items, favorites, count, bump: bump({ count }) };",
  "});",
  "export default pattern<{ items?: string[] }, NewOutput>(() => {",
  "  const items = new Writable<string[]>([]).for('items');",
  "  const favorites = new Writable<string[]>([]).for('favorites');",
  "  const count = new Writable<number>(0).for('count');",
  "  return { items, favorites, count, bump: bump({ count }) };",
  "});",
  "",
].join("\n");

const IMPORTED_MODULE_URL = "/api/patterns/system/update-marker.ts";

// A same-host custom-app path, as home config would supply via
// `defaultAppUrl` (a published custom app, NOT a system pattern).
const CUSTOM_APP_URL = "/api/patterns/custom/my-app.tsx";

/** Content identity a toolshed would serve for `source`. */
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
  setIdentityResponse(body: string, status?: number): void;
  setImport(path: string, source: string): void;
  setIdentityImport(path: string, source: string): void;
  failIdentity(fail: boolean): void;
  identityFetches(): number;
  sourceFetches(): number;
  requestedHrefs(): string[];
  requestedFetches(): Array<{ href: string; cache?: RequestCache }>;
  restore(): void;
}

function installFetchStub(): StubControls {
  const original = globalThis.fetch;
  let source = SOURCE_V1;
  // Served at CUSTOM_APP_URL when set; null keeps the path unserved (404).
  let customSource: string | null = null;
  let identitySource: string | undefined;
  const imports: Record<string, string> = {};
  const identityImports: Record<string, string> = {};
  let identityResponse: { body: string; status: number } | undefined;
  let failIdentityFetch = false;
  let identityFetchCount = 0;
  let sourceFetchCount = 0;
  const requestedHrefs: string[] = [];
  const requestedFetches: Array<{ href: string; cache?: RequestCache }> = [];

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const url = new URL(href);
    requestedHrefs.push(url.href);
    requestedFetches.push({
      href: url.href,
      cache: init?.cache ??
        (input instanceof Request ? input.cache : undefined),
    });

    if (
      url.pathname === DEFAULT_APP_PATTERN_URL ||
      url.pathname === HOME_PATTERN_URL
    ) {
      if (url.searchParams.has("identity")) {
        identityFetchCount++;
        if (failIdentityFetch) throw new Error("identity fetch failed");
        if (identityResponse) {
          return new Response(identityResponse.body, {
            status: identityResponse.status,
            headers: { "content-type": "text/plain" },
          });
        }
        return new Response(
          await identityForSource(
            identitySource ?? source,
            { ...imports, ...identityImports },
            url.pathname,
          ),
          { headers: { "content-type": "text/plain" } },
        );
      }
      sourceFetchCount++;
      return new Response(source, {
        headers: { "content-type": "text/typescript-jsx" },
      });
    }

    if (url.pathname === CUSTOM_APP_URL && customSource !== null) {
      if (url.searchParams.has("identity")) {
        identityFetchCount++;
        if (failIdentityFetch) throw new Error("identity fetch failed");
        return new Response(
          await identityForSource(customSource, imports, CUSTOM_APP_URL),
          { headers: { "content-type": "text/plain" } },
        );
      }
      sourceFetchCount++;
      return new Response(customSource, {
        headers: { "content-type": "text/typescript-jsx" },
      });
    }

    if (Object.hasOwn(imports, url.pathname)) {
      sourceFetchCount++;
      return new Response(imports[url.pathname], {
        headers: { "content-type": "text/typescript" },
      });
    }

    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    setSource: (s) => (source = s),
    setCustomSource: (s) => (customSource = s),
    setIdentitySource: (s) => (identitySource = s),
    setIdentityResponse: (body, status = 200) => {
      identityResponse = { body, status };
    },
    setImport: (path, s) => (imports[path] = s),
    setIdentityImport: (path, s) => (identityImports[path] = s),
    failIdentity: (f) => (failIdentityFetch = f),
    identityFetches: () => identityFetchCount,
    sourceFetches: () => sourceFetchCount,
    requestedHrefs: () => [...requestedHrefs],
    requestedFetches: () => [...requestedFetches],
    restore: () => (globalThis.fetch = original),
  };
}

describe("checkAndUpdateDefaultPattern", () => {
  let stub: StubControls;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;
  let controller: PiecesController;

  async function setup(experimental: Record<string, boolean>) {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      experimental,
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
    extraRuntimeOptions: { cfcEnforcementMode?: "disabled" } = {},
  ) {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      experimental,
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

  it("returns current when the space has no default pattern", async () => {
    await setup({ systemPatternAutoUpdate: true });

    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(stub.identityFetches()).toBe(0);
  });

  it("does not duplicate the update check for a newly created root", async () => {
    await setup({ systemPatternAutoUpdate: true });

    await controller.ensureDefaultPattern();
    await runtime.patternUpdater.idle();

    expect(stub.identityFetches()).toBe(0);
  });

  it("contains failures while resolving the default pattern", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const originalGetDefaultPattern = manager.getDefaultPattern;
    manager.getDefaultPattern = (() =>
      Promise.reject(
        new Error("default-pattern lookup failed"),
      )) as typeof manager.getDefaultPattern;

    try {
      expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
      expect(stub.identityFetches()).toBe(0);
    } finally {
      manager.getDefaultPattern = originalGetDefaultPattern;
    }
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
        // The obsolete runtime selected an export the current system source no
        // longer has. Dead-root recovery must select the official entry's
        // default export, rather than trying to preserve this broken symbol.
        symbol: "removed-export",
      });
    });
    expect(error).toBeUndefined();
    const staleRoot = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(staleRoot)?.identity).toBe(staleIdentity);

    // The toolshed advertises a newer system-root identity. The ensure path
    // must install it before start() sees the stale one.
    stub.setSource(SOURCE_V2);

    const updated = await controller.ensureDefaultPattern();
    await runtime.idle();

    expect(JSON.stringify(updated.getCell().getAsLink())).toBe(rootLinkBefore);
    expect(getPatternIdentityRef(updated.getCell())?.identity).toBe(
      await identityForSource(SOURCE_V2),
    );
    expect(getPatternIdentityRef(updated.getCell())?.symbol).toBe("default");
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

  it("updates without build metadata when compiled source matches ?identity", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell())?.identity;

    stub.setSource(SOURCE_V2);

    expect(await controller.checkAndUpdateDefaultPattern()).toBe("updated");
    await runtime.idle();
    const root = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(root)?.identity).toBe(
      await identityForSource(SOURCE_V2),
    );
    expect(getPatternIdentityRef(root)?.identity).not.toBe(before);
    expect(
      stub.requestedHrefs().some((href) =>
        new URL(href).pathname === "/api/meta"
      ),
    ).toBe(false);
  });

  it("revalidates HTTP caches for identity and the downloaded closure", async () => {
    await setup({ systemPatternAutoUpdate: true });
    await controller.ensureDefaultPattern();
    const requestsBefore = stub.requestedFetches().length;
    const importingSource = [
      "import { pattern } from 'commonfabric';",
      "import { marker } from './update-marker.ts';",
      "export default pattern<{ items?: string[] }>(({ items }) => ({ items, marker }));",
      "",
    ].join("\n");
    stub.setSource(importingSource);
    stub.setImport(IMPORTED_MODULE_URL, 'export const marker = "fresh";\n');

    expect(await controller.checkAndUpdateDefaultPattern()).toBe("updated");

    expect(
      stub.requestedFetches().slice(requestsBefore).map(({ href, cache }) => {
        const url = new URL(href);
        return {
          path: url.pathname,
          identity: url.searchParams.has("identity"),
          cache,
        };
      }),
    ).toEqual([
      {
        path: DEFAULT_APP_PATTERN_URL,
        identity: true,
        cache: "no-cache",
      },
      {
        path: DEFAULT_APP_PATTERN_URL,
        identity: false,
        cache: "no-cache",
      },
      { path: IMPORTED_MODULE_URL, identity: false, cache: "no-cache" },
    ]);
  });

  it("keeps the original when downloaded source differs from ?identity", async () => {
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

  it("keeps the original when a downloaded import differs from ?identity", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell());
    const sourceFetchesBefore = stub.sourceFetches();
    const importingSource = [
      "import { pattern } from 'commonfabric';",
      "import { marker } from './update-marker.ts';",
      "export default pattern<{ items: string[] }>(({ items }) => ({ items, marker }));",
      "",
    ].join("\n");
    stub.setSource(importingSource);
    stub.setImport(
      IMPORTED_MODULE_URL,
      'export const marker = "downloaded-import";\n',
    );
    stub.setIdentityImport(
      IMPORTED_MODULE_URL,
      'export const marker = "advertised-import";\n',
    );

    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
    expect(stub.identityFetches()).toBe(1);
    expect(stub.sourceFetches()).toBe(sourceFetchesBefore + 2);
  });

  it("fetches ?identity for every update attempt", async () => {
    await setup({ systemPatternAutoUpdate: true });
    await controller.ensureDefaultPattern();

    await controller.checkAndUpdateDefaultPattern();
    await controller.checkAndUpdateDefaultPattern();
    expect(stub.identityFetches()).toBe(2);
  });

  it("never throws when identity lookup fails", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell())?.identity;

    stub.failIdentity(true);
    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(before);
  });

  it("keeps the original when identity lookup returns a non-success response", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell());
    const sourceFetchesBefore = stub.sourceFetches();
    stub.setIdentityResponse("unavailable", 503);

    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
    expect(stub.sourceFetches()).toBe(sourceFetchesBefore);
  });

  it("keeps the original when identity lookup returns an empty identity", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell());
    const sourceFetchesBefore = stub.sourceFetches();
    stub.setIdentityResponse("  \n");

    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
    expect(stub.sourceFetches()).toBe(sourceFetchesBefore);
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
    } finally {
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("keeps the original when advertised source needs unavailable runtime semantics", async () => {
    await setup({ systemPatternAutoUpdate: true });
    const piece = await controller.ensureDefaultPattern();
    const before = getPatternIdentityRef(piece.getCell());
    stub.setSource([
      "import { pattern, futureRuntimeApi } from 'commonfabric';",
      "futureRuntimeApi();",
      "export default pattern<{ items: string[] }>(({ items }) => ({ items }));",
      "",
    ].join("\n"));

    expect(await controller.checkAndUpdateDefaultPattern()).toBe("current");
    expect(getPatternIdentityRef(piece.getCell())).toEqual(before);
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

  it("swapped-in pattern with handlers starts over the reused root doc", async () => {
    // The estuary post-#4883 failure class: the swap engages, writes the new
    // patternIdentity onto the EXISTING result cell, and the replacement
    // pattern must then start over that reused doc — including materializing
    // { "$stream": true } markers for handler nodes the old program never
    // had. A handler-less roll target (every other test here) cannot see
    // this; home.tsx is handler-rich.
    await setupHome({ systemPatternAutoUpdate: true });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    const staleRef = getPatternIdentityRef(root)!;

    stub.setSource(SOURCE_V3_HANDLER);
    const restore = shadowLoadProbe(staleRef.identity, "undefined");
    try {
      expect(await controller.checkAndUpdateDefaultPattern()).toBe("updated");
    } finally {
      restore();
    }
    await runtime.idle();

    // The swap alone is not the contract — the replacement must RUN. Start
    // it the way bootstrap would and let the scheduler settle; a missing
    // stream marker surfaces as "Handler used as lift" at instantiation and
    // the pattern body never executes, so the functional read below is the
    // pin: `count` only reads 0 if the swapped-in program actually ran its
    // setup (internal cells materialized) and instantiated.
    const after = (await manager.getDefaultPattern(true))!;
    await runtime.idle();
    expect(getPatternIdentityRef(after)?.identity).toBe(
      await identityForSource(SOURCE_V3_HANDLER, {}, HOME_PATTERN_URL),
    );
    expect(after.key("count").get()).toBe(0);
  });

  it("failed swap-setup leaves the running pattern in place", async () => {
    // The fail-closed half of the swap-setup contract: when the incoming
    // pattern's argument schema rejects the existing argument, the watcher
    // logs pattern-swap-setup-error and must NOT tear down the running
    // nodes — a bad update leaves a working piece, not a dead one.
    const SOURCE_INCOMPATIBLE = [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ mustHave: string }>(({ mustHave }) => ({",
      "  mustHave,",
      "}));",
      "",
    ].join("\n");
    await setupHome({ systemPatternAutoUpdate: true });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    const staleRef = getPatternIdentityRef(root)!;

    stub.setSource(SOURCE_INCOMPATIBLE);
    const restore = shadowLoadProbe(staleRef.identity, "undefined");
    try {
      // The update itself proceeds (identity swaps at the meta layer)…
      expect(await controller.checkAndUpdateDefaultPattern()).toBe("updated");
    } finally {
      restore();
    }
    await runtime.idle();
    // …but the swap-setup for the incompatible program fails closed: the
    // piece is not left dead (starting it does not throw), and the failure
    // was logged rather than swallowed.
    const after = (await manager.getDefaultPattern(true))!;
    await runtime.idle();
    // Functional pin, not just existence: the OLD pattern's nodes are still
    // the ones running — its result reads back — after the refused swap.
    expect(after.key("marker").get()).toBe("v1");
  });

  it("cold-boot swap: handler-bearing replacement heals a root that was NOT running", async () => {
    // The real estuary bricked-space shape, which the running-piece test
    // above cannot see: a bricked root never STARTED (its stored source
    // fails to load), so there is no patternIdentity watcher when the swap
    // lands. ensureDefaultPattern reconciles BEFORE start
    // (startEnsuredDefaultPattern -> checkAndUpdateDefaultPattern), then
    // cold-starts the piece — and Runner.startCore's initial instantiation
    // does not run the setup phase, so the incoming pattern's
    // { "$stream": true } markers were never materialized on the reused doc.
    await setupHome({ systemPatternAutoUpdate: true });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    const staleRef = getPatternIdentityRef(root)!;

    // The piece is NOT running when the swap lands — the defining difference
    // from the watcher-path test above.
    await manager.stopPiece(root);

    stub.setSource(SOURCE_V3_HANDLER);
    const restore = shadowLoadProbe(staleRef.identity, "undefined");
    try {
      // The real boot entry: reconcile-before-start, then cold start.
      await controller.ensureDefaultPattern();
    } finally {
      restore();
    }
    await runtime.idle();

    // Re-resolve: the controller's cell is a pre-heal transaction view.
    const after = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(
      await identityForSource(SOURCE_V3_HANDLER, {}, HOME_PATTERN_URL),
    );
    // Functional pin: the pattern body ran its setup (count materialized)…
    expect(after.key("count").get()).toBe(0);
    // …and the handler's stream marker actually works end-to-end.
    (after.key("bump") as unknown as { send: (e: unknown) => void }).send({});
    await runtime.idle();
    await (after as unknown as { pull: () => Promise<unknown> }).pull();
    const afterEvent = (await manager.getDefaultPattern(false))!;
    expect(afterEvent.key("count").get()).toBe(1);
  });

  it("cold start heals a doc whose identity already moved without setup", async () => {
    // The CURRENT durable state of an estuary space bricked by the deployed
    // build: the 2026-07-22 flow already CAS-wrote patternIdentity to the
    // official pattern (checkAndUpdateDefaultPattern "Never calls run()"),
    // but no setup ever committed, so the doc has no internal-cell manifest
    // entries or stream markers for that pattern. On the next boot the
    // identity compares current, so no further swap fires — the doc must be
    // healed at cold start itself.
    await setupHome({ systemPatternAutoUpdate: true });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    await manager.stopPiece(root);

    stub.setSource(SOURCE_V3_HANDLER);
    const targetId = await identityForSource(
      SOURCE_V3_HANDLER,
      {},
      HOME_PATTERN_URL,
    );
    // Model the already-committed swap: identity points at the CURRENT
    // official pattern, doc still set up for SOURCE_V1 (marker-less for V3).
    const { error } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: targetId,
        symbol: "default",
      });
    });
    expect(error).toBeUndefined();

    await controller.ensureDefaultPattern();
    await runtime.idle();

    // Re-resolve: the controller's cell is a pre-heal transaction view.
    const after = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(targetId);
    expect(after.key("count").get()).toBe(0);
    (after.key("bump") as unknown as { send: (e: unknown) => void }).send({});
    await runtime.idle();
    await (after as unknown as { pull: () => Promise<unknown> }).pull();
    const afterEvent = (await manager.getDefaultPattern(false))!;
    expect(afterEvent.key("count").get()).toBe(1);
  });

  it("heals a root whose pinned pattern fails CFC migration by rolling forward to official", async () => {
    // The estuary brick, faithfully: a home root pinned to an OLD home.tsx
    // whose required `favorites` predates its `Default<>`. The doc was
    // materialized by a favorites-less vintage, so the pinned pattern's OWN
    // setup repair is REJECTED by the CFC additive-required migration ("needs a
    // default") — it loads but cannot run. Enforce-on (the default here; the
    // rejecting layer is the whole point of this test, so it must not be off).
    // The runnability backstop must roll the root forward to the CURRENT
    // official home.tsx and materialize THAT: the once-fatal field present, the
    // handler stream live end to end.
    await setupHome({ systemPatternAutoUpdate: true });
    expect(runtime.cfcEnforcementMode).not.toBe("disabled");

    // 1. Age the doc: materialize a favorites-less vintage.
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    await manager.stopPiece(root);

    // 2. Compile OLD so its identity is loadable in-session, then pin the root
    //    to it (sourceless) — the pre-fix required-favorites home.tsx.
    stub.setSource(SOURCE_HOME_OLD_REQUIRED);
    const oldResolved = await runtime.harness.resolve(
      new HttpProgramResolver(new URL(HOME_PATTERN_URL, runtime.apiUrl).href),
    );
    const oldPattern = await runtime.patternManager.compilePattern(
      { ...oldResolved, mainExport: "default" },
      { space: manager.getSpace() },
    );
    const oldRef = runtime.patternManager.getArtifactEntryRef(oldPattern)!;
    const { error: pinError } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: oldRef.identity,
        symbol: "default",
      });
    });
    expect(pinError).toBeUndefined();
    // The pinned OLD pattern really is loadable — "loadable but unrunnable" is
    // the precise state the pattern-updater's loadability gate leaves pinned.
    await expect(
      runtime.patternManager.loadPatternByIdentity(
        oldRef.identity,
        "default",
        manager.getSpace(),
      ),
    ).resolves.toBeDefined();

    // 3. Toolshed now serves OFFICIAL (favorites rides Default<[]>). Take its
    //    expected identity the SAME way the heal does — the compiled artifact
    //    ref, not a source hash — so the assertion also proves the roll-forward
    //    compiled THIS source, not a stale-cached one.
    stub.setSource(SOURCE_HOME_OFFICIAL_DEFAULTED);
    const officialResolved = await runtime.harness.resolve(
      new HttpProgramResolver(new URL(HOME_PATTERN_URL, runtime.apiUrl).href),
    );
    const officialPattern = await runtime.patternManager.compilePattern(
      { ...officialResolved, mainExport: "default" },
      { space: manager.getSpace() },
    );
    const officialId =
      runtime.patternManager.getArtifactEntryRef(officialPattern)!.identity;
    // A genuine roll-forward: the target identity differs from the pinned one.
    expect(officialId).not.toBe(oldRef.identity);

    // 4. Inject the CFC MIGRATION rejection on the pinned pattern's OWN setup
    //    repair — the exact signal the runnability gate keys on. Keyed by
    //    expectedPatternIdentity so ONLY the same-identity repair (OLD) is
    //    rejected; the roll-forward's materialize (OFFICIAL) runs for real and
    //    must heal the reused doc. The rejection message mirrors the live
    //    "CFC enforcement rejected commit" wrapper (see the runner + #4936's
    //    schema-merge tests) so the gate's predicate is exercised as shipped.
    //    A genuine additive-required rejection over a CFC-relevant home root is
    //    covered directly by cfc-additive-default-preserves-old-doc.test.ts;
    //    here we pin the ORCHESTRATION the piece controller adds on top.
    const rt = runtime as unknown as {
      runSynced: (...args: unknown[]) => Promise<unknown>;
    };
    const realRunSynced = rt.runSynced.bind(runtime);
    rt.runSynced = (...args: unknown[]) => {
      const opts = args[3] as
        | { expectedPatternIdentity?: { identity?: string } }
        | undefined;
      if (opts?.expectedPatternIdentity?.identity === oldRef.identity) {
        // The EXACT string the runner surfaces for this class: the commit
        // wrapper, the `not prepared` middle, then the machine token the CFC
        // prepare tags on (see migration-reason.ts / runner.ts). Built from the
        // shared token constant so the gate's predicate is exercised as shipped.
        return Promise.reject(
          new Error(
            "CFC enforcement rejected commit: relevant transaction was not " +
              `prepared: ${CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON}: ` +
              "required field favorites needs a default to preserve old documents",
          ),
        );
      }
      return realRunSynced(...args);
    };

    // 5. Boot: heal by roll-forward — no throw.
    try {
      await controller.ensureDefaultPattern();
    } finally {
      rt.runSynced = realRunSynced;
    }
    await runtime.idle();

    // Re-resolve: the controller's cell is a pre-heal transaction view.
    const after = (await manager.getDefaultPattern(false))!;
    // Rolled forward to the official identity, official provenance stamped…
    expect(getPatternIdentityRef(after)?.identity).toBe(officialId);
    expect(getPatternSource(after)).toBe(HOME_PATTERN_URL);
    // …recording the displaced pinned pattern for recovery.
    const displaced = (after as unknown as {
      getMetaRaw: (k: string) => unknown;
    }).getMetaRaw("displacedPattern") as { identity?: string } | undefined;
    expect(displaced?.identity).toBe(oldRef.identity);

    // FUNCTIONAL read (not just a swap-shaped assertion): the once-fatal
    // required field materialized to its default, and the handler stream works
    // end to end over the reused doc.
    expect(after.key("favorites").get()).toEqual([]);
    expect(after.key("count").get()).toBe(0);
    (after.key("bump") as unknown as { send: (e: unknown) => void }).send({});
    await runtime.idle();
    await (after as unknown as { pull: () => Promise<unknown> }).pull();
    const afterEvent = (await manager.getDefaultPattern(false))!;
    expect(afterEvent.key("count").get()).toBe(1);

    // The roll-forward compiled the FRESHEST official source (ETag-revalidated,
    // `cache: "no-cache"`), never a stale HTTP-cached one — escaping a stale
    // pin is the whole point, so a cache-stale compile would defeat it.
    const homeSourceFetches = stub.requestedFetches().filter((f) => {
      const u = new URL(f.href);
      return u.pathname === HOME_PATTERN_URL && !u.searchParams.has("identity");
    });
    expect(homeSourceFetches.some((f) => f.cache === "no-cache")).toBe(true);
  });

  // Shared estuary scaffolding for the roll-forward edge cases below: age a
  // home doc with a favorites-less vintage, then pin the (stopped) root
  // sourceless to an OLD required-favorites home.tsx that loads but cannot
  // migrate the aged doc. Returns the pinned OLD ref and the OFFICIAL identity
  // a successful roll-forward should reach. Mirrors the happy-path test above.
  const pinOldRequiredHome = async () => {
    await setupHome({ systemPatternAutoUpdate: true });
    expect(runtime.cfcEnforcementMode).not.toBe("disabled");
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    await manager.stopPiece(root);

    stub.setSource(SOURCE_HOME_OLD_REQUIRED);
    const oldResolved = await runtime.harness.resolve(
      new HttpProgramResolver(new URL(HOME_PATTERN_URL, runtime.apiUrl).href),
    );
    const oldPattern = await runtime.patternManager.compilePattern(
      { ...oldResolved, mainExport: "default" },
      { space: manager.getSpace() },
    );
    const oldRef = runtime.patternManager.getArtifactEntryRef(oldPattern)!;
    const { error: pinError } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: oldRef.identity,
        symbol: "default",
      });
    });
    expect(pinError).toBeUndefined();

    // Toolshed now serves OFFICIAL; derive its compiled identity the same way
    // the heal does, so `officialId` is exactly the roll-forward's target.
    stub.setSource(SOURCE_HOME_OFFICIAL_DEFAULTED);
    const officialResolved = await runtime.harness.resolve(
      new HttpProgramResolver(new URL(HOME_PATTERN_URL, runtime.apiUrl).href),
    );
    const officialPattern = await runtime.patternManager.compilePattern(
      { ...officialResolved, mainExport: "default" },
      { space: manager.getSpace() },
    );
    const officialId =
      runtime.patternManager.getArtifactEntryRef(officialPattern)!.identity;
    expect(officialId).not.toBe(oldRef.identity);
    return { root, oldRef, officialId };
  };

  // The full production rejection string for the recoverable class, built from
  // the shared token so the gate is exercised exactly as shipped.
  const MIGRATION_REJECTION =
    "CFC enforcement rejected commit: relevant transaction was not prepared: " +
    `${CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON}: required field favorites ` +
    "needs a default to preserve old documents";

  const patchRunSynced = (
    impl: (
      opts: { expectedPatternIdentity?: { identity?: string } } | undefined,
    ) => Promise<unknown> | "real",
  ) => {
    const rt = runtime as unknown as {
      runSynced: (...args: unknown[]) => Promise<unknown>;
    };
    const real = rt.runSynced.bind(runtime);
    rt.runSynced = (...args: unknown[]) => {
      const opts = args[3] as
        | { expectedPatternIdentity?: { identity?: string } }
        | undefined;
      const out = impl(opts);
      return out === "real" ? real(...args) : out;
    };
    return () => {
      rt.runSynced = real;
    };
  };

  it("stays fail-closed when the repair fails with a CFC rejection that is NOT a schema migration", async () => {
    // The negative twin of the roll-forward test: a repair rejection that
    // carries the `CFC enforcement rejected commit` PREFIX but is NOT the
    // additive-required migration class (here: a prepared-digest race). Those
    // reflect ordering/policy/provenance faults, not "the pinned pattern is
    // wrong", so the backstop must NOT repoint the root. The bare-prefix
    // predicate this replaces would have wrongly rolled forward here.
    const { root, oldRef, officialId } = await pinOldRequiredHome();
    const restore = patchRunSynced((opts) =>
      opts?.expectedPatternIdentity?.identity === oldRef.identity
        ? Promise.reject(
          new Error("CFC enforcement rejected commit: prepared digest changed"),
        )
        : "real"
    );
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
    }
    // Fail-closed: the ORIGINAL cold-start failure surfaces, not a heal error…
    expect(String(thrown)).toContain("Handler used as lift");
    expect(String(thrown)).not.toContain("default-root heal failed");
    // …and the root's identity is untouched — no roll-forward, no displacement.
    const after = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(oldRef.identity);
    expect(getPatternIdentityRef(after)?.identity).not.toBe(officialId);
    expect(
      (after as unknown as { getMetaRaw: (k: string) => unknown })
        .getMetaRaw("displacedPattern"),
    ).toBeUndefined();
    void root;
  });

  it("stays fail-closed when the token appears incidentally in an unrelated CFC error (no false roll-forward)", async () => {
    // Collision guard: the token must be matched in its FRAMED reason position
    // (`: <token>: `), not anywhere in the message. Here an ordinary
    // incompatible-type rejection mentions a property PATH that happens to be
    // named `/cfc-schema-migration-incompatible` — a bare `includes(token)`
    // would misclassify it as recoverable and repoint the root. It must stay
    // fail-closed.
    const { root, oldRef, officialId } = await pinOldRequiredHome();
    const restore = patchRunSynced((opts) =>
      opts?.expectedPatternIdentity?.identity === oldRef.identity
        ? Promise.reject(
          new Error(
            "CFC enforcement rejected commit: relevant transaction was not " +
              `prepared: incompatible types at /${CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON}`,
          ),
        )
        : "real"
    );
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
    }
    // The ORIGINAL cold-start failure surfaces (fail-closed), not a heal error.
    expect(String(thrown)).toContain("Handler used as lift");
    expect(String(thrown)).not.toContain("default-root heal failed");
    const after = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(oldRef.identity);
    expect(getPatternIdentityRef(after)?.identity).not.toBe(officialId);
    expect(
      (after as unknown as { getMetaRaw: (k: string) => unknown })
        .getMetaRaw("displacedPattern"),
    ).toBeUndefined();
    void root;
  });

  it("aborts the roll-forward swap fail-closed if the root identity changed underneath it", async () => {
    // Blocking-2 guard: `editWithRetry` reruns the swap callback against fresh
    // state, so a concurrent heal that repoints the root between the failed
    // repair and our swap must NOT be clobbered by our stale `officialRef`. We
    // simulate the concurrent heal inside the repair rejection, repointing the
    // root to a THIRD (loadable) identity, then reject with the migration
    // signal so the roll-forward proceeds to the swap — where the precondition
    // must see the changed identity and abort.
    const { root, oldRef, officialId } = await pinOldRequiredHome();

    // A distinct, loadable identity for the "concurrent heal" to install.
    stub.setSource(SOURCE_V3_HANDLER);
    const otherResolved = await runtime.harness.resolve(
      new HttpProgramResolver(new URL(HOME_PATTERN_URL, runtime.apiUrl).href),
    );
    const otherPattern = await runtime.patternManager.compilePattern(
      { ...otherResolved, mainExport: "default" },
      { space: manager.getSpace() },
    );
    const concurrentId =
      runtime.patternManager.getArtifactEntryRef(otherPattern)!.identity;
    expect(concurrentId).not.toBe(oldRef.identity);
    expect(concurrentId).not.toBe(officialId);
    stub.setSource(SOURCE_HOME_OFFICIAL_DEFAULTED);

    const restore = patchRunSynced((opts) => {
      if (opts?.expectedPatternIdentity?.identity === oldRef.identity) {
        return (async () => {
          await runtime.editWithRetry((tx) => {
            root.withTx(tx).setMetaRaw("patternIdentity", {
              identity: concurrentId,
              symbol: "default",
            });
          });
          throw new Error(MIGRATION_REJECTION);
        })();
      }
      return "real";
    });
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
    }
    // Fail-closed: a superseded swap is surfaced as a CLEAR error, never
    // reported as success. This is the cold-start path, so the caller does not
    // start what we return — claiming success would hand back an unstarted,
    // un-setup root (the concurrent heal's repoint commits before its own
    // materialize).
    expect(String(thrown)).toContain("default-root heal failed");
    expect(String(thrown)).toContain("superseded by a concurrent heal");
    // Our stale roll-forward did NOT clobber the concurrent identity (no
    // displacement recorded, official identity never installed).
    const after = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(concurrentId);
    expect(getPatternIdentityRef(after)?.identity).not.toBe(officialId);
    expect(
      (after as unknown as { getMetaRaw: (k: string) => unknown })
        .getMetaRaw("displacedPattern"),
    ).toBeUndefined();

    // No silent success: the NEXT boot (runSynced restored) starts the
    // concurrent root through the ordinary repair and it works end to end —
    // the once-missing handler markers materialize and the handler fires.
    await controller.ensureDefaultPattern();
    await runtime.idle();
    const healed = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(healed)?.identity).toBe(concurrentId);
    expect(healed.key("count").get()).toBe(0);
    (healed.key("bump") as unknown as { send: (e: unknown) => void }).send({});
    await runtime.idle();
    await (healed as unknown as { pull: () => Promise<unknown> }).pull();
    const afterEvent = (await manager.getDefaultPattern(false))!;
    expect(afterEvent.key("count").get()).toBe(1);
  });

  it("surfaces one clear error when the official pattern ALSO fails to migrate", async () => {
    // The atomic-failure contract: if even the current official pattern cannot
    // migrate the reused doc, the operator gets ONE error that names WHY —
    // the pinned pattern's migration failure and the official's — instead of
    // reverse-engineering scattered logs.
    const { oldRef, officialId } = await pinOldRequiredHome();
    const restore = patchRunSynced((opts) =>
      // Reject BOTH the same-identity repair AND the official materialize.
      opts?.expectedPatternIdentity
        ? Promise.reject(new Error(MIGRATION_REJECTION))
        : "real"
    );
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("default-root heal failed");
    expect(message).toContain(oldRef.identity);
    expect(message).toContain("also failed CFC migration");
    // The underlying migration failure is chained as the cause, not discarded.
    expect((thrown as Error)?.cause).toBeDefined();
    // After a failed official materialize the root is pinned to official (the
    // current best pattern), with the displaced OLD ref recorded for recovery —
    // the next boot re-attempts official and, if it still cannot migrate,
    // short-circuits to the same clear error rather than looping.
    const after = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(officialId);
  });

  it("surfaces a clear error without looping when the root is already pinned to official", async () => {
    // If the pinned pattern already IS the official ENTRY (same identity AND
    // symbol) but still fails migration (some other cause), rolling forward
    // would target the same entry — the swap is skipped and we surface the
    // clear "already the pinned entry" error instead of looping. The
    // symbol-differs sibling below proves the gate does NOT short-circuit when
    // only the identity matches.
    await setupHome({ systemPatternAutoUpdate: true });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    await manager.stopPiece(root);
    stub.setSource(SOURCE_HOME_OFFICIAL_DEFAULTED);
    const officialResolved = await runtime.harness.resolve(
      new HttpProgramResolver(new URL(HOME_PATTERN_URL, runtime.apiUrl).href),
    );
    const officialPattern = await runtime.patternManager.compilePattern(
      { ...officialResolved, mainExport: "default" },
      { space: manager.getSpace() },
    );
    const officialRef = runtime.patternManager.getArtifactEntryRef(
      officialPattern,
    )!;
    await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: officialRef.identity,
        symbol: "default",
      });
    });
    const restore = patchRunSynced((opts) =>
      opts?.expectedPatternIdentity?.identity === officialRef.identity
        ? Promise.reject(new Error(MIGRATION_REJECTION))
        : "real"
    );
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("default-root heal failed");
    expect(message).toContain("is already the pinned entry");
    expect(message).toContain("#default");
  });

  it("rolls forward a root pinned to the current artifact under an obsolete symbol", async () => {
    // The symbol-differs case (P2): the root is pinned to the CURRENT official
    // artifact identity but under an obsolete export symbol. That entry loads
    // for real (it is a genuine export of the served module) yet fails
    // migration; the heal MUST NOT short-circuit on the shared identity — it
    // must roll forward to the official `default` entry. A gate that compared
    // identity alone treated this as already-official and left it unhealable.
    await setupHome({ systemPatternAutoUpdate: true });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    await manager.stopPiece(root);

    // The toolshed serves the two-export module. Compile BOTH exports from it:
    // they share one identity and differ only by symbol.
    stub.setSource(SOURCE_HOME_TWO_EXPORT);
    const resolved = await runtime.harness.resolve(
      new HttpProgramResolver(new URL(HOME_PATTERN_URL, runtime.apiUrl).href),
    );
    const legacyPattern = await runtime.patternManager.compilePattern(
      { ...resolved, mainExport: "legacyHome" },
      { space: manager.getSpace() },
    );
    const legacyRef = runtime.patternManager.getArtifactEntryRef(
      legacyPattern,
    )!;
    const officialPattern = await runtime.patternManager.compilePattern(
      { ...resolved, mainExport: "default" },
      { space: manager.getSpace() },
    );
    const officialRef = runtime.patternManager.getArtifactEntryRef(
      officialPattern,
    )!;
    // Same module ⇒ same identity; only the symbol differs.
    expect(legacyRef.identity).toBe(officialRef.identity);
    expect(legacyRef.symbol).toBe("legacyHome");
    expect(officialRef.symbol).toBe("default");

    // Pin the (stopped) root to the obsolete-symbol entry.
    const { error: pinError } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: legacyRef.identity,
        symbol: "legacyHome",
      });
    });
    expect(pinError).toBeUndefined();

    // Reject ONLY the obsolete-symbol repair (its migration fails); the
    // roll-forward materialize of the `default` entry runs for real and heals.
    const restore = patchRunSynced((opts) => {
      const symbol = (opts?.expectedPatternIdentity as { symbol?: string })
        ?.symbol;
      return symbol === "legacyHome"
        ? Promise.reject(new Error(MIGRATION_REJECTION))
        : "real";
    });
    try {
      await controller.ensureDefaultPattern();
    } finally {
      restore();
    }
    await runtime.idle();

    // Healed by roll-forward to the `default` entry (not short-circuited),
    // displacing the obsolete-symbol pin for recovery.
    const after = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(officialRef.identity);
    expect(getPatternIdentityRef(after)?.symbol).toBe("default");
    const displaced = (after as unknown as {
      getMetaRaw: (k: string) => unknown;
    }).getMetaRaw("displacedPattern") as { symbol?: string } | undefined;
    expect(displaced?.symbol).toBe("legacyHome");
  });

  it("surfaces a clear error when the official pattern cannot be compiled", async () => {
    // The roll-forward's compile of the official source is a failure surface
    // too: if the toolshed serves un-compilable source, the operator gets one
    // clear "could not be compiled" error, not a raw compiler stack.
    const { oldRef } = await pinOldRequiredHome();
    stub.setSource("this is not valid typescript @@@ export default");
    const restore = patchRunSynced((opts) =>
      opts?.expectedPatternIdentity?.identity === oldRef.identity
        ? Promise.reject(new Error(MIGRATION_REJECTION))
        : "real"
    );
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("default-root heal failed");
    expect(message).toContain("could not be compiled");
  });

  it("surfaces a clear error when the official pattern yields no entry identity", async () => {
    // Defensive branch: compile succeeds but the artifact has no entry ref.
    // The heal must not proceed with an undefined identity — clear error.
    const { oldRef } = await pinOldRequiredHome();
    const pm = runtime.patternManager as unknown as {
      getArtifactEntryRef: (p: unknown) => unknown;
    };
    const realGetRef = pm.getArtifactEntryRef.bind(runtime.patternManager);
    pm.getArtifactEntryRef = () => undefined;
    const restore = patchRunSynced((opts) =>
      opts?.expectedPatternIdentity?.identity === oldRef.identity
        ? Promise.reject(new Error(MIGRATION_REJECTION))
        : "real"
    );
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
      pm.getArtifactEntryRef = realGetRef;
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("default-root heal failed");
    expect(message).toContain("did not yield an entry identity");
  });

  it("surfaces a clear error when the identity swap cannot commit", async () => {
    // Defensive branch: the swap transaction itself fails to commit (a storage
    // fault, not the precondition abort). The underlying error is chained and
    // the pinned identity is left untouched.
    const { oldRef } = await pinOldRequiredHome();
    const realEdit = runtime.editWithRetry.bind(runtime);
    (runtime as unknown as {
      editWithRetry: (fn: (tx: unknown) => unknown) => Promise<unknown>;
    }).editWithRetry = (fn) =>
      // Only the roll-forward swap records `displacedPattern`, so its callback
      // source uniquely identifies it — force THAT commit to fail, leaving
      // every other edit (pins, setup) real.
      typeof fn === "function" && fn.toString().includes("displacedPattern")
        ? Promise.resolve({ error: new Error("swap backend down") })
        : realEdit(fn as never);
    const restore = patchRunSynced((opts) =>
      opts?.expectedPatternIdentity?.identity === oldRef.identity
        ? Promise.reject(new Error(MIGRATION_REJECTION))
        : "real"
    );
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
      (runtime as unknown as { editWithRetry: unknown }).editWithRetry =
        realEdit;
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("default-root heal failed");
    expect(message).toContain("identity swap could not commit");
    expect(message).toContain("swap backend down");
    const after = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(oldRef.identity);
  });

  it("failed cold-start repair stays fail-closed and leaves the doc healable", async () => {
    // The repair's own failure contract: when the one-shot setup repair
    // cannot commit, the ORIGINAL start error must surface (not the repair's),
    // and the doc must be left exactly as it was — the next boot's repair
    // attempt still heals it. Driven at the runSynced boundary because the
    // in-process failure classes (arg validation) are skipped for an
    // unchanged identity (samePattern), so a commit-layer failure is the
    // realistic remaining one.
    await setupHome({ systemPatternAutoUpdate: true });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    const staleRef = getPatternIdentityRef(root)!;
    await manager.stopPiece(root);

    stub.setSource(SOURCE_V3_HANDLER);
    const restoreProbe = shadowLoadProbe(staleRef.identity, "undefined");
    const rt = runtime as unknown as {
      runSynced: (...args: unknown[]) => Promise<unknown>;
    };
    const originalRunSynced = rt.runSynced.bind(runtime);
    rt.runSynced = () =>
      Promise.reject(new Error("repair backend unavailable"));
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (error) {
      thrown = error;
    } finally {
      rt.runSynced = originalRunSynced;
      restoreProbe();
    }
    // The original start failure surfaces, not the repair's own error.
    expect(String(thrown)).toContain("Handler used as lift");
    expect(String(thrown)).not.toContain("repair backend unavailable");

    // Nothing was torn down or corrupted: with the repair path restored, the
    // very next boot heals the same doc end-to-end.
    await controller.ensureDefaultPattern();
    await runtime.idle();
    const after = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(after)?.identity).toBe(
      await identityForSource(SOURCE_V3_HANDLER, {}, HOME_PATTERN_URL),
    );
    expect(after.key("count").get()).toBe(0);
    (after.key("bump") as unknown as { send: (e: unknown) => void }).send({});
    await runtime.idle();
    await (after as unknown as { pull: () => Promise<unknown> }).pull();
    const afterEvent = (await manager.getDefaultPattern(false))!;
    expect(afterEvent.key("count").get()).toBe(1);
  });

  it("repair guards rethrow the original start error when the pattern cannot be resolved", async () => {
    // The repair's admission guards, driven through the real boot entry.
    // Cold start of a doc in the already-swapped state whose (current)
    // identity cannot be loaded: the repair's own load sees the same
    // outcome, and each guard must surface the ORIGINAL start error.
    await setupHome({ systemPatternAutoUpdate: true });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    await manager.stopPiece(root);
    stub.setSource(SOURCE_V3_HANDLER);
    const targetId = await identityForSource(
      SOURCE_V3_HANDLER,
      {},
      HOME_PATTERN_URL,
    );
    const { error } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", {
        identity: targetId,
        symbol: "default",
      });
    });
    expect(error).toBeUndefined();

    // Guard: the repair's loadPatternByIdentity resolves undefined.
    let restore = shadowLoadProbe(targetId, "undefined");
    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (e) {
      thrown = e;
    } finally {
      restore();
    }
    expect(thrown).toBeDefined();

    // Guard: the repair's loadPatternByIdentity rejects outright.
    restore = shadowLoadProbe(targetId, "reject");
    thrown = undefined;
    try {
      await controller.ensureDefaultPattern();
    } catch (e) {
      thrown = e;
    } finally {
      restore();
    }
    expect(thrown).toBeDefined();

    // With the probes gone the same doc still heals — the guards left it
    // untouched.
    await controller.ensureDefaultPattern();
    await runtime.idle();
    const after = (await manager.getDefaultPattern(false))!;
    expect(after.key("count").get()).toBe(0);
  });

  it("repair guard rethrows the original start error for a malformed identity ref", async () => {
    // A root whose patternIdentity meta is present but malformed: start
    // fails, and the repair cannot even name a pattern to load — the
    // ref-undefined guard must surface the original start failure.
    await setupHome({ systemPatternAutoUpdate: true });
    await controller.recreateDefaultPattern({
      customProgram: {
        main: "/custom-home.tsx",
        files: [{ name: "/custom-home.tsx", contents: SOURCE_V1 }],
      },
    });
    const root = (await manager.getDefaultPattern(false))!;
    await manager.stopPiece(root);
    const { error } = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", { malformed: true });
    });
    expect(error).toBeUndefined();

    let thrown: unknown;
    try {
      await controller.ensureDefaultPattern();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
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
    await setupHome({ systemPatternAutoUpdate: true }, {
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
