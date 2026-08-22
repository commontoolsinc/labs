// Server-execution v2 — the EXPLICIT WARM REQUEST (serving-loop.md §1's
// third activation trigger; RULED 2026-08-21):
//
// A serving-side provisioning run that stages authored SETUP into another
// space (program materialization via `replicatePatternToSpace`, a served
// `.inSpace()` create's piece scaffolding — the wave's foreign
// provisioning batches, protocol.md §2b) issues a warm request for the
// target with the staged doc instances. The host activates a parked,
// SESSIONLESS target on it (the sibling of the carries-events admission
// arm), and the target's serving loop takes the staged instances as
// identity-less warm demand, so the setup derives.
//
// T11.Q7 stays as designed: the admission hook alone still activates
// nothing — an authored admission into a lease-less space with no live
// session and no events leaves it parked. The warm request is a separate,
// deliberate signal from the run that KNOWS it staged setup needing
// derivation, never a blanket write-trigger.
//
// The pin reproduces the home-profile reload residual (the §2b
// derivation-carriage report §4's ordering race): setup lands AFTER the
// target's transient tenure parked, the creating client's sessions are
// gone, and — before this fix — nothing ever re-demands it, so the
// staged piece's computed stays underived forever.

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
import {
  applyCommit,
  read as readDoc,
  serverSeq,
} from "@commonfabric/memory/v2/engine";
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

const homeSigner = await Identity.fromPassphrase("warm request home");
const homeSpace = homeSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("warm request service");
const aliceSigner = await Identity.fromPassphrase("warm request alice");

// Bounded observation of engine/host state that becomes true as a side
// effect of the serving loop's own cycles — no event boundary exists for
// a test-side waiter without adding one to production code
// (waiting-in-tests.md: the no-callback-to-hang-a-promise-on shape; the
// same helper the neighboring executor E2Es use).
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

describe("executor-warm-request", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: SharedServerStorageManager;
  let clientRuntime: Runtime;
  let servingRuntime: Runtime | undefined;

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: (space) => {
        const manager = SharedServerStorageManager.connectTo(server, {
          as: serviceSigner,
          servingHomeSpace: space,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntime ??= runtime;
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });

  beforeEach(() => {
    server = newSharedServer();
    servingRuntime = undefined;
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  it("activates a parked, sessionless target on staged setup and derives it — the serving-side provisioning path's warm request (serving-loop.md §1; T11.Q7's write-alone parking untouched)", async () => {
    host = newHost();

    // Alice's client demands a HOME doc so the home space activates and
    // its serving loop (the provisioning run's host) is live. The client
    // never touches the provisioned space: its genesis lands
    // ENGINE-DIRECT below and every later write reaches it through the
    // serving wave's foreign batches (service-principal machinery), so
    // no client session and no event ever exists for it — what
    // activates it below can only be the warm request.
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    const demandCell = clientRuntime.getCell<{ ping: number }>(
      homeSpace,
      "warm-demand",
      undefined,
    );
    const cancel = demandCell.sink(() => {});
    try {
      await waitUntil(
        () =>
          servingRuntime !== undefined &&
          host!.spaceServer(homeSpace)?.active === true,
        "home space activation",
      );
      const serving = servingRuntime!;

      // The pattern whose materialization is the staged SETUP: compiled
      // in the HOME space (the instantiating side), replicated into the
      // provisioned space under the triggering run's §2b carriage — the
      // OW31 S-A writeback, i.e. exactly the commit that landed in the
      // parked space in the home-profile residual.
      const compiled = await serving.patternManager.compilePattern({
        main: "/warm.tsx",
        files: [{
          name: "/warm.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { out: number }>(",
            "  ({ n }) => ({ out: computed(() => n + 1) }),",
            ");",
          ].join("\n"),
        }],
      }, { space: homeSpace });
      await serving.patternManager.flushCompileCacheWrites();

      // The provisioned target: genesis ACL landed engine-direct (the
      // B4 ordering — commit #1 IS the ACL), naming the acting user
      // OWNER. Engine-direct means NO session and no admission notice
      // ever reaches the host for this space.
      const pSigner = await Identity.fromPassphrase("warm provisioned space");
      const pSpace = pSigner.did() as MemorySpace;
      const pEngine = await server.engineForSpace(pSpace);
      applyCommit(pEngine, {
        sessionId: "warm-genesis",
        space: pSpace,
        principal: pSpace,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: `of:${pSpace}`,
            value: {
              value: { [aliceSigner.did()]: "OWNER", "*": "WRITE" },
            },
          }],
        },
      });

      // The pre-setup INACTIVE probe: the provisioned space has no
      // SpaceServer — what activates it below must therefore be the
      // warm request carried by the staged setup, nothing earlier.
      expect(host!.spaceServer(pSpace)?.active ?? false).toBe(false);

      // Stage the setup, serving-side. (1) The program docs: the
      // delegated compile-cache writeback into the target's own store.
      serving.patternManager.replicatePatternToSpace(
        compiled,
        pSpace,
        homeSpace,
        {
          acting: { user: aliceSigner.did(), session: "sess-warm" },
          capabilityRef: "event-consequence:e-warm",
        },
      );
      await serving.patternManager.flushCompileCacheWrites();
      await waitUntil(
        () => serverSeq(pEngine) > 1,
        "the delegated program writeback landing in the provisioned space",
        30_000,
      );

      // (2) The piece scaffolding: a served, stamped provisioning run —
      // the T11 `.inSpace()` shape — instantiates the piece INTO the
      // provisioned space (argument + result + wiring cross via the
      // wave's foreign provisioning batch under the carried actor).
      const argumentCell = serving.getCell<{ n: number }>(
        pSpace,
        "warm-argument",
        undefined,
      );
      const resultCell = serving.getCell<{ out: number }>(
        pSpace,
        "warm-result",
        compiled.resultSchema,
      );
      await argumentCell.sync();
      await resultCell.sync();
      const homeAnchor = serving.getCell<{ linked: boolean }>(
        homeSpace,
        "warm-home-link",
        undefined,
      );
      const tx = serving.edit();
      stampWaveRunContext(tx, {
        actionId: "warm-provision",
        kind: "event-handler",
        eventId: "e-warm",
        acting: { user: aliceSigner.did(), session: "sess-warm" },
        capabilityRef: "event-consequence:e-warm",
      });
      tx.enableMultiSpaceWrites?.([pSpace, homeSpace]);
      argumentCell.withTx(tx).set({ n: 42 });
      serving.run(tx, compiled, argumentCell, resultCell);
      homeAnchor.withTx(tx).set({ linked: true });
      expect((await tx.commit()).error).toBeUndefined();

      const resultId = resultCell.getAsNormalizedFullLink().id;
      const setupSeq = () => serverSeq(pEngine);
      await waitUntil(
        () => setupSeq() > 2,
        "the staged piece scaffolding landing in the provisioned space",
        30_000,
      );

      // THE PIN. Before the warm request existed, this wait timed out:
      // the setup is durably present, the space is lease-less with no
      // live session and no events, the admission hook activates
      // nothing (T11.Q7's designed parking), and nothing ever
      // re-demands the staged setup — the home-profile "Alan Turing"
      // inertness. WITH the warm request, the provisioning path's
      // signal activates the target's own serving loop.
      await waitUntil(
        () => host!.spaceServer(pSpace)?.active === true,
        "the target space's activation on the staged setup's warm request",
        30_000,
      );

      // The demand half: the staged instances are the tenure's warm
      // demand, so the loop structure-loads the staged piece and its
      // derivation LANDS in the target's own store — a derived-class
      // commit (the target space's single deriver), with the computed's
      // value durably present.
      const derivedCommits = () =>
        (pEngine.database.prepare(
          `SELECT COUNT(*) AS n FROM "commit" WHERE class = 'derived'`,
        ).get() as { n: number }).n;
      await waitUntil(
        () => derivedCommits() > 0,
        "the staged setup's derivation committing in the target space",
        30_000,
      );
      // The result doc's `out` is a LINK to the computed's own doc; the
      // derived VALUE lives there. Follow it and read 42 + 1 durably.
      const outLinkId = () => {
        const doc = readDoc(pEngine, { id: resultId }) as {
          value?: { out?: { "/"?: { "link@1"?: { id?: string } } } };
        } | null;
        return doc?.value?.out?.["/"]?.["link@1"]?.id;
      };
      await waitUntil(
        () => {
          const id = outLinkId();
          return id !== undefined &&
            JSON.stringify(readDoc(pEngine, { id }) ?? {}).includes("43");
        },
        "the derived computed value (42 + 1) durably present in the target's own store",
        30_000,
      );
      // The warm request is observable in the loop's own counters.
      expect(host!.stats().warmRequests).toBeGreaterThan(0);
    } finally {
      cancel();
    }
  });
});
