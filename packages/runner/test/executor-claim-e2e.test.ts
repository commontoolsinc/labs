import { assertEquals, assertExists } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import {
  addMockResponse,
  enableMockMode,
  resetMockMode,
} from "@commonfabric/llm/client";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import type {
  ActionSettlement,
  ClientCommit,
  MemoryProtocolFlags,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { DenoSpaceExecutorFactory } from "../src/executor/deno-space-executor.ts";
import type { ServerBuiltinFetchRequest } from "../src/executor/server-builtin-egress.ts";

const FLAGS = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
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

const BUILTIN_FLAGS = {
  ...FLAGS,
} as const satisfies Partial<MemoryProtocolFlags>;

const ASYNC_BUILTIN_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { pattern, fetchText, generateText } from 'commonfabric';",
      "export default pattern<{ url: string }>(({ url }) => ({",
      "  fetched: fetchText({ url }),",
      "  generated: generateText({ prompt: url }),",
      "}));",
    ].join("\n"),
  }],
};

class LoopbackSessionFactory implements SessionFactory {
  constructor(
    private readonly server: Server,
    private readonly flags: Partial<MemoryProtocolFlags>,
    private readonly onCommit?: (commit: ClientCommit) => void,
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
    if (this.onCommit !== undefined) {
      const transact = session.transact.bind(session);
      session.transact = (commit) => {
        this.onCommit!(structuredClone(commit));
        return transact(commit);
      };
    }
    return { client, session };
  }
}

class LoopbackStorageManager extends StorageManager {
  static connectTo(
    server: Server,
    flags: Partial<MemoryProtocolFlags>,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
    onCommit?: (commit: ClientCommit) => void,
  ): LoopbackStorageManager {
    return new LoopbackStorageManager(
      { ...options, memoryHost: new URL("memory://executor-claim-e2e") },
      new LoopbackSessionFactory(server, flags, onCommit),
    );
  }
}

const awaitBarrier = async <T>(
  barrier: Promise<T>,
  name: string,
  events: readonly string[],
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      barrier,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} timed out: ${events.join(" | ")}`)),
          10_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const containsStoredValue = (value: unknown, expected: string): boolean =>
  value === expected ||
  (Array.isArray(value)
    ? value.some((entry) => containsStoredValue(entry, expected))
    : typeof value === "object" && value !== null
    ? Object.values(value).some((entry) => containsStoredValue(entry, expected))
    : false);

Deno.test("explicit claim routing commits a real pure computation under its sponsor", async () => {
  const principal = await Identity.fromPassphrase(
    `executor claim e2e ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const server = new Server({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-executor-claim-e2e" },
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
  let executor: Awaited<ReturnType<DenoSpaceExecutorFactory["start"]>> | null =
    null;
  let observerClient: MemoryClient.Client | null = null;
  let unsubscribeAccepted = () => {};
  let unsubscribeControl = () => {};
  let unsubscribeNoOp = () => {};
  let unsubscribeClientSettlement = () => {};
  const clientRuntimes: Runtime[] = [];
  const clientStorages: LoopbackStorageManager[] = [];
  const events: string[] = [];
  try {
    const compiled = await seedRuntime.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const tx = seedRuntime.edit();
    const input = seedRuntime.getCell<number>(
      space,
      "executor-e2e-input",
      undefined,
      tx,
    );
    input.set(5);
    const result = seedRuntime.getCell<number>(
      space,
      "executor-e2e-result",
      undefined,
      tx,
    );
    const resultLink = result.getAsNormalizedFullLink();
    const handle = seedRuntime.run(tx, compiled, { value: input }, result);
    assertEquals((await tx.commit()).error, undefined);
    assertEquals(await handle.pull(), 10);
    await seedRuntime.settled();
    await seedRuntime.storageManager.synced();
    const pieceDocument = await server.readDocument(space, result.sourceURI) as
      & Record<string, unknown>
      & { value: { "/": { "link@1": { id: string } } } };
    const outputId = pieceDocument.value["/"]["link@1"].id;
    assertEquals(
      (await server.readDocument(space, outputId) as { value?: unknown })
        ?.value,
      10,
    );
    await seedRuntime.dispose();

    observerClient = await MemoryClient.connect({
      transport: MemoryClient.loopback(server),
      protocolFlags: FLAGS,
    });
    const observer = await observerClient.mount(space, {}, authorize);
    await observer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${space}:execution-policy`,
        value: { value: { version: 1, serverPrimaryExecution: true } },
      }],
    });
    await observer.setExecutionDemand("", [result.sourceURI]);
    await observer.watchSet([{
      id: "executor-claim-e2e-piece",
      kind: "graph",
      query: {
        roots: [{
          id: result.sourceURI,
          selector: { path: [], schema: true },
        }],
      },
    }]);
    const lease = await server.acquireExecutionLease(space, "");
    assertExists(lease);
    assertEquals(lease.onBehalfOf, space);

    const claimed = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<ActionSettlement>();
    let sourceSeq = Number.POSITIVE_INFINITY;
    unsubscribeControl = observer.subscribeExecutionControl((event) => {
      events.push(event.type);
      if (event.type === "session.execution.claim.set") claimed.resolve();
      if (
        event.type === "session.execution.settlement" &&
        event.settlement.inputBasisSeq >= sourceSeq
      ) {
        settled.resolve(event.settlement);
      }
    });
    const outputAccepted = Promise.withResolvers<void>();
    unsubscribeAccepted = server.subscribeAcceptedCommits(space, (event) => {
      events.push(
        `accepted:${event.revisions.map((revision) => revision.id).join(",")}`,
      );
      events.push(
        `accepted:${event.revisions.map((revision) => revision.id).join(",")}`,
      );
      if (
        event.revisions.some((revision) => revision.id === outputId)
      ) {
        outputAccepted.resolve();
      }
    });

    const factory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: new URL("https://toolshed.example/"),
      patternApiUrl: new URL("https://toolshed.example/"),
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
      onCandidateClaim: (candidate) =>
        events.push(`candidate:${candidate.claimKey.actionId}`),
      onCandidateDiagnostic: (diagnostic) =>
        events.push(`diagnostic:${diagnostic.diagnosticCode}`),
      onWriterDiscovery: (discovery) =>
        events.push(
          `writers:${discovery.indexMiss}:${discovery.writers.length}`,
        ),
    });
    executor = await factory.start({
      space,
      branch: "",
      lease,
      pieces: [result.sourceURI],
      onCrash(error) {
        events.push(`crash:${error}`);
      },
    });
    const source = await observer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: 7 },
      }],
    });
    sourceSeq = source.seq;
    await awaitBarrier(claimed.promise, "claim", events);
    await awaitBarrier(outputAccepted.promise, "output", events);
    const settlement = await awaitBarrier(
      settled.promise,
      "settlement",
      events,
    );

    assertEquals(settlement.outcome, "committed");
    assertEquals(settlement.inputBasisSeq >= source.seq, true);
    assertEquals(
      (await server.readDocument(space, outputId) as { value?: unknown })
        ?.value,
      14,
    );
    const snapshots = await observer.listSchedulerActionSnapshots({
      actionId: settlement.claim.actionId,
      pieceId: settlement.claim.pieceId,
    });
    const acceptedObservation = snapshots.snapshots.at(-1)?.observation as {
      executionProvenance?: { onBehalfOf?: string };
    };
    assertEquals(acceptedObservation.executionProvenance?.onBehalfOf, space);

    const noOpSettled = Promise.withResolvers<ActionSettlement>();
    let noOpSourceSeq = Number.POSITIVE_INFINITY;
    unsubscribeNoOp = observer.subscribeExecutionControl((event) => {
      if (
        event.type === "session.execution.settlement" &&
        event.settlement.inputBasisSeq >= noOpSourceSeq
      ) {
        noOpSettled.resolve(event.settlement);
      }
    });
    const noOpSource = await observer.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: 8 },
      }, {
        op: "set",
        id: outputId,
        value: {
          ...(await server.readDocument(space, outputId) ?? {}),
          value: 16,
        },
      }],
    });
    noOpSourceSeq = noOpSource.seq;
    const noOpSettlement = await awaitBarrier(
      noOpSettled.promise,
      "no-op settlement",
      events,
    );
    assertEquals(noOpSettlement.outcome, "no-op");
    assertEquals(noOpSettlement.inputBasisSeq >= noOpSource.seq, true);
    assertEquals(
      (await server.readDocument(space, outputId) as { value?: unknown })
        ?.value,
      16,
    );

    const clientDerivedCommits: ClientCommit[] = [];
    for (let index = 0; index < 3; index++) {
      const storage = LoopbackStorageManager.connectTo(
        server,
        FLAGS,
        { as: principal },
        (commit) => clientDerivedCommits.push(commit),
      );
      clientStorages.push(storage);
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        experimental: {
          persistentSchedulerState: true,
          serverPrimaryExecution: true,
        },
      });
      clientRuntimes.push(runtime);
      await runtime.patternManager.compilePattern(PROGRAM, { space });
      const resumed = runtime.getCellFromLink(resultLink);
      await resumed.sync();
      assertEquals(await runtime.start(resumed), true);
      await resumed.pull();
      await runtime.settled();
    }
    clientDerivedCommits.length = 0;

    const clientSettled = Promise.withResolvers<ActionSettlement>();
    let clientSourceSeq = Number.POSITIVE_INFINITY;
    unsubscribeClientSettlement = observer.subscribeExecutionControl(
      (event) => {
        if (
          event.type === "session.execution.settlement" &&
          event.settlement.inputBasisSeq >= clientSourceSeq
        ) {
          clientSettled.resolve(event.settlement);
        }
      },
    );
    const clientSource = await observer.transact({
      localSeq: 4,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: 9 },
      }],
    });
    clientSourceSeq = clientSource.seq;
    const clientSettlement = await awaitBarrier(
      clientSettled.promise,
      "multi-client settlement",
      events,
    );
    assertEquals(clientSettlement.outcome, "committed");
    for (const runtime of clientRuntimes) await runtime.settled();
    assertEquals(
      clientDerivedCommits.filter((commit) => {
        const observation = commit.schedulerObservation as {
          actionId?: string;
          actionKind?: string;
        } | undefined;
        return observation?.actionId === clientSettlement.claim.actionId &&
          observation.actionKind === "computation" &&
          commit.operations.length > 0;
      }),
      [],
    );
    assertEquals(
      (await server.readDocument(space, outputId) as { value?: unknown })
        ?.value,
      18,
    );

    // Phase 2 deliberately keeps client computation live for speculative UI
    // latency. Its rollout gate is therefore exact action-run parity, not a
    // timing claim: enabling authority must not increase lazy-client runs for
    // the same constant-size graph. CPU sampling is a separate browser
    // measurement because scheduler duration is elapsed time, not CPU time.
    const actionId = clientSettlement.claim.actionId;
    const isDerivedWireCommit = (commit: ClientCommit): boolean => {
      const observation = commit.schedulerObservation as {
        actionId?: string;
        actionKind?: string;
      } | undefined;
      return observation?.actionId === actionId &&
        observation.actionKind === "computation" &&
        commit.operations.length > 0;
    };
    const resetClientActionTraces = (): void => {
      for (const runtime of clientRuntimes) {
        runtime.scheduler.setActionRunTraceEnabled(false);
        runtime.scheduler.setActionRunTraceEnabled(true);
      }
    };
    const clientActionRunCount = (): number =>
      clientRuntimes.reduce(
        (total, runtime) =>
          total + runtime.scheduler.getActionRunTrace().filter((entry) =>
            entry.actionId === actionId && entry.actionType === "computation"
          ).length,
        0,
      );
    const p95 = (samples: readonly number[]): number => {
      const sorted = [...samples].sort((left, right) => left - right);
      return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
    };

    let observerLocalSeq = 4;
    const writePolicy = async (enabled: boolean): Promise<void> => {
      await observer.transact({
        localSeq: ++observerLocalSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}:execution-policy`,
          value: {
            value: { version: 1, serverPrimaryExecution: enabled },
          },
        }],
      });
    };
    const runInvalidation = async (value: number): Promise<number> => {
      resetClientActionTraces();
      const accepted = Promise.withResolvers<void>();
      const unsubscribe = server.subscribeAcceptedCommits(space, (event) => {
        if (event.revisions.some((revision) => revision.id === outputId)) {
          accepted.resolve();
        }
      });
      try {
        await observer.transact({
          localSeq: ++observerLocalSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: input.sourceURI,
            value: { value },
          }],
        });
        // Loopback clients do not own the host wake index. Pull the accepted
        // source through each lazy replica so its normal scheduler path can
        // run (or adopt the server observation) before waiting on the output.
        for (const runtime of clientRuntimes) {
          await runtime.storageManager.synced();
          await runtime.getCellFromLink(resultLink).pull();
          await runtime.settled();
        }
        await awaitBarrier(
          accepted.promise,
          `output ${value}`,
          events,
        );
      } finally {
        unsubscribe();
      }

      for (const runtime of clientRuntimes) {
        await runtime.settled();
        const visible = runtime.getCellFromLink(resultLink);
        assertEquals(await visible.pull(), value * 2);
        await runtime.settled();
      }
      assertEquals(
        (await server.readDocument(space, outputId) as { value?: unknown })
          ?.value,
        value * 2,
      );
      return clientActionRunCount();
    };
    const runPhase = async (startValue: number): Promise<number[]> => {
      const samples: number[] = [];
      for (let offset = 0; offset < 20; offset++) {
        samples.push(await runInvalidation(startValue + offset));
      }
      return samples;
    };

    const revoked = Promise.withResolvers<void>();
    const unsubscribeRevoke = observer.subscribeExecutionControl((event) => {
      if (
        event.type === "session.execution.claim.revoke" &&
        event.claim.actionId === actionId &&
        event.leaseGeneration === clientSettlement.claim.leaseGeneration &&
        event.claimGeneration === clientSettlement.claim.claimGeneration
      ) {
        revoked.resolve();
      }
    });
    try {
      await writePolicy(false);
      await awaitBarrier(revoked.promise, "policy claim revoke", events);
    } finally {
      unsubscribeRevoke();
    }
    for (const runtime of clientRuntimes) {
      await runtime.storageManager.synced();
    }

    // An unmeasured invalidation proves the disabled path has returned write
    // authority to clients before the baseline trace starts.
    clientDerivedCommits.length = 0;
    await runInvalidation(100);
    assertEquals(clientDerivedCommits.some(isDerivedWireCommit), true);
    clientDerivedCommits.length = 0;
    const disabledRuns = await runPhase(101);
    assertEquals(disabledRuns.every((runs) => runs > 0), true);

    // This test drives DenoSpaceExecutorFactory directly, outside the shared
    // pool that normally renews the lease. Refresh the direct fixture's lease
    // and generation before restoring policy so the comparison cannot become
    // a lease-TTL test as its sample count grows.
    assertExists(executor);
    await executor.stop();
    executor = null;
    await server.flushExecutionLeaseTasks();
    const drainingLease = await server.acquireExecutionLease(space, "");
    assertExists(drainingLease);
    assertEquals(drainingLease.state, "draining");
    assertExists(await server.finishExecutionLeaseDrain(drainingLease));
    const rolloutLease = await server.acquireExecutionLease(space, "");
    assertExists(rolloutLease);
    await writePolicy(true);
    const reclaimed = Promise.withResolvers<void>();
    let reclaimedGeneration = 0;
    const unsubscribeReclaim = observer.subscribeExecutionControl((event) => {
      if (
        event.type === "session.execution.claim.set" &&
        event.claim.actionId === actionId
      ) {
        reclaimedGeneration = event.claim.claimGeneration;
        reclaimed.resolve();
      }
    });
    try {
      executor = await factory.start({
        space,
        branch: "",
        lease: rolloutLease,
        pieces: [result.sourceURI],
        onCrash(error) {
          events.push(`crash:${error}`);
        },
      });
      // A persisted clean action has no reason to report itself merely because
      // its Worker restarted. One excluded source invalidation drives normal
      // discovery and the positive claim transition.
      clientDerivedCommits.length = 0;
      await runInvalidation(200);
      await awaitBarrier(reclaimed.promise, "policy claim restore", events);
    } finally {
      unsubscribeReclaim();
    }
    assertEquals(
      reclaimedGeneration > clientSettlement.claim.claimGeneration,
      true,
    );
    for (const runtime of clientRuntimes) {
      await runtime.storageManager.synced();
    }

    // Warm the new claim incarnation, then exclude that transition from both
    // the exact-run samples and the client-wire assertion.
    clientDerivedCommits.length = 0;
    await runInvalidation(201);
    assertEquals(clientDerivedCommits.some(isDerivedWireCommit), false);
    clientDerivedCommits.length = 0;
    const enabledRuns = await runPhase(202);
    assertEquals(clientDerivedCommits.some(isDerivedWireCommit), false);

    const disabledP95 = p95(disabledRuns);
    const enabledP95 = p95(enabledRuns);
    assertEquals(
      enabledP95 <= disabledP95,
      true,
      `enabled p95 client action runs/invalidation ${enabledP95} exceeded disabled ${disabledP95}; disabled=${
        disabledRuns.join(",")
      }; enabled=${enabledRuns.join(",")}`,
    );
  } finally {
    unsubscribeAccepted();
    unsubscribeControl();
    unsubscribeNoOp();
    unsubscribeClientSettlement();
    for (const runtime of clientRuntimes) await runtime.dispose();
    for (const storage of clientStorages) await storage.close();
    await executor?.stop();
    await seedRuntime.dispose();
    await seedStorage.close();
    await observerClient?.close();
    await server.close();
  }
});

Deno.test("claimed builtins use host broker while client sinks observe pending and result", async () => {
  const principal = await Identity.fromPassphrase(
    `executor builtin e2e ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const servingOrigin = new URL("https://toolshed.example/");
  const server = new Server({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-executor-builtin-e2e" },
    protocolFlags: BUILTIN_FLAGS,
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
  const seedStorage = LoopbackStorageManager.connectTo(
    server,
    BUILTIN_FLAGS,
    { as: principal },
  );
  const seedRuntime = new Runtime({
    apiUrl: servingOrigin,
    patternEnvironment: { apiUrl: servingOrigin },
    storageManager: seedStorage,
    fetch: () => Promise.reject(new Error("seed must not fetch")),
    externalSinkDisposition: "suppress",
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
  });
  let executor: Awaited<ReturnType<DenoSpaceExecutorFactory["start"]>> | null =
    null;
  let observerClient: MemoryClient.Client | null = null;
  let unsubscribeAccepted = () => {};
  const clientRuntimes: Runtime[] = [];
  const clientStorages: LoopbackStorageManager[] = [];
  const clientSinkCancels: (() => void)[] = [];
  const events: string[] = [];
  const brokerRequests: ServerBuiltinFetchRequest[] = [];
  let heldBrokerRound:
    | {
      requestCount: number;
      started: PromiseWithResolvers<void>;
      release: Promise<void>;
    }
    | undefined;
  try {
    const compiled = await seedRuntime.patternManager.compilePattern(
      ASYNC_BUILTIN_PROGRAM,
      { space },
    );
    const tx = seedRuntime.edit();
    const input = seedRuntime.getCell<string>(
      space,
      "executor-builtin-url",
      undefined,
      tx,
    );
    input.set("/server");
    const result = seedRuntime.getCell<Record<string, unknown>>(
      space,
      "executor-builtin-result",
      undefined,
      tx,
    );
    const resultLink = result.getAsNormalizedFullLink();
    const handle = seedRuntime.run(tx, compiled, { url: input }, result);
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    await seedRuntime.settled();
    await seedRuntime.storageManager.synced();
    assertEquals(handle.key("fetched").key("result").get(), undefined);
    assertEquals(handle.key("generated").key("result").get(), undefined);
    await seedRuntime.dispose();

    observerClient = await MemoryClient.connect({
      transport: MemoryClient.loopback(server),
      protocolFlags: BUILTIN_FLAGS,
    });
    const observer = await observerClient.mount(space, {}, authorize);
    await observer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${space}:execution-policy`,
        value: { value: { version: 1, serverPrimaryExecution: true } },
      }],
    });
    await observer.setExecutionDemand("", [result.sourceURI]);
    await observer.watchSet([{
      id: "executor-builtin-e2e-piece",
      kind: "graph",
      query: {
        roots: [{
          id: result.sourceURI,
          selector: { path: [], schema: true },
        }],
      },
    }]);
    const lease = await server.acquireExecutionLease(space, "");
    assertExists(lease);
    assertEquals(lease.onBehalfOf, space);

    const claimed = Promise.withResolvers<void>();
    const claimedBuiltins = new Set<string>();
    const resultAccepted = Promise.withResolvers<void>();
    const acceptedResults = new Set<string>();
    observer.subscribeExecutionControl((event) => {
      events.push(event.type);
      if (event.type === "session.execution.claim.set") {
        claimedBuiltins.add(event.claim.implementationFingerprint);
        if (
          [...claimedBuiltins].some((value) => value.includes("fetchText")) &&
          [...claimedBuiltins].some((value) => value.includes("generateText"))
        ) {
          claimed.resolve();
        }
      }
    });
    unsubscribeAccepted = server.subscribeAcceptedCommits(space, (event) => {
      for (const revision of event.revisions) {
        void server.readDocument(space, revision.id).then((document) => {
          const value = (document as { value?: unknown } | undefined)?.value;
          if (containsStoredValue(value, "server response")) {
            acceptedResults.add("server response");
          }
          if (containsStoredValue(value, "generated response")) {
            acceptedResults.add("generated response");
          }
          if (
            acceptedResults.has("server response") &&
            acceptedResults.has("generated response")
          ) {
            resultAccepted.resolve();
          }
        });
      }
    });

    const factory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: servingOrigin,
      patternApiUrl: servingOrigin,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
      createBuiltinBroker: () => ({
        async fetch(request) {
          events.push(`broker:${request.url}`);
          brokerRequests.push(request);
          const heldRound = heldBrokerRound;
          if (heldRound !== undefined) {
            heldRound.requestCount += 1;
            if (heldRound.requestCount === 2) heldRound.started.resolve();
            await heldRound.release;
          }
          const response = request.url.startsWith("/api/ai/llm")
            ? Response.json({
              role: "assistant",
              content: "generated response",
              id: "server-generate-e2e",
            })
            : new Response("server response");
          return {
            response,
            finalUrl: new URL(request.url, servingOrigin),
            redirectCount: 0,
          };
        },
      }),
      authorizeBuiltinRequest: () => {
        events.push("broker-authorized");
      },
      onCandidateClaim: (candidate) =>
        events.push(
          `candidate:${candidate.builtinId}:${candidate.claimKey.actionId}`,
        ),
      onCandidateDiagnostic: (diagnostic) =>
        events.push(`diagnostic:${diagnostic.diagnosticCode}`),
    });
    executor = await factory.start({
      space,
      branch: "",
      lease,
      pieces: [result.sourceURI],
      onCrash(error) {
        events.push(`crash:${error}`);
      },
    });

    await awaitBarrier(claimed.promise, "builtin claim", events);
    await awaitBarrier(
      resultAccepted.promise,
      "builtin result writeback",
      events,
    );

    assertEquals(brokerRequests.length, 2);
    assertEquals(
      brokerRequests.map((request) => request.url).sort(),
      ["/api/ai/llm", "/server"],
    );
    assertEquals(
      events.some((event) => event.startsWith("candidate:fetchText:")),
      true,
    );
    assertEquals(
      events.some((event) => event.startsWith("candidate:generateText:")),
      true,
    );
    assertEquals(events.some((event) => event.startsWith("crash:")), false);

    const clientNetworkRequests: string[] = [];
    const clientFetch = (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      clientNetworkRequests.push(url);
      return Promise.resolve(
        url.includes("/api/ai/llm")
          ? Response.json({
            role: "assistant",
            content: "client generated response",
            id: "client-generate-e2e",
          })
          : new Response("client fetch response"),
      );
    };
    const clientWireCommits: ClientCommit[] = [];
    const clientDerivedWrites = () =>
      clientWireCommits.filter((commit) =>
        commit.schedulerObservation !== undefined &&
        commit.operations.length > 0
      );
    const clientPendingObserved = Promise.withResolvers<void>();
    const clientResultsObserved = Promise.withResolvers<void>();
    const clientPendingKinds = new Set<"fetch" | "generate">();
    const clientResultKinds = new Set<"fetch" | "generate">();
    let observeClientTransition = false;
    const observeBuiltin = (
      kind: "fetch" | "generate",
      expectedResult: string,
      value: unknown,
    ) => {
      if (!observeClientTransition) return;
      const state = (value ?? {}) as {
        pending?: boolean;
        result?: unknown;
      };
      events.push(
        `client:${kind}:${String(state.pending)}:${String(state.result)}`,
      );
      if (state.pending === true) {
        clientPendingKinds.add(kind);
        if (clientPendingKinds.size === 2) clientPendingObserved.resolve();
      }
      if (
        state.pending === false && state.result === expectedResult &&
        clientPendingKinds.has(kind)
      ) {
        clientResultKinds.add(kind);
        if (clientResultKinds.size === 2) clientResultsObserved.resolve();
      }
    };
    for (let index = 0; index < 3; index++) {
      const storage = LoopbackStorageManager.connectTo(
        server,
        BUILTIN_FLAGS,
        { as: principal },
        (commit) => clientWireCommits.push(commit),
      );
      clientStorages.push(storage);
      const runtime = new Runtime({
        apiUrl: servingOrigin,
        patternEnvironment: { apiUrl: servingOrigin },
        storageManager: storage,
        fetch: clientFetch,
        experimental: {
          persistentSchedulerState: true,
          serverPrimaryExecution: true,
        },
      });
      clientRuntimes.push(runtime);
      await runtime.patternManager.compilePattern(ASYNC_BUILTIN_PROGRAM, {
        space,
      });
      const resumed = runtime.getCellFromLink(resultLink);
      await resumed.sync();
      assertEquals(await runtime.start(resumed), true);
      if (index === 0) {
        clientSinkCancels.push(
          resumed.key("fetched").sink((value) =>
            observeBuiltin("fetch", "server response", value)
          ),
          resumed.key("generated").sink((value) =>
            observeBuiltin("generate", "generated response", value)
          ),
        );
      }
      await resumed.pull();
      await runtime.settled();
    }
    clientNetworkRequests.length = 0;
    clientWireCommits.length = 0;
    observeClientTransition = true;

    const secondBrokerStarted = Promise.withResolvers<void>();
    const releaseSecondBrokerRound = Promise.withResolvers<void>();
    heldBrokerRound = {
      requestCount: 0,
      started: secondBrokerStarted,
      release: releaseSecondBrokerRound.promise,
    };
    try {
      await observer.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: input.sourceURI,
          value: { value: "/server-next" },
        }],
      });
      await awaitBarrier(
        secondBrokerStarted.promise,
        "server broker requests",
        events,
      );
      await awaitBarrier(
        clientPendingObserved.promise,
        "client builtin pending state",
        events,
      );
      assertEquals(heldBrokerRound.requestCount, 2);
      assertEquals(clientNetworkRequests, []);
      assertEquals(clientDerivedWrites(), []);
      releaseSecondBrokerRound.resolve();
      await awaitBarrier(
        clientResultsObserved.promise,
        "client builtin result state",
        events,
      );
    } finally {
      releaseSecondBrokerRound.resolve();
      heldBrokerRound = undefined;
    }
    for (const runtime of clientRuntimes) await runtime.settled();
    assertEquals(clientNetworkRequests, []);
    assertEquals(clientDerivedWrites(), []);

    // Permanent authority removal releases the same three clients back to the
    // existing durable mutex. Exactly one fetch and one generation may leave
    // the browser cohort; no polling or heartbeat grants authority.
    const claimsRevoked = Promise.withResolvers<void>();
    const unsubscribeClaimsRevoked = observer.subscribeExecutionControl(
      (event) => {
        if (
          event.type === "session.execution.claim.revoke" &&
          observer.executionClaims.length === 0
        ) {
          claimsRevoked.resolve();
        }
      },
    );
    await observer.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${space}:execution-policy`,
        value: { value: { version: 1, serverPrimaryExecution: false } },
      }],
    });
    try {
      await awaitBarrier(
        claimsRevoked.promise,
        "builtin claims revoked",
        events,
      );
    } finally {
      unsubscribeClaimsRevoked();
    }
    assertEquals(observer.executionClaims, []);
    clientNetworkRequests.length = 0;
    const clientFallback = Promise.withResolvers<void>();
    const clientFallbackKinds = new Set<"fetch" | "generate">();
    enableMockMode();
    // Current client-primary mutex behavior may retry across runtimes before
    // one writeback wins. Supply a bounded fixture pool so those established
    // retries remain mocked without warning after authority returns.
    for (let attempt = 0; attempt < clientRuntimes.length * 4; attempt++) {
      addMockResponse(
        () => {
          clientFallbackKinds.add("generate");
          if (clientFallbackKinds.size === 2) clientFallback.resolve();
          return true;
        },
        {
          role: "assistant",
          content: "client generated response",
          id: `client-generate-e2e-${attempt}`,
        },
      );
    }
    const resolvingClientFetch = async (input: string | URL | Request) => {
      const response = await clientFetch(input);
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      clientFallbackKinds.add(
        url.includes("/api/ai/llm") ? "generate" : "fetch",
      );
      if (clientFallbackKinds.size === 2) clientFallback.resolve();
      return response;
    };
    for (const runtime of clientRuntimes) {
      Object.defineProperty(runtime, "fetch", {
        configurable: true,
        value: resolvingClientFetch,
      });
    }
    await observer.transact({
      localSeq: 4,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: "/client-fallback" },
      }],
    });
    await awaitBarrier(
      clientFallback.promise,
      "client builtin fallback",
      events,
    );
    for (const runtime of clientRuntimes) await runtime.settled();
    assertEquals(clientFallbackKinds, new Set(["fetch", "generate"]));
  } finally {
    resetMockMode();
    unsubscribeAccepted();
    for (const cancel of clientSinkCancels) cancel();
    for (const runtime of clientRuntimes) await runtime.dispose();
    for (const storage of clientStorages) await storage.close();
    await executor?.stop();
    await seedRuntime.dispose();
    await seedStorage.close();
    await observerClient?.close();
    await server.close();
  }
});
