import { assertEquals, assertExists } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import type { MemoryProtocolFlags } from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import { DenoSpaceExecutorFactory } from "../src/executor/deno-space-executor.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";

const FLAGS = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: false,
} as const satisfies Partial<MemoryProtocolFlags>;

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { pattern, computed } from 'commonfabric';",
      "export default pattern<{ value: number }>(({ value }) =>",
      "  computed(() => (value as any) * 2));",
    ].join("\n"),
  }],
};

class CountingServer extends Server {
  writerLookupCount = 0;

  override writersForTargets(
    message: Parameters<Server["writersForTargets"]>[0],
  ): ReturnType<Server["writersForTargets"]> {
    this.writerLookupCount++;
    return super.writersForTargets(message);
  }
}

class LoopbackSessionFactory implements SessionFactory {
  constructor(
    private readonly server: Server,
    private readonly flags: Partial<MemoryProtocolFlags>,
  ) {}

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    const client = await MemoryClient.connect({
      transport: MemoryClient.loopback(this.server),
      protocolFlags: this.flags,
    });
    const session = await client.mount(
      space,
      mountOptions,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    return { client, session };
  }
}

class LoopbackStorageManager extends StorageManager {
  static connectTo(
    server: Server,
    flags: Partial<MemoryProtocolFlags>,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): LoopbackStorageManager {
    return new LoopbackStorageManager(
      { ...options, memoryHost: new URL("memory://executor-pending-demand") },
      new LoopbackSessionFactory(server, flags),
    );
  }
}

Deno.test("executor retries pending demand only for its exact creation commit", async () => {
  const principal = await Identity.fromPassphrase(
    `executor pending demand ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const server = new CountingServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-executor-pending-demand" },
    protocolFlags: FLAGS,
    acl: { mode: "off", serviceDids: [space] },
  });
  const authorize: MemoryClient.SessionOpenAuthFactory = (
    _space,
    _session,
    context,
  ) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal: space },
  });
  const seedStorage = LoopbackStorageManager.connectTo(server, FLAGS, {
    as: principal,
  });
  const seedRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: seedStorage,
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
  });
  let observerClient: MemoryClient.Client | null = null;
  let executor: Awaited<ReturnType<DenoSpaceExecutorFactory["start"]>> | null =
    null;

  try {
    const compiled = await seedRuntime.patternManager.compilePattern(PROGRAM, {
      space,
    });

    const ordinaryMissingCell = seedRuntime.getCell(
      space,
      "pending-demand-public-error-contract",
    );
    const ordinaryMissingError = await seedRuntime.start(ordinaryMissingCell)
      .then(
        () => undefined,
        (error) => error as Error,
      );
    assertEquals(ordinaryMissingError?.name, "Error");
    assertEquals(ordinaryMissingError?.message, "No data at cell");

    // Prepare two valid pieces without committing either root. The first is the
    // future target of a demanded redirect that will be removed before it lands;
    // the second remains directly demanded until its creation commit arrives.
    const removedTargetTx = seedRuntime.edit();
    const removedTargetInput = seedRuntime.getCell<number>(
      space,
      "pending-demand-removed-target-input",
      undefined,
      removedTargetTx,
    );
    removedTargetInput.set(2);
    const removedTarget = seedRuntime.getCell<number>(
      space,
      "pending-demand-removed-target",
      undefined,
      removedTargetTx,
    );
    seedRuntime.run(
      removedTargetTx,
      compiled,
      { value: removedTargetInput },
      removedTarget,
    );

    const arrivingRootTx = seedRuntime.edit();
    const arrivingRootInput = seedRuntime.getCell<number>(
      space,
      "pending-demand-arriving-root-input",
      undefined,
      arrivingRootTx,
    );
    arrivingRootInput.set(3);
    const arrivingRoot = seedRuntime.getCell<number>(
      space,
      "pending-demand-arriving-root",
      undefined,
      arrivingRootTx,
    );
    seedRuntime.run(
      arrivingRootTx,
      compiled,
      { value: arrivingRootInput },
      arrivingRoot,
    );

    observerClient = await MemoryClient.connect({
      transport: MemoryClient.loopback(server),
      protocolFlags: FLAGS,
    });
    const observer = await observerClient.mount(space, {}, authorize);
    const redirectRoot = seedRuntime.getCell(
      space,
      "pending-demand-redirect-root",
    ).sourceURI;
    await observer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: redirectRoot,
        value: {
          value: {
            "/": {
              "link@1": {
                id: removedTarget.sourceURI,
                path: [],
                space,
                scope: "space",
              },
            },
          },
        },
      }],
    });
    await observer.setExecutionDemand("", [
      arrivingRoot.sourceURI,
      redirectRoot,
    ]);
    const lease = await server.acquireExecutionLease(space, "");
    assertExists(lease);

    const discoveries: string[] = [];
    const candidates: string[] = [];
    const crashes: unknown[] = [];
    const factory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: new URL("https://toolshed.example/"),
      patternApiUrl: new URL("https://toolshed.example/"),
      protocolFlags: FLAGS,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
      onWriterDiscovery: (discovery) => discoveries.push(discovery.pieceId),
      onCandidateClaim: (candidate) =>
        candidates.push(candidate.claimKey.pieceId),
    });
    server.writerLookupCount = 0;
    executor = await factory.start({
      space,
      branch: "",
      lease,
      pieces: [arrivingRoot.sourceURI, redirectRoot],
      onCrash: (error) => crashes.push(error),
    });

    // The redirect reaches one absent target. It gets one initial activation
    // attempt; the absent direct root requires no writer lookup yet.
    assertEquals(server.writerLookupCount, 1);
    assertEquals(discoveries, []);

    await observer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: seedRuntime.getCell(
          space,
          "pending-demand-unrelated",
        ).sourceURI,
        value: { value: { unrelated: true } },
      }],
    });
    await executor.settle();
    assertEquals(server.writerLookupCount, 1);

    // Removing the redirect clears its pending dependency. Creating that target
    // afterward must not resurrect or discover the removed demand.
    await executor.setDemand([arrivingRoot.sourceURI]);
    assertEquals((await removedTargetTx.commit()).error, undefined);
    await executor.settle();
    assertEquals(discoveries, []);

    assertEquals((await arrivingRootTx.commit()).error, undefined);
    await executor.settle();
    assertEquals(discoveries, [arrivingRoot.sourceURI]);
    assertEquals(candidates.length, 1);

    // The persistent demand consumer is lifecycle-owned by the root. Shrink
    // releases it and stops the instantiated piece, so later source commits do
    // not produce another candidate from the removed graph.
    await executor.setDemand([]);
    await observer.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: arrivingRootInput.sourceURI,
        value: { value: 4 },
      }],
    });
    await executor.settle();
    assertEquals(candidates.length, 1);
    assertEquals(crashes, []);
  } finally {
    await executor?.stop().catch(() => undefined);
    await observerClient?.close().catch(() => undefined);
    await seedRuntime.dispose().catch(() => undefined);
    await server.close();
  }
});
