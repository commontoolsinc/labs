import { assertEquals, assertExists, assertRejects } from "@std/assert";
import type { BranchName, MemoryProtocolFlags } from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import { serverBuiltinImplementationHash } from "../src/builtins/server-execution.ts";
import {
  createServerBuiltinBrokerClient,
  createServerBuiltinBrokerHost,
} from "../src/executor/server-builtin-channel.ts";
import {
  SharedExecutionPool,
  type SpaceExecutor,
  type SpaceExecutorFactory,
  type SpaceExecutorStartOptions,
} from "../src/executor/shared-execution-pool.ts";

const SPACE = "did:key:z6Mk-legacy-transition-space";
const SPONSOR = SPACE;
const SERVICE = "did:key:z6Mk-legacy-transition-service";
const BRANCH = "" as BranchName;
const FLAGS = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
} as const satisfies Partial<MemoryProtocolFlags>;

const authorize = (
  principal: string,
): MemoryClient.SessionOpenAuthFactory =>
(_space, _session, context) => ({
  invocation: {
    aud: context.audience,
    challenge: context.challenge.value,
  },
  authorization: { principal },
});

class GatedExecutor implements SpaceExecutor {
  readonly stopStarted = Promise.withResolvers<void>();
  readonly allowStop = Promise.withResolvers<void>();
  readonly stopOptions: Array<{ abrupt?: boolean } | undefined> = [];
  settleCalls = 0;

  setDemand(): Promise<void> {
    return Promise.resolve();
  }

  wake(): Promise<void> {
    return Promise.resolve();
  }

  settle(): Promise<number> {
    this.settleCalls++;
    return Promise.resolve(0);
  }

  async stop(options?: { abrupt?: boolean }): Promise<void> {
    this.stopOptions.push(options);
    this.stopStarted.resolve();
    await this.allowStop.promise;
  }
}

class GatedExecutorFactory implements SpaceExecutorFactory {
  readonly executor = new GatedExecutor();
  readonly starts: SpaceExecutorStartOptions[] = [];
  startOptions: SpaceExecutorStartOptions | undefined;

  start(options: SpaceExecutorStartOptions): Promise<SpaceExecutor> {
    const executor = this.starts.length === 0
      ? this.executor
      : new GatedExecutor();
    if (this.starts.length > 0) executor.allowStop.resolve();
    this.starts.push(options);
    this.startOptions = options;
    return Promise.resolve(executor);
  }
}

Deno.test("legacy background acquisition fences broker authority and waits for the live pool Worker", async () => {
  let nowMs = 100;
  const server = new Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-legacy-transition-server",
    },
    protocolFlags: FLAGS,
    acl: { mode: "off", serviceDids: [SERVICE] },
    executionControl: {
      hostId: "host:legacy-transition",
      nowMs: () => nowMs,
      leaseTtlMs: 1_000,
      claimTtlMs: 1_000,
      drainTimeoutMs: 100,
    },
  });
  const sponsorClient = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: FLAGS,
    executionCapabilities: { routing: true, builtinPassivity: true },
  } as MemoryClient.ConnectOptions);
  const serviceClient = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: FLAGS,
    executionCapabilities: { routing: true, builtinPassivity: true },
  } as MemoryClient.ConnectOptions);
  const sponsor = await sponsorClient.mount(
    SPACE,
    {},
    authorize(SPONSOR),
  );
  const service = await serviceClient.mount(
    SPACE,
    {},
    authorize(SERVICE),
  );
  const factory = new GatedExecutorFactory();
  const pool = new SharedExecutionPool({
    control: server,
    factory,
    now: () => nowMs,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const channel = new MessageChannel();
  let brokerCalls = 0;
  let brokerClient:
    | ReturnType<typeof createServerBuiltinBrokerClient>
    | undefined;
  let brokerHost: ReturnType<typeof createServerBuiltinBrokerHost> | undefined;

  pool.start();
  try {
    await sponsor.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${SPACE}:execution-policy`,
        value: { value: { version: 1, serverPrimaryExecution: true } },
      }],
    });
    assertEquals(
      await sponsor.setExecutionDemand(BRANCH, ["piece:legacy-transition"]),
      true,
    );
    await pool.idle();
    const lease = factory.startOptions?.lease;
    assertExists(lease);

    const claim = await server.setExecutionClaim(lease, {
      branch: BRANCH,
      space: SPACE,
      contextKey: "space",
      pieceId: "piece:legacy-transition",
      actionId: "action:legacy-transition-effect",
      actionKind: "effect",
      implementationFingerprint: `impl:${
        serverBuiltinImplementationHash("fetchText")
      }`,
      runtimeFingerprint: "runner:scheduler:v3",
    });
    assertExists(claim);
    assertEquals(server.hasLiveExecutionClaim(claim), true);

    brokerHost = createServerBuiltinBrokerHost({
      port: channel.port1,
      context: {
        space: SPACE,
        branch: BRANCH,
        leaseGeneration: lease.leaseGeneration,
        onBehalfOf: lease.onBehalfOf,
        servingOrigin: new URL("https://toolshed.example/"),
      },
      broker: {
        fetch() {
          brokerCalls++;
          return Promise.resolve({
            response: new Response("brokered"),
            finalUrl: new URL("https://toolshed.example/effect"),
            redirectCount: 0,
          });
        },
      },
      isClaimLive: (candidate) => server.hasLiveExecutionClaim(candidate),
    });
    brokerClient = createServerBuiltinBrokerClient({
      port: channel.port2,
      claimForRequest: () => claim,
    });
    assertEquals(
      await (await brokerClient.fetch("fetchText", "/effect")).text(),
      "brokered",
    );
    brokerCalls = 0;

    let acquisitionResolved = false;
    const acquisition = service.acquireLegacyBackgroundExclusion(BRANCH).then(
      (status) => {
        acquisitionResolved = true;
        return status;
      },
    );
    const firstBoundary = await Promise.race([
      acquisition.then(() => "acquisition" as const),
      factory.executor.stopStarted.promise.then(() => "stop" as const),
    ]);

    assertEquals(firstBoundary, "stop");
    assertEquals(acquisitionResolved, false);
    assertEquals(server.hasLiveExecutionClaim(claim), false);
    await assertRejects(
      () => brokerClient!.fetch("fetchText", "/must-not-egress"),
      Error,
      "live claim",
    );
    assertEquals(brokerCalls, 0);
    assertEquals(factory.executor.settleCalls, 0);
    assertEquals(factory.executor.stopOptions, [{ abrupt: true }]);

    factory.executor.allowStop.resolve();
    nowMs = 101;
    const acquired = await acquisition;
    assertExists(acquired);
    assertEquals(acquired.ready, true);
    assertEquals(acquired.blockedUntil, undefined);
    assertEquals(pool.snapshot(SPACE, BRANCH)?.state, "excluded");

    const released = await service.releaseLegacyBackgroundExclusion(
      BRANCH,
      acquired.exclusion.exclusionGeneration,
    );
    assertExists(released);
    await pool.idle();
    assertEquals(factory.starts.length, 2);
    assertEquals(pool.snapshot(SPACE, BRANCH)?.state, "live");
  } finally {
    factory.executor.allowStop.resolve();
    brokerClient?.dispose();
    brokerHost?.dispose();
    await pool.close();
    await sponsorClient.close();
    await serviceClient.close();
    await server.close();
  }
});
