import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getPatternIdentityRef,
  isLink,
  resolveEntryIdentity,
  Runtime,
} from "@commonfabric/runner";
import {
  EmulatedStorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { createSession, Identity } from "@commonfabric/identity";
import { PieceManager } from "../src/manager.ts";
import {
  DEFAULT_APP_PATTERN_URL,
  PiecesController,
} from "../src/ops/pieces-controller.ts";

// Golden replay: the state-survival gate the flag flip (#4619) is waiting on.
//
// The other swap tests prove the ENTITY and patternIdentity swap in place; this
// one proves the thing those don't: durable state seeded under version N is
// still there, intact, after the root rolls to N+1 — no crash, no loss. It
// stands in for "open a real non-home space, add some notes, ship a new
// default-app, reopen" — the scenario both reviewers asked to see mechanically
// verified before this defaults on.

const signer = await Identity.fromPassphrase("default-app golden replay");

const EMULATED_AUDIENCE = "did:key:z6Mk-runner-emulated-memory";

function newSharedServer(): MemoryV2Server.Server {
  return new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: EMULATED_AUDIENCE },
  });
}

class SharedServerStorageManager extends EmulatedStorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      // deno-lint-ignore no-explicit-any
      { as: signer, memoryHost: new URL("memory://") } as any,
      () => server,
    );
    manager.#sharedServer = server;
    return manager;
  }

  #sharedServer!: MemoryV2Server.Server;

  protected override server(): MemoryV2Server.Server {
    return this.#sharedServer;
  }
}

// A default-app-shaped root before and after the registry rename. V2 keeps the
// old owned-cell cause privately and migrates its contents into the new cell
// once.
const ROOT_V1 = [
  "import { pattern, computed, Writable } from 'commonfabric';",
  "interface Profile { name: string; }",
  "interface Input { label?: string; profile?: Profile; }",
  "export default pattern<Input>(() => {",
  "  const allPieces = new Writable<string[]>([]);",
  "  return {",
  "    allPieces,",
  "    summary: computed(() => `v1:` + allPieces.get().length),",
  "  };",
  "});",
  "",
].join("\n");

const ROOT_V2 = [
  "import { Default, pattern, computed, Writable } from 'commonfabric';",
  "interface Profile { name: string; }",
  "interface Input { label?: string; profile: Profile; count: number | Default<2>; }",
  "export default pattern<Input>(({ profile }) => {",
  "  const legacyPieceRegistry = new Writable<string[]>([]).for('allPieces');",
  "  const pieceRegistry = new Writable<string[]>([]);",
  "  const pieceRegistryMigrationComplete = new Writable(false).for(",
  "    'pieceRegistryMigrationComplete'",
  "  );",
  "  computed(() => {",
  "    if (pieceRegistryMigrationComplete.get()) return;",
  "    const legacyPieces = legacyPieceRegistry.get();",
  "    if (legacyPieces.length > 0 && pieceRegistry.get().length === 0) {",
  "      pieceRegistry.set([...legacyPieces]);",
  "    }",
  "    pieceRegistryMigrationComplete.set(true);",
  "  });",
  "  return {",
  "    pieceRegistry,",
  "    summary: computed(() => `v2:` + pieceRegistry.get().length),",
  "    profileName: computed(() => profile.name),",
  "  };",
  "});",
  "",
].join("\n");

const SEEDED_PIECES = ["note:groceries", "note:standup", "notebook:trip"];

/** Content identity a toolshed would serve for `source`. */
function identityForSource(source: string): Promise<string> {
  return resolveEntryIdentity(
    DEFAULT_APP_PATTERN_URL,
    (name) =>
      name === DEFAULT_APP_PATTERN_URL
        ? Promise.resolve(source)
        : Promise.reject(new Error(`not found: ${name}`)),
  );
}

interface StubControls {
  setSource(source: string): void;
  restore(): void;
}

function installFetchStub(): StubControls {
  const original = globalThis.fetch;
  let source = ROOT_V1;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const url = new URL(href);

    if (url.pathname === DEFAULT_APP_PATTERN_URL) {
      if (url.searchParams.has("identity")) {
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
    restore: () => (globalThis.fetch = original),
  };
}

describe("default-app golden replay (state survives an in-place roll-forward)", () => {
  let stub: StubControls;
  let server: MemoryV2Server.Server;
  let storageManager: SharedServerStorageManager;
  let runtime: Runtime;
  let manager: PieceManager;
  let controller: PiecesController;

  beforeEach(async () => {
    stub = installFetchStub();
    stub.setSource(ROOT_V1);
    server = newSharedServer();
    storageManager = SharedServerStorageManager.connectTo(server);
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      experimental: { systemPatternAutoUpdate: true },
    });
    const session = await createSession({
      identity: signer,
      spaceName: "golden-replay-" + crypto.randomUUID(),
    });
    manager = new PieceManager(session, runtime);
    await manager.synced();
    controller = new PiecesController(manager);
  });

  afterEach(async () => {
    try {
      await controller?.dispose();
    } catch { /* already disposed */ }
    await storageManager?.close();
    await server?.close();
    stub.restore();
  });

  it("migrates legacy state once without restoring removed pieces", async () => {
    // N: instantiate the default-app-shaped root.
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    const rootLinkBefore = JSON.stringify(root.getAsLink());
    const idV1 = getPatternIdentityRef(root)?.identity;
    expect(idV1).toBe(await identityForSource(ROOT_V1));

    // Keep a live subscription on the root's reactive `summary`, the way a
    // mounted shell would. The graph is pull-based; without a standing consumer
    // the re-instantiated pattern would be built but never execute, and we would
    // only be testing the meta swap (which the sibling tests already cover), not
    // that the new code actually runs and re-reads the seeded state. The sink
    // also delivers the RESOLVED computed value (a bare `.get()` on a computed
    // result key yields the unresolved alias), which we latch here.
    let summary: unknown;
    const cancelSink = root.key("summary").sink((value) => {
      summary = value;
    });

    // Seed representative state: add pieces to the running root, the way a
    // user filling a fresh space would, and confirm they landed durably.
    await runtime.editWithRetry((tx) => {
      root.withTx(tx).key("allPieces").set([...SEEDED_PIECES]);
    });
    await piece.setInput({ profile: { name: "warm" } });
    await runtime.idle();
    expect(root.key("allPieces").get()).toEqual(SEEDED_PIECES);
    // V1's reactive summary sees the seeded state.
    expect(summary).toBe("v1:" + SEEDED_PIECES.length);

    // N+1: the toolshed now serves a newer default-app (its `summary` logic
    // changed). Roll forward in place.
    stub.setSource(ROOT_V2);
    expect(await controller.checkAndUpdateDefaultPattern()).toBe("updated");
    // Let the pattern watcher observe the meta change and re-instantiate, then
    // pull the root so the new instance actually executes (pull-based graph).
    await runtime.idle();
    const rolled = (await manager.getDefaultPattern(false))!;
    await rolled.pull();

    const registryRoot = rolled.asSchema(
      {
        type: "object",
        properties: {
          pieceRegistry: { type: "array", items: { type: "string" } },
        },
      } as const,
    );
    let pieceRegistry: unknown;
    const cancelPieceRegistrySink = registryRoot.key("pieceRegistry").sink(
      (value) => {
        pieceRegistry = value;
      },
    );
    await runtime.idle();

    // Same piece entity — the root was rewritten in place, not re-minted.
    expect(JSON.stringify(rolled.getAsLink())).toBe(rootLinkBefore);

    // The identity advanced to V2.
    const idV2 = getPatternIdentityRef(rolled)?.identity;
    expect(idV2).toBe(await identityForSource(ROOT_V2));
    expect(idV2).not.toBe(idV1);

    // The new computation proves that V2 is running before we inspect the
    // migrated state.
    expect(summary).toBe("v2:" + SEEDED_PIECES.length);

    // The crux: the state seeded under V1 survived the swap, intact and in
    // order. No crash, no loss.
    expect(pieceRegistry).toEqual(SEEDED_PIECES);

    // Emptying the canonical registry later is intentional user state. The
    // completed migration must not restore entries from the retained old cell.
    await runtime.editWithRetry((tx) => {
      rolled.withTx(tx).key("pieceRegistry").set([]);
    });
    await runtime.idle();
    expect(pieceRegistry).toEqual([]);
    expect(summary).toBe("v2:0");

    cancelPieceRegistrySink();
    cancelSink();
  });

  it("migrates the legacy registry before a cold root starts", async () => {
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    const profilePattern = await runtime.patternManager.compilePattern(
      {
        main: "/cold-update-profile.tsx",
        files: [{
          name: "/cold-update-profile.tsx",
          contents: [
            "import { pattern } from 'commonfabric';",
            "export default pattern<void>(() => ({ name: 'Ada' }));",
            "",
          ].join("\n"),
        }],
      },
      { space: manager.getSpace() },
    );
    const profile = await manager.runPersistent<{ name: string }>(
      profilePattern,
      {},
      "cold update profile",
    );
    await runtime.editWithRetry((tx) => {
      root.withTx(tx).key("allPieces").set([...SEEDED_PIECES]);
    });
    await piece.setInput({ label: "durable", profile });
    const storedProfile = (manager.getArgument(root).getRawUntyped() as {
      profile?: unknown;
    }).profile;
    expect(isLink(storedProfile)).toBe(true);
    await runtime.idle();
    await manager.synced();
    await manager.stopPiece(root);

    stub.setSource(ROOT_V2);
    const session = await createSession({
      identity: signer,
      spaceName: manager.getSpaceName()!,
    });
    const readerStorage = SharedServerStorageManager.connectTo(server);
    const freshRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: readerStorage,
      experimental: { systemPatternAutoUpdate: true },
    });
    const freshManager = new PieceManager(session, freshRuntime);
    const freshController = new PiecesController(freshManager);
    let cancelPieceRegistrySink: (() => void) | undefined;

    try {
      await freshManager.synced();
      const profileLink = profile.getAsNormalizedFullLink();
      const readerReplica = readerStorage.open(
        manager.getSpace(),
      ) as unknown as {
        get?: (uri: string, scope?: unknown) => unknown;
      };
      expect(
        readerReplica.get?.(profileLink.id, profileLink.scope),
      ).toBeUndefined();
      const coldRoot = await freshManager.getDefaultPattern(false);
      expect(coldRoot).toBeDefined();
      expect(
        await freshController.checkAndUpdateDefaultPattern(coldRoot),
      ).toBe("updated");
      expect(
        readerReplica.get?.(profileLink.id, profileLink.scope),
      ).toBeDefined();
      const updated = await freshController.ensureDefaultPattern();
      const updatedRoot = updated.getCell().asSchema(
        {
          type: "object",
          properties: {
            pieceRegistry: { type: "array", items: { type: "string" } },
          },
        } as const,
      );

      let pieceRegistry: unknown;
      cancelPieceRegistrySink = updatedRoot.key("pieceRegistry").sink(
        (value) => {
          pieceRegistry = value;
        },
      );
      await freshRuntime.idle();

      expect(getPatternIdentityRef(updatedRoot)?.identity).toBe(
        await identityForSource(ROOT_V2),
      );
      expect(pieceRegistry).toEqual(SEEDED_PIECES);
      const updatedArgument = freshManager.getArgument(updatedRoot);
      await updatedArgument.pull();
      expect(updatedArgument.get()).toEqual({
        label: "durable",
        profile: { name: "Ada" },
        count: 2,
      });
    } finally {
      cancelPieceRegistrySink?.();
      await freshController.dispose();
      await readerStorage.close();
    }
  });

  it("repairs a metadata-only roll-forward to the current pattern", async () => {
    const piece = await controller.ensureDefaultPattern();
    const root = piece.getCell();
    await piece.setInput({ profile: { name: "warm" } });
    await runtime.editWithRetry((tx) => {
      root.withTx(tx).key("allPieces").set([...SEEDED_PIECES]);
    });
    await runtime.idle();
    await manager.stopPiece(root);

    stub.setSource(ROOT_V2);
    const currentPattern = await runtime.patternManager.compilePattern(
      {
        main: DEFAULT_APP_PATTERN_URL,
        files: [{ name: DEFAULT_APP_PATTERN_URL, contents: ROOT_V2 }],
      },
      { space: manager.getSpace() },
    );
    const currentRef = runtime.patternManager.getArtifactEntryRef(
      currentPattern,
    )!;
    expect(currentRef.identity).toBe(await identityForSource(ROOT_V2));
    expect(
      (currentPattern.resultSchema as { required?: string[] }).required,
    ).toContain("pieceRegistry");

    // Reproduce the updater that advanced only patternIdentity. The persisted
    // root still carries V1's stored schema and projection.
    const metadataUpdate = await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw("patternIdentity", currentRef);
    });
    expect(metadataUpdate.error).toBeUndefined();
    const metadataOnlyRoot = (await manager.getDefaultPattern(false))!;
    expect(getPatternIdentityRef(metadataOnlyRoot)).toEqual(currentRef);
    expect(metadataOnlyRoot.getMetaRaw("schema")).not.toEqual(
      currentPattern.resultSchema,
    );
    await manager.startPiece(metadataOnlyRoot);
    expect(metadataOnlyRoot.key("pieceRegistry").getRaw()).toBeUndefined();

    const outcome = await controller.checkAndUpdateDefaultPattern(
      metadataOnlyRoot,
    );
    await runtime.idle();

    const repairedRoot = metadataOnlyRoot.asSchema(
      {
        type: "object",
        properties: {
          pieceRegistry: { type: "array", items: { type: "string" } },
        },
      } as const,
    );
    let pieceRegistry: unknown;
    const cancelPieceRegistrySink = repairedRoot.key("pieceRegistry").sink(
      (value) => {
        pieceRegistry = value;
      },
    );
    await repairedRoot.pull();
    await runtime.idle();

    expect(pieceRegistry).toEqual(SEEDED_PIECES);
    expect(outcome).toBe("updated");
    cancelPieceRegistrySink();
  });
});
