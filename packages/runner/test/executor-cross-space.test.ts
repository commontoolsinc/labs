// Server-execution v2 Phase 5 — cross-space serving
// (docs/specs/server-side-execution/serving-loop.md §3b's cross-space
// bullet; protocol.md §2, §2b; builtins.md §5's per-demanding-identity
// wish resolution):
//
// - a home derivation reads a FOREIGN doc through the serving runtime's
//   ordinary storage plane, and a foreign commit WAKES the home loop
//   (the server-internal wake — never home input: W stays put, the
//   derived value still updates);
// - home-space resolution on a serving runtime targets the RUN's
//   demanding identity, never the service identity (the lunch-wall
//   trap), and refuses loudly with no identity;
// - the producer-side fail-closed refusal: a serving manager's FOREIGN
//   providers refuse scoped reads (protocol.md §2's grant-scoped read
//   design — delegated scoped reads are fail-closed until grant
//   resolution lands).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

class SharedServerStorageManager extends EmulatedStorageManager {
  static override connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    return super.connectTo(server, options) as SharedServerStorageManager;
  }
}

const newSharedServer = () =>
  new MemoryV2Server.Server({
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const homeSigner = await Identity.fromPassphrase("cross-space home");
const homeSpace = homeSigner.did() as MemorySpace;
const foreignSigner = await Identity.fromPassphrase("cross-space foreign");
const foreignSpace = foreignSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("cross-space service");
const aliceSigner = await Identity.fromPassphrase("cross-space alice");
const bobSigner = await Identity.fromPassphrase("cross-space bob");

const waitUntil = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("Phase 5 cross-space serving", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: SharedServerStorageManager;
  let clientRuntime: Runtime;
  let servingRuntime: Runtime | undefined;
  let onServingRuntime: ((runtime: Runtime) => Promise<void>) | undefined;

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: async (space) => {
        const manager = SharedServerStorageManager.connectTo(server, {
          as: serviceSigner,
          // Phase 5: the serving manager declares its home space so
          // its FOREIGN providers refuse scoped reads (the producer
          // half of the delegated-scoped-read fail-closed rule).
          servingHomeSpace: space,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntime = runtime;
        await onServingRuntime?.(runtime);
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });

  beforeEach(() => {
    server = newSharedServer();
    servingRuntime = undefined;
    onServingRuntime = undefined;
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  it("a foreign commit WAKES the home loop: the home derivation over a foreign doc re-derives without home input (serving-loop.md §3b's server-internal wake)", async () => {
    host = newHost();

    // Seed the FOREIGN input doc (bob's space) before the home loop
    // activates, so the first derivation reads a real value.
    const bobManager = SharedServerStorageManager.connectTo(server, {
      as: bobSigner,
    });
    const bobRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: bobManager,
    });
    const bobInput = bobRuntime.getCell<{ n: number }>(
      foreignSpace,
      "x-space-input",
      undefined,
    );
    {
      const tx = bobRuntime.edit();
      bobInput.withTx(tx).set({ n: 1 });
      const committed = await tx.commit();
      expect(committed.error).toBeUndefined();
    }
    await bobRuntime.storageManager.synced();

    // The serving graph: a HOME pattern whose argument is the FOREIGN
    // doc — the home derivation reads across the space boundary
    // (serving-loop.md §3b: reads cross freely; the result commits
    // HOME, protocol.md §2b's derive-from-foreign row).
    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { total: number }>(",
            "  ({ n }) => ({ total: computed(() => n + 100) }),",
            ");",
          ].join("\n"),
        }],
      }, { space: homeSpace });
      const foreignArgument = runtime.getCell<{ n: number }>(
        foreignSpace,
        "x-space-input",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        homeSpace,
        "x-space-result",
        compiled.resultSchema,
      );
      for (let attempt = 0;; attempt++) {
        await foreignArgument.sync();
        await result.sync();
        const tx = runtime.edit();
        runtime.run(tx, compiled, foreignArgument, result);
        const committed = await tx.commit();
        if (committed.error === undefined) break;
        if (attempt >= 4) {
          throw new Error(
            `serving pattern run failed: ${committed.error.message}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await runtime.idle();
    };

    // The client's DEMAND on the HOME result activates the home space.
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    const clientResult = clientRuntime.getCell<{ total: number }>(
      homeSpace,
      "x-space-result",
      undefined,
    );
    let observed: number | undefined;
    const cancel = clientResult.sink((value) => {
      observed = value?.total;
    });
    try {
      await waitUntil(
        () => observed === 101,
        `first derivation over the foreign input (saw ${observed})`,
      );
      expect(host.spaceServer(homeSpace)?.active).toBe(true);

      // The FOREIGN commit: bob updates his own space. No home input
      // follows — the wake chain (foreign session frames → autonomous
      // scheduler re-run → seal-wake) must start the re-derivation
      // well before the idle window (10 minutes here) expires.
      {
        const tx = bobRuntime.edit();
        bobInput.withTx(tx).set({ n: 2 });
        const committed = await tx.commit();
        expect(committed.error).toBeUndefined();
      }
      await waitUntil(
        () => observed === 102,
        `re-derivation after the foreign commit (saw ${observed})`,
      );
    } finally {
      cancel();
      await bobRuntime.dispose();
      await bobManager.close();
    }
  });

  it("home-space resolution on a serving runtime targets the RUN's demanding identity, never the service identity (builtins.md §5, RULED 2026-08-14)", async () => {
    const manager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
      servingHomeSpace: homeSpace,
    });
    const serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    try {
      // A stamped run acting for alice: home space = ALICE's DID space.
      const stamped = serving.edit();
      stampWaveRunContext(stamped, {
        actionId: "wish/test",
        kind: "derivation",
        scopeKeyIdentity: {
          principal: aliceSigner.did(),
          sessionId: "sess-1",
        },
      });
      expect(serving.homeSpacePrincipalFor(stamped)).toBe(aliceSigner.did());
      expect(serving.getHomeSpaceCell(stamped).space).toBe(aliceSigner.did());
      stamped.abort(new Error("test-only"));

      // A handler run's stamped ACTOR resolves the same way.
      const handler = serving.edit();
      stampWaveRunContext(handler, {
        actionId: "handler/test",
        kind: "event-handler",
        eventId: "e-1",
        acting: { user: bobSigner.did(), session: "sess-2" },
      });
      expect(serving.homeSpacePrincipalFor(handler)).toBe(bobSigner.did());
      handler.abort(new Error("test-only"));

      // NO demanding identity: undefined, and the cell resolution
      // REFUSES — never the service DID (the lunch-wall trap).
      const unstamped = serving.edit();
      expect(serving.homeSpacePrincipalFor(unstamped)).toBeUndefined();
      expect(() => serving.getHomeSpaceCell(unstamped)).toThrow(
        "per-demanding-identity",
      );
      unstamped.abort(new Error("test-only"));

      // A CLIENT runtime keeps today's behavior: its own user, tx or
      // not.
      const client = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: SharedServerStorageManager.connectTo(server, {
          as: aliceSigner,
        }),
      });
      try {
        expect(client.homeSpacePrincipalFor(undefined)).toBe(
          aliceSigner.did(),
        );
        expect(client.getHomeSpaceCell().space).toBe(aliceSigner.did());
      } finally {
        await client.storageManager.close();
        await client.dispose();
      }
    } finally {
      await serving.dispose();
      await manager.close();
    }
  });

  it("a serving manager's FOREIGN provider refuses scoped reads fail-closed (protocol.md §2's grant-scoped read design)", async () => {
    const manager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
      servingHomeSpace: homeSpace,
    });
    try {
      // Scoped read of a FOREIGN space: refused at the producer, before
      // any wire frame — the unnamed scoped root would resolve against
      // the delegating service envelope (a silently empty instance).
      const foreignScoped = await manager.open(foreignSpace).sync(
        "of:x-scoped" as never,
        { path: [], schema: false },
        "user",
      );
      expect(foreignScoped.error?.message ?? "").toContain(
        "foreign scoped read refused on the serving path",
      );

      // Space-scope foreign reads stay free (§2b's free-read row).
      const foreignSpaceScope = await manager.open(foreignSpace).sync(
        "of:x-plain" as never,
        { path: [], schema: false },
      );
      expect(foreignSpaceScope.error).toBeUndefined();

      // HOME scoped reads keep today's behavior (the OW17 tolerated
      // collapsed view).
      const homeScoped = await manager.open(homeSpace).sync(
        "of:x-home-scoped" as never,
        { path: [], schema: false },
        "user",
      );
      expect(homeScoped.error).toBeUndefined();

      // A NON-serving manager (no servingHomeSpace) is untouched.
      const plain = SharedServerStorageManager.connectTo(server, {
        as: aliceSigner,
      });
      try {
        const clientScoped = await plain.open(foreignSpace).sync(
          "of:x-scoped" as never,
          { path: [], schema: false },
          "user",
        );
        expect(clientScoped.error).toBeUndefined();
      } finally {
        await plain.close();
      }
    } finally {
      await manager.close();
    }
  });
});
