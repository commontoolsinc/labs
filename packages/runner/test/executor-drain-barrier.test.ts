import { assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import type {
  ActionSettlement,
  BranchName,
  ClientCommit,
  ExecutionClaim,
  ExecutionLease,
  MemoryProtocolFlags,
  TransactRequest,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import {
  type ExecutionLeaseHandle,
  Server,
} from "@commonfabric/memory/v2/server";
import {
  DenoSpaceExecutorFactory,
} from "../src/executor/deno-space-executor.ts";
import {
  SharedExecutionPool,
  type SpaceExecutor,
  type SpaceExecutorFactory,
} from "../src/executor/shared-execution-pool.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";

const FLAGS = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: false,
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

class LoopbackSessionFactory implements SessionFactory {
  constructor(
    private readonly server: Server,
    private readonly flags: Partial<MemoryProtocolFlags>,
    private readonly onCommit?: (commit: ClientCommit) => void,
    private readonly onClient?: (client: MemoryClient.Client) => void,
    private readonly onSession?: (session: MemoryClient.SpaceSession) => void,
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
    this.onClient?.(client);
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
    this.onSession?.(session);
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
    onClient?: (client: MemoryClient.Client) => void,
    onSession?: (session: MemoryClient.SpaceSession) => void,
  ): LoopbackStorageManager {
    return new LoopbackStorageManager(
      { ...options, memoryHost: new URL("memory://executor-drain-barrier") },
      new LoopbackSessionFactory(
        server,
        flags,
        onCommit,
        onClient,
        onSession,
      ),
    );
  }
}

/** The pool calls begin-drain after its Worker settle barrier. Injecting before
 * the durable fence deterministically targets the settle-to-stop window; the
 * replacement generation must recover any work the old generation misses. */
class DrainWindowServer extends Server {
  onPoolBeginDrain: (() => Promise<void>) | undefined;
  outputId: string | undefined;
  outputAtFinish: unknown;

  override async beginExecutionLeaseDrain(
    lease: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null> {
    await this.onPoolBeginDrain?.();
    return await super.beginExecutionLeaseDrain(lease);
  }

  override async finishExecutionLeaseDrain(
    lease: ExecutionLeaseHandle,
  ): Promise<ExecutionLease | null> {
    this.outputAtFinish = this.outputId === undefined
      ? undefined
      : (await this.readDocument(lease.space, this.outputId) as
        | { value?: unknown }
        | null)?.value;
    return await super.finishExecutionLeaseDrain(lease);
  }
}

class ClaimedAttemptGateServer extends Server {
  #armed = false;
  #release = Promise.withResolvers<void>();
  #started = Promise.withResolvers<void>();
  #response = Promise.withResolvers<
    Awaited<ReturnType<Server["transact"]>>
  >();

  armClaimedAttempt(): {
    started: Promise<void>;
    release: () => void;
    response: Promise<Awaited<ReturnType<Server["transact"]>>>;
  } {
    this.#armed = true;
    this.#release = Promise.withResolvers<void>();
    this.#started = Promise.withResolvers<void>();
    this.#response = Promise.withResolvers<
      Awaited<ReturnType<Server["transact"]>>
    >();
    return {
      started: this.#started.promise,
      release: () => this.#release.resolve(),
      response: this.#response.promise,
    };
  }

  override async transact(message: TransactRequest) {
    if (this.#armed && hasExecutionClaimAssertion(message.commit)) {
      this.#armed = false;
      this.#started.resolve();
      await this.#release.promise;
      const response = await super.transact(message);
      this.#response.resolve(response);
      return response;
    }
    return await super.transact(message);
  }
}

const hasExecutionClaimAssertion = (commit: ClientCommit): boolean => {
  const observations = [
    commit.schedulerObservation,
    ...(commit.schedulerObservationBatch ?? []).map((entry) =>
      entry.schedulerObservation
    ),
  ];
  return observations.some((observation) =>
    typeof observation === "object" && observation !== null &&
    "executionClaimAssertion" in observation &&
    observation.executionClaimAssertion !== undefined
  );
};

const within = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          10_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

Deno.test("real executor recovers a source commit accepted between settle and terminate", async () => {
  const principal = await Identity.fromPassphrase(
    `executor drain barrier ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const server = new DrainWindowServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-executor-drain-barrier" },
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
  let pool: SharedExecutionPool | null = null;
  let unsubscribeAccepted = () => {};

  try {
    const compiled = await seedRuntime.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const tx = seedRuntime.edit();
    const input = seedRuntime.getCell<number>(
      space,
      "executor-drain-input",
      undefined,
      tx,
    );
    input.set(5);
    const result = seedRuntime.getCell<number>(
      space,
      "executor-drain-result",
      undefined,
      tx,
    );
    const handle = seedRuntime.run(tx, compiled, { value: input }, result);
    assertEquals((await tx.commit()).error, undefined);
    assertEquals(await handle.pull(), 10);
    await seedRuntime.settled();
    await seedRuntime.storageManager.synced();
    const pieceDocument = await server.readDocument(space, result.sourceURI) as
      & Record<string, unknown>
      & { value: { "/": { "link@1": { id: string } } } };
    const outputId = pieceDocument.value["/"]["link@1"].id;
    server.outputId = outputId;
    const initialOutput = Promise.withResolvers<void>();
    const recoveredOutput = Promise.withResolvers<void>();
    unsubscribeAccepted = server.subscribeAcceptedCommits(space, (event) => {
      if (!event.revisions.some((revision) => revision.id === outputId)) return;
      void server.readDocument(space, outputId).then((document) => {
        const value = (document as { value?: unknown } | null)?.value;
        if (value === 12) initialOutput.resolve();
        if (value === 14) recoveredOutput.resolve();
      });
    });
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
    await observer.watchSet([{
      id: "executor-drain-barrier-piece",
      kind: "graph",
      query: {
        roots: [{
          id: result.sourceURI,
          selector: { path: [], schema: true },
        }],
      },
    }]);

    const denoFactory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: new URL("https://toolshed.example/"),
      patternApiUrl: new URL("https://toolshed.example/"),
      protocolFlags: FLAGS,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
    });
    const executors: SpaceExecutor[] = [];
    const factory: SpaceExecutorFactory = {
      async start(options) {
        const executor = await denoFactory.start(options);
        executors.push(executor);
        return executor;
      },
    };
    pool = new SharedExecutionPool({ control: server, factory });
    pool.start();

    await observer.setExecutionDemand("" as BranchName, [result.sourceURI]);
    await pool.idle();
    await observer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: 6 },
      }],
    });
    await within(initialOutput.promise, "initial claimed executor output");
    await executors[0]!.settle();
    assertEquals(
      (await server.readDocument(space, outputId) as { value?: unknown })
        ?.value,
      12,
    );
    let sourceCommitSeq = 0;
    server.onPoolBeginDrain = async () => {
      const commit = await observer.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: input.sourceURI,
          value: { value: 7 },
        }],
      });
      sourceCommitSeq = commit.seq;
    };

    await observer.setExecutionDemand("", []);
    await pool.idle();

    assertEquals(sourceCommitSeq > 0, true);
    assertEquals(server.outputAtFinish, 12);
    await observer.setExecutionDemand("", [result.sourceURI]);
    await pool.idle();
    await within(recoveredOutput.promise, "cold-resume drain-window output");
    assertEquals(
      (await server.readDocument(space, outputId) as { value?: unknown })
        ?.value,
      14,
    );
    assertEquals(pool.snapshot(space, "")?.state, "live");
    assertEquals(pool.metrics().workersStarted, 2);
    assertEquals(pool.metrics().workersStopped, 1);
    assertEquals(pool.metrics().abruptStops, 0);
  } finally {
    unsubscribeAccepted();
    await pool?.close();
    await seedRuntime.dispose();
    await seedStorage.close();
    await observerClient?.close();
    await server.close();
  }
});

Deno.test("persistent host restart rehydrates one fenced replacement without duplicate output", async () => {
  const directory = await Deno.makeTempDir();
  const store = toFileUrl(`${directory}/`);
  const principal = await Identity.fromPassphrase(
    `executor host restart drill ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const startedAt = Date.now();
  const leaseTtlMs = 30_000;
  const authorizeSessionOpen = (message: { authorization?: unknown }) => {
    const value = (message.authorization as { principal?: unknown } | null)
      ?.principal;
    return typeof value === "string" ? value : undefined;
  };
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
  const createServer = (hostId: string, nowMs: number) =>
    new Server({
      store,
      authorizeSessionOpen,
      sessionOpenAuth: { audience: "did:key:z6Mk-executor-host-restart" },
      protocolFlags: FLAGS,
      acl: { mode: "off", serviceDids: [space] },
      executionControl: {
        hostId,
        leaseTtlMs,
        claimTtlMs: leaseTtlMs,
        nowMs: () => nowMs,
      },
    });
  const poolTimerOptions = () => {
    let nextTimer = 0;
    return {
      setTimer: (_callback: () => void, _delayMs: number) => ++nextTimer,
      clearTimer: (_timer: number) => {},
    };
  };

  const hostA = createServer("host:restart-a", startedAt);
  let serverA: Server | null = hostA;
  let seedStorage: LoopbackStorageManager | null = null;
  let seedRuntime: Runtime | null = null;
  let observerClientA: MemoryClient.Client | null = null;
  let clientStorageA: LoopbackStorageManager | null = null;
  let clientRuntimeA: Runtime | null = null;
  let executorA: SpaceExecutor | null = null;
  let serverB: Server | null = null;
  let observerClientB: MemoryClient.Client | null = null;
  let clientStorageB: LoopbackStorageManager | null = null;
  let clientRuntimeB: Runtime | null = null;
  let poolB: SharedExecutionPool | null = null;
  let unsubscribeAcceptedA = () => {};
  let unsubscribeControlA = () => {};
  let unsubscribeAcceptedB = () => {};
  let unsubscribeControlB = () => {};

  try {
    seedStorage = LoopbackStorageManager.connectTo(hostA, FLAGS, {
      as: principal,
    });
    seedRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: seedStorage,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
    });
    const compiled = await seedRuntime.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const tx = seedRuntime.edit();
    const input = seedRuntime.getCell<number>(
      space,
      "executor-host-restart-input",
      undefined,
      tx,
    );
    input.set(5);
    const result = seedRuntime.getCell<number>(
      space,
      "executor-host-restart-result",
      undefined,
      tx,
    );
    const resultLink = result.getAsNormalizedFullLink();
    const handle = seedRuntime.run(tx, compiled, { value: input }, result);
    assertEquals((await tx.commit()).error, undefined);
    assertEquals(await handle.pull(), 10);
    await seedRuntime.settled();
    await seedRuntime.storageManager.synced();
    const resultId = result.sourceURI;
    const inputId = input.sourceURI;
    const pieceDocumentA = await hostA.readDocument(space, resultId) as
      & Record<string, unknown>
      & { value: { "/": { "link@1": { id: string } } } };
    const outputId = pieceDocumentA.value["/"]["link@1"].id;
    await seedRuntime.dispose();
    seedRuntime = null;
    await seedStorage.close();
    seedStorage = null;

    observerClientA = await MemoryClient.connect({
      transport: MemoryClient.loopback(hostA),
      protocolFlags: FLAGS,
    });
    const observerA = await observerClientA.mount(space, {}, authorize);
    await observerA.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${space}:execution-policy`,
        value: { value: { version: 1, serverPrimaryExecution: true } },
      }],
    });
    await observerA.watchSet([{
      id: "executor-host-restart-piece-a",
      kind: "graph",
      query: {
        roots: [{ id: resultId, selector: { path: [], schema: true } }],
      },
    }]);

    let sessionA: MemoryClient.SpaceSession | null = null;
    clientStorageA = LoopbackStorageManager.connectTo(
      hostA,
      FLAGS,
      { as: principal },
      undefined,
      undefined,
      (session) => sessionA = session,
    );
    clientRuntimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientStorageA,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
    });
    await clientRuntimeA.patternManager.compilePattern(PROGRAM, { space });
    const resumedA = clientRuntimeA.getCellFromLink<number>(resultLink);
    await resumedA.sync();
    assertEquals(await clientRuntimeA.start(resumedA), true);
    await resumedA.pull();
    await clientRuntimeA.settled();

    const claimA = Promise.withResolvers<ExecutionClaim>();
    const settlementA = Promise.withResolvers<ActionSettlement>();
    unsubscribeControlA = observerA.subscribeExecutionControl((event) => {
      if (event.type === "session.execution.claim.set") {
        claimA.resolve(event.claim);
      } else if (event.type === "session.execution.settlement") {
        settlementA.resolve(event.settlement);
      }
    });
    const outputA = Promise.withResolvers<void>();
    let outputRevisionsA = 0;
    unsubscribeAcceptedA = hostA.subscribeAcceptedCommits(space, (event) => {
      if (!event.revisions.some((revision) => revision.id === outputId)) return;
      outputRevisionsA++;
      void hostA.readDocument(space, outputId).then((document) => {
        if ((document as { value?: unknown } | null)?.value === 12) {
          outputA.resolve();
        }
      });
    });

    const denoFactoryA = new DenoSpaceExecutorFactory({
      server: hostA,
      apiUrl: new URL("https://toolshed.example/"),
      patternApiUrl: new URL("https://toolshed.example/"),
      protocolFlags: FLAGS,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
    });
    const factoryA: SpaceExecutorFactory = {
      async start(options) {
        executorA = await denoFactoryA.start(options);
        return executorA;
      },
    };
    const poolA = new SharedExecutionPool({
      control: hostA,
      factory: factoryA,
      now: () => startedAt,
      ...poolTimerOptions(),
    });
    poolA.start();
    await sessionA!.setExecutionDemand("", [resultId]);
    await poolA.idle();
    const sourceA = await observerA.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: inputId, value: { value: 6 } }],
    });
    const firstClaim = await within(claimA.promise, "host A execution claim");
    await within(outputA.promise, "host A claimed output");
    const firstSettlement = await within(
      settlementA.promise,
      "host A claimed settlement",
    );
    assertEquals(firstSettlement.outcome, "committed");
    assertEquals(firstSettlement.inputBasisSeq >= sourceA.seq, true);
    assertEquals(outputRevisionsA, 1);
    const firstLease = await hostA.currentExecutionLease(space, "");
    assertEquals(firstLease?.hostId, "host:restart-a");
    assertEquals(firstLease?.leaseGeneration, firstClaim.leaseGeneration);
    assertEquals(firstLease?.onBehalfOf, space);

    // Model abrupt process loss: terminate process-local execution resources,
    // but deliberately leave the durable lease row for the next host to fence.
    const stoppedExecutorA = executorA as SpaceExecutor | null;
    if (stoppedExecutorA === null) throw new Error("missing host A executor");
    await stoppedExecutorA.stop({ abrupt: true });
    unsubscribeAcceptedA();
    unsubscribeAcceptedA = () => {};
    unsubscribeControlA();
    unsubscribeControlA = () => {};
    await hostA.close();
    serverA = null;
    await clientRuntimeA.dispose();
    clientRuntimeA = null;
    await clientStorageA.close();
    clientStorageA = null;
    await observerClientA.close();
    observerClientA = null;

    const restartedAt = startedAt + leaseTtlMs + 1;
    const hostB = createServer("host:restart-b", restartedAt);
    serverB = hostB;
    const pieceDocumentB = await hostB.readDocument(space, resultId) as
      & Record<string, unknown>
      & { value: { "/": { "link@1": { id: string } } } };
    assertEquals(pieceDocumentB.value["/"]["link@1"].id, outputId);
    assertEquals(
      (await hostB.readDocument(space, outputId) as { value?: unknown })?.value,
      12,
    );
    assertEquals(
      (await hostB.readDocument(
        space,
        `of:${space}:execution-policy`,
      ) as { value?: unknown })?.value,
      { version: 1, serverPrimaryExecution: true },
    );

    observerClientB = await MemoryClient.connect({
      transport: MemoryClient.loopback(hostB),
      protocolFlags: FLAGS,
    });
    const observerB = await observerClientB.mount(space, {}, authorize);
    await observerB.watchSet([{
      id: "executor-host-restart-piece-b",
      kind: "graph",
      query: {
        roots: [{ id: resultId, selector: { path: [], schema: true } }],
      },
    }]);
    const claimsB: ExecutionClaim[] = [];
    const settlementsB: ActionSettlement[] = [];
    const claimWaiters: Array<PromiseWithResolvers<ExecutionClaim>> = [];
    const settlementWaiters: Array<PromiseWithResolvers<ActionSettlement>> = [];
    unsubscribeControlB = observerB.subscribeExecutionControl((event) => {
      if (event.type === "session.execution.claim.set") {
        claimsB.push(event.claim);
        for (const waiter of claimWaiters) waiter.resolve(event.claim);
      } else if (event.type === "session.execution.settlement") {
        settlementsB.push(event.settlement);
        for (const waiter of settlementWaiters) {
          waiter.resolve(event.settlement);
        }
      }
    });
    const waitForClaimAfterGeneration = (
      leaseGeneration: number,
    ): Promise<ExecutionClaim> => {
      const existing = claimsB.find((claim) =>
        claim.leaseGeneration > leaseGeneration
      );
      if (existing !== undefined) return Promise.resolve(existing);
      const waiter = Promise.withResolvers<ExecutionClaim>();
      claimWaiters.push(waiter);
      return waiter.promise.then((claim) =>
        claim.leaseGeneration > leaseGeneration
          ? claim
          : waitForClaimAfterGeneration(leaseGeneration)
      );
    };
    const waitForSettlementAfter = (
      inputBasisSeq: number,
    ): Promise<ActionSettlement> => {
      const existing = settlementsB.find((settlement) =>
        settlement.inputBasisSeq >= inputBasisSeq
      );
      if (existing !== undefined) return Promise.resolve(existing);
      const waiter = Promise.withResolvers<ActionSettlement>();
      settlementWaiters.push(waiter);
      return waiter.promise.then((settlement) =>
        settlement.inputBasisSeq >= inputBasisSeq
          ? settlement
          : waitForSettlementAfter(inputBasisSeq)
      );
    };
    let countOutputRevisionsB = false;
    let outputRevisionsB = 0;
    const outputWaiters = new Map<number, PromiseWithResolvers<void>>();
    unsubscribeAcceptedB = hostB.subscribeAcceptedCommits(space, (event) => {
      if (!event.revisions.some((revision) => revision.id === outputId)) return;
      if (countOutputRevisionsB) outputRevisionsB++;
      void hostB.readDocument(space, outputId).then((document) => {
        const value = (document as { value?: unknown } | null)?.value;
        if (typeof value === "number") outputWaiters.get(value)?.resolve();
      });
    });
    const waitForOutput = (value: number): Promise<void> => {
      const waiter = Promise.withResolvers<void>();
      outputWaiters.set(value, waiter);
      return waiter.promise;
    };

    const executorStartsB: ExecutionLease[] = [];
    const denoFactoryB = new DenoSpaceExecutorFactory({
      server: hostB,
      apiUrl: new URL("https://toolshed.example/"),
      patternApiUrl: new URL("https://toolshed.example/"),
      protocolFlags: FLAGS,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
    });
    const factoryB: SpaceExecutorFactory = {
      async start(options) {
        executorStartsB.push(options.lease);
        return await denoFactoryB.start(options);
      },
    };
    poolB = new SharedExecutionPool({
      control: hostB,
      factory: factoryB,
      now: () => restartedAt,
      ...poolTimerOptions(),
    });
    poolB.start();

    let sessionB: MemoryClient.SpaceSession | null = null;
    const clientCommitsB: ClientCommit[] = [];
    clientStorageB = LoopbackStorageManager.connectTo(
      hostB,
      FLAGS,
      { as: principal },
      (commit) => clientCommitsB.push(commit),
      undefined,
      (session) => sessionB = session,
    );
    clientRuntimeB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientStorageB,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
    });
    await clientRuntimeB.patternManager.compilePattern(PROGRAM, { space });
    const resumedB = clientRuntimeB.getCellFromLink<number>(resultLink);
    await resumedB.sync();
    assertEquals(await clientRuntimeB.start(resumedB), true);
    assertEquals(await resumedB.pull(), 12);
    await clientRuntimeB.settled();
    assertEquals(outputRevisionsB, 0);
    assertEquals(
      (await hostB.readDocument(space, resultId) as {
        value: { "/": { "link@1": { id: string } } };
      }).value["/"]["link@1"].id,
      outputId,
    );
    await sessionB!.setExecutionDemand("", [resultId]);
    await poolB.idle();
    const replacementLease = await hostB.currentExecutionLease(space, "");
    assertEquals(replacementLease?.hostId, "host:restart-b");
    assertEquals(
      replacementLease?.leaseGeneration,
      firstClaim.leaseGeneration + 1,
    );
    assertEquals(replacementLease?.onBehalfOf, space);
    assertEquals(executorStartsB.length, 1);
    assertEquals(
      executorStartsB[0]?.leaseGeneration,
      firstClaim.leaseGeneration + 1,
    );

    const replacementClaimPending = waitForClaimAfterGeneration(
      firstClaim.leaseGeneration,
    );
    const coldOutput = waitForOutput(14);
    outputRevisionsB = 0;
    countOutputRevisionsB = true;
    const coldSource = await observerB.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: inputId, value: { value: 7 } }],
    });
    const replacementClaim = await within(
      replacementClaimPending,
      "host B replacement claim",
    );
    await within(coldOutput, "host B cold-rehydrated output");
    const coldSettlement = await within(
      waitForSettlementAfter(coldSource.seq),
      "host B cold-rehydrated settlement",
    );
    countOutputRevisionsB = false;
    assertEquals(
      replacementClaim.leaseGeneration,
      firstClaim.leaseGeneration + 1,
    );
    assertEquals(coldSettlement.outcome, "committed");
    assertEquals(outputRevisionsB, 1);

    const authoritativeOutput = waitForOutput(16);
    outputRevisionsB = 0;
    countOutputRevisionsB = true;
    clientCommitsB.length = 0;
    const authoritativeSource = await observerB.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: inputId, value: { value: 8 } }],
    });
    await within(authoritativeOutput, "host B authoritative output");
    const authoritativeSettlement = await within(
      waitForSettlementAfter(authoritativeSource.seq),
      "host B authoritative settlement",
    );
    countOutputRevisionsB = false;
    assertEquals(authoritativeSettlement.outcome, "committed");
    assertEquals(
      authoritativeSettlement.claim.leaseGeneration,
      replacementClaim.leaseGeneration,
    );
    assertEquals(outputRevisionsB, 1);
    assertEquals(
      clientCommitsB.some((commit) =>
        commit.operations.some((operation) =>
          operation.op !== "sqlite" && operation.id === outputId
        )
      ),
      false,
    );
    const snapshots = await observerB.listSchedulerActionSnapshots({
      actionId: replacementClaim.actionId,
      pieceId: replacementClaim.pieceId,
    });
    const provenance = snapshots.snapshots.at(-1)?.observation as {
      executionProvenance?: {
        onBehalfOf?: string;
        leaseGeneration?: number;
      };
    } | undefined;
    assertEquals(provenance?.executionProvenance?.onBehalfOf, space);
    assertEquals(
      provenance?.executionProvenance?.leaseGeneration,
      replacementClaim.leaseGeneration,
    );
    assertEquals(claimsB.length, 1);
    assertEquals(poolB.metrics().workersStarted, 1);
  } finally {
    unsubscribeAcceptedA();
    unsubscribeControlA();
    unsubscribeAcceptedB();
    unsubscribeControlB();
    await poolB?.close();
    await clientRuntimeB?.dispose();
    await clientStorageB?.close();
    await observerClientB?.close();
    await serverB?.close();
    const cleanupExecutorA = executorA as SpaceExecutor | null;
    if (cleanupExecutorA !== null) {
      await cleanupExecutorA.stop({ abrupt: true });
    }
    await clientRuntimeA?.dispose();
    await clientStorageA?.close();
    await observerClientA?.close();
    await seedRuntime?.dispose();
    await seedStorage?.close();
    await serverA?.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("real executor crash rejects stale work and converges once through client fallback and replacement", async () => {
  const principal = await Identity.fromPassphrase(
    `executor crash drill ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const server = new ClaimedAttemptGateServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-executor-crash-drill" },
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
  let clientStorage: LoopbackStorageManager | null = null;
  let clientRuntime: Runtime | null = null;
  let pool: SharedExecutionPool | null = null;
  let unsubscribeAccepted = () => {};
  let unsubscribeControl = () => {};

  try {
    const compiled = await seedRuntime.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const tx = seedRuntime.edit();
    const input = seedRuntime.getCell<number>(
      space,
      "executor-crash-input",
      undefined,
      tx,
    );
    input.set(5);
    const result = seedRuntime.getCell<number>(
      space,
      "executor-crash-result",
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
    await observer.watchSet([{
      id: "executor-crash-drill-piece",
      kind: "graph",
      query: {
        roots: [{
          id: result.sourceURI,
          selector: { path: [], schema: true },
        }],
      },
    }]);

    const clientCommits: ClientCommit[] = [];
    clientStorage = LoopbackStorageManager.connectTo(
      server,
      FLAGS,
      { as: principal },
      (commit) => clientCommits.push(commit),
    );
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientStorage,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
    });
    await clientRuntime.patternManager.compilePattern(PROGRAM, { space });
    const resumed = clientRuntime.getCellFromLink<number>(resultLink);
    await resumed.sync();
    assertEquals(await clientRuntime.start(resumed), true);
    await resumed.pull();
    await clientRuntime.settled();

    const claims: ExecutionClaim[] = [];
    const settlements: ActionSettlement[] = [];
    const claimWaiters: {
      predicate: (claim: ExecutionClaim) => boolean;
      resolve: (claim: ExecutionClaim) => void;
    }[] = [];
    const settlementWaiters: {
      predicate: (settlement: ActionSettlement) => boolean;
      resolve: (settlement: ActionSettlement) => void;
    }[] = [];
    const revoked = Promise.withResolvers<void>();
    let firstClaim: ExecutionClaim | undefined = undefined;
    unsubscribeControl = observer.subscribeExecutionControl((event) => {
      if (event.type === "session.execution.claim.set") {
        claims.push(event.claim);
        for (const waiter of [...claimWaiters]) {
          if (waiter.predicate(event.claim)) waiter.resolve(event.claim);
        }
      } else if (event.type === "session.execution.settlement") {
        settlements.push(event.settlement);
        for (const waiter of [...settlementWaiters]) {
          if (waiter.predicate(event.settlement)) {
            waiter.resolve(event.settlement);
          }
        }
      } else if (
        event.type === "session.execution.claim.revoke" &&
        firstClaim !== undefined &&
        event.leaseGeneration === firstClaim.leaseGeneration &&
        event.claimGeneration === firstClaim.claimGeneration
      ) {
        revoked.resolve();
      }
    });
    const waitForClaim = (
      predicate: (claim: ExecutionClaim) => boolean,
    ): Promise<ExecutionClaim> => {
      const existing = claims.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      const result = Promise.withResolvers<ExecutionClaim>();
      claimWaiters.push({ predicate, resolve: result.resolve });
      return result.promise;
    };
    const waitForSettlement = (
      predicate: (settlement: ActionSettlement) => boolean,
    ): Promise<ActionSettlement> => {
      const existing = settlements.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      const result = Promise.withResolvers<ActionSettlement>();
      settlementWaiters.push({ predicate, resolve: result.resolve });
      return result.promise;
    };

    const outputWaiters = new Map<number, PromiseWithResolvers<void>>();
    let countOutputRevisions = false;
    let countedOutputRevisions = 0;
    unsubscribeAccepted = server.subscribeAcceptedCommits(space, (event) => {
      if (!event.revisions.some((revision) => revision.id === outputId)) return;
      if (countOutputRevisions) countedOutputRevisions++;
      void server.readDocument(space, outputId).then((document) => {
        const value = (document as { value?: unknown } | null)?.value;
        if (typeof value === "number") outputWaiters.get(value)?.resolve();
      });
    });
    const waitForOutput = (value: number): Promise<void> => {
      const waiter = Promise.withResolvers<void>();
      outputWaiters.set(value, waiter);
      return waiter.promise;
    };

    const workers: Worker[] = [];
    const denoFactory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: new URL("https://toolshed.example/"),
      patternApiUrl: new URL("https://toolshed.example/"),
      protocolFlags: FLAGS,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
      createWorker: () => {
        const worker = new Worker(
          new URL("../src/executor/executor-worker.ts", import.meta.url).href,
          { type: "module", name: "executor-crash-drill" },
        );
        workers.push(worker);
        return worker;
      },
    });
    let nextTimer = 0;
    const timers = new Map<
      number,
      { callback: () => void; delayMs: number; cleared: boolean }
    >();
    pool = new SharedExecutionPool({
      control: server,
      factory: denoFactory,
      crashBackoffBaseMs: 17,
      crashBackoffMaxMs: 17,
      setTimer: (callback, delayMs) => {
        const timer = ++nextTimer;
        timers.set(timer, { callback, delayMs, cleared: false });
        return timer;
      },
      clearTimer: (timer) => {
        const record = timers.get(timer);
        if (record !== undefined) record.cleared = true;
      },
    });
    pool.start();
    await observer.setExecutionDemand("" as BranchName, [result.sourceURI]);
    await pool.idle();

    const initialClaim = waitForClaim(() => true);
    const baselineOutput = waitForOutput(12);
    const baselineSource = await observer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: 6 },
      }],
    });
    firstClaim = await within(initialClaim, "initial executor claim");
    await within(baselineOutput, "baseline claimed output");
    await within(
      waitForSettlement((settlement) =>
        settlement.claim.leaseGeneration === firstClaim!.leaseGeneration &&
        settlement.inputBasisSeq >= baselineSource.seq
      ),
      "baseline claimed settlement",
    );

    const gate = server.armClaimedAttempt();
    const fallbackOutput = waitForOutput(14);
    clientCommits.length = 0;
    countedOutputRevisions = 0;
    countOutputRevisions = true;
    await observer.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: 7 },
      }],
    });
    await within(gate.started, "gated stale claimed attempt");
    workers[0]!.dispatchEvent(
      new ErrorEvent("error", {
        message: "controlled executor crash",
        error: new Error("controlled executor crash"),
      }),
    );
    await within(revoked.promise, "crashed claim revoke");
    await pool.idle();
    assertEquals(pool.snapshot(space, "")?.state, "backoff");
    await resumed.pull();
    await clientRuntime.settled();
    await within(fallbackOutput, "client fail-open output");
    gate.release();
    const staleResponse = await within(
      gate.response,
      "stale executor rejection",
    );
    countOutputRevisions = false;

    assertEquals("error" in staleResponse, true);
    assertEquals(countedOutputRevisions, 1);
    const fallbackCommit = clientCommits.find((commit) =>
      commit.operations.some((operation) =>
        operation.op !== "sqlite" && operation.id === outputId
      )
    );
    assertEquals(fallbackCommit !== undefined, true);
    const fallbackObservation = fallbackCommit?.schedulerObservation as
      | { executionClaimAssertion?: unknown }
      | undefined;
    assertEquals(fallbackObservation?.executionClaimAssertion, undefined);
    const fallbackSnapshots = await observer.listSchedulerActionSnapshots({
      actionId: firstClaim.actionId,
      pieceId: firstClaim.pieceId,
    });
    const fallbackProvenance = fallbackSnapshots.snapshots.at(-1)
      ?.observation as
        | { executionProvenance?: unknown }
        | undefined;
    assertEquals(fallbackProvenance?.executionProvenance, undefined);

    const backoff = [...timers.values()].find((timer) =>
      !timer.cleared && timer.delayMs === 17
    );
    if (backoff === undefined) throw new Error("missing crash backoff timer");
    backoff.callback();
    await pool.idle();
    assertEquals(workers.length, 2);
    assertEquals(pool.snapshot(space, "")?.state, "live");
    const replacementClaimPending = waitForClaim((claim) =>
      claim.leaseGeneration > firstClaim!.leaseGeneration
    );
    const reacquisitionOutput = waitForOutput(16);
    countedOutputRevisions = 0;
    countOutputRevisions = true;
    await observer.transact({
      localSeq: 4,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: 8 },
      }],
    });
    const replacementClaim = await within(
      replacementClaimPending,
      "replacement executor claim",
    );
    await within(reacquisitionOutput, "replacement reacquisition output");
    await clientRuntime.settled();
    countOutputRevisions = false;
    assertEquals(countedOutputRevisions, 1);
    assertEquals(
      replacementClaim.leaseGeneration,
      firstClaim.leaseGeneration + 1,
    );

    const replacementOutput = waitForOutput(18);
    countedOutputRevisions = 0;
    countOutputRevisions = true;
    const replacementSource = await observer.transact({
      localSeq: 5,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: 9 },
      }],
    });
    await within(replacementOutput, "replacement executor output");
    const replacementSettlement = await within(
      waitForSettlement((settlement) =>
        settlement.claim.leaseGeneration ===
          replacementClaim.leaseGeneration &&
        settlement.inputBasisSeq >= replacementSource.seq
      ),
      "replacement executor settlement",
    );
    countOutputRevisions = false;
    assertEquals(replacementSettlement.outcome, "committed");
    assertEquals(countedOutputRevisions, 1);
    const replacementSnapshots = await observer.listSchedulerActionSnapshots({
      actionId: replacementClaim.actionId,
      pieceId: replacementClaim.pieceId,
    });
    const replacementProvenance = replacementSnapshots.snapshots.at(-1)
      ?.observation as {
        executionProvenance?: {
          onBehalfOf?: string;
          leaseGeneration?: number;
        };
      } | undefined;
    assertEquals(replacementProvenance?.executionProvenance?.onBehalfOf, space);
    assertEquals(
      replacementProvenance?.executionProvenance?.leaseGeneration,
      replacementClaim.leaseGeneration,
    );
    assertEquals(pool.metrics().crashes, 1);
    assertEquals(pool.metrics().abruptStops, 1);
  } finally {
    unsubscribeAccepted();
    unsubscribeControl();
    await pool?.close();
    await clientRuntime?.dispose();
    await clientStorage?.close();
    await seedRuntime.dispose();
    await seedStorage.close();
    await observerClient?.close();
    await server.close();
  }
});

Deno.test("real sponsor loss fences A and resumes exactly once on behalf of B", async () => {
  const owner = await Identity.fromPassphrase(
    `executor sponsor owner ${crypto.randomUUID()}`,
  );
  const writerA = await Identity.fromPassphrase(
    `executor sponsor A ${crypto.randomUUID()}`,
  );
  const writerB = await Identity.fromPassphrase(
    `executor sponsor B ${crypto.randomUUID()}`,
  );
  const space = owner.did();
  const server = new ClaimedAttemptGateServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-executor-sponsor-drill" },
    protocolFlags: FLAGS,
    acl: { mode: "enforce", serviceDids: [space] },
  });
  const ownerAuthorize: MemoryClient.SessionOpenAuthFactory = (
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
    as: owner,
  });
  const seedRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: seedStorage,
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
  });
  let ownerClient: MemoryClient.Client | null = null;
  let runtimeA: Runtime | null = null;
  let runtimeB: Runtime | null = null;
  let storageA: LoopbackStorageManager | null = null;
  let storageB: LoopbackStorageManager | null = null;
  let connectionA: MemoryClient.Client | null = null;
  let sessionA: MemoryClient.SpaceSession | null = null;
  let sessionB: MemoryClient.SpaceSession | null = null;
  let pool: SharedExecutionPool | null = null;
  let unsubscribeAccepted = () => {};
  let unsubscribeControl = () => {};
  let allowReplacementOnCleanup = () => {};

  try {
    ownerClient = await MemoryClient.connect({
      transport: MemoryClient.loopback(server),
      protocolFlags: FLAGS,
    });
    const observer = await ownerClient.mount(space, {}, ownerAuthorize);
    await observer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${space}`,
        value: {
          value: {
            [space]: "OWNER",
            [writerA.did()]: "WRITE",
            [writerB.did()]: "WRITE",
          },
        },
      }],
    });
    await observer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${space}:execution-policy`,
        value: { value: { version: 1, serverPrimaryExecution: true } },
      }],
    });

    const compiled = await seedRuntime.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const tx = seedRuntime.edit();
    const input = seedRuntime.getCell<number>(
      space,
      "executor-sponsor-input",
      undefined,
      tx,
    );
    input.set(5);
    const result = seedRuntime.getCell<number>(
      space,
      "executor-sponsor-result",
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
    await seedRuntime.dispose();
    await observer.watchSet([{
      id: "executor-sponsor-drill-piece",
      kind: "graph",
      query: {
        roots: [{
          id: result.sourceURI,
          selector: { path: [], schema: true },
        }],
      },
    }]);

    const claims: ExecutionClaim[] = [];
    const settlements: ActionSettlement[] = [];
    const claimWaiters: {
      predicate: (claim: ExecutionClaim) => boolean;
      resolve: (claim: ExecutionClaim) => void;
    }[] = [];
    const settlementWaiters: {
      predicate: (settlement: ActionSettlement) => boolean;
      resolve: (settlement: ActionSettlement) => void;
    }[] = [];
    const revoked = Promise.withResolvers<void>();
    let firstClaim: ExecutionClaim | undefined = undefined;
    unsubscribeControl = observer.subscribeExecutionControl((event) => {
      if (event.type === "session.execution.claim.set") {
        claims.push(event.claim);
        for (const waiter of [...claimWaiters]) {
          if (waiter.predicate(event.claim)) waiter.resolve(event.claim);
        }
      } else if (event.type === "session.execution.settlement") {
        settlements.push(event.settlement);
        for (const waiter of [...settlementWaiters]) {
          if (waiter.predicate(event.settlement)) {
            waiter.resolve(event.settlement);
          }
        }
      } else if (
        event.type === "session.execution.claim.revoke" &&
        firstClaim !== undefined &&
        event.leaseGeneration === firstClaim.leaseGeneration &&
        event.claimGeneration === firstClaim.claimGeneration
      ) {
        revoked.resolve();
      }
    });
    const waitForClaim = (
      predicate: (claim: ExecutionClaim) => boolean,
    ): Promise<ExecutionClaim> => {
      const existing = claims.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      const result = Promise.withResolvers<ExecutionClaim>();
      claimWaiters.push({ predicate, resolve: result.resolve });
      return result.promise;
    };
    const waitForSettlement = (
      predicate: (settlement: ActionSettlement) => boolean,
    ): Promise<ActionSettlement> => {
      const existing = settlements.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      const result = Promise.withResolvers<ActionSettlement>();
      settlementWaiters.push({ predicate, resolve: result.resolve });
      return result.promise;
    };
    const outputWaiters = new Map<number, PromiseWithResolvers<void>>();
    let countOutputRevisions = false;
    let countedOutputRevisions = 0;
    unsubscribeAccepted = server.subscribeAcceptedCommits(space, (event) => {
      if (!event.revisions.some((revision) => revision.id === outputId)) return;
      if (countOutputRevisions) countedOutputRevisions++;
      void server.readDocument(space, outputId).then((document) => {
        const value = (document as { value?: unknown } | null)?.value;
        if (typeof value === "number") outputWaiters.get(value)?.resolve();
      });
    });
    const waitForOutput = (value: number): Promise<void> => {
      const waiter = Promise.withResolvers<void>();
      outputWaiters.set(value, waiter);
      return waiter.promise;
    };

    const startSponsors: string[] = [];
    const replacementStart = Promise.withResolvers<void>();
    const allowReplacement = Promise.withResolvers<void>();
    allowReplacementOnCleanup = allowReplacement.resolve;
    const denoFactory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: new URL("https://toolshed.example/"),
      patternApiUrl: new URL("https://toolshed.example/"),
      protocolFlags: FLAGS,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
    });
    const factory: SpaceExecutorFactory = {
      async start(options) {
        startSponsors.push(options.lease.onBehalfOf);
        if (startSponsors.length > 1) {
          replacementStart.resolve();
          await allowReplacement.promise;
        }
        return await denoFactory.start(options);
      },
    };
    pool = new SharedExecutionPool({ control: server, factory });
    pool.start();

    const commitsB: ClientCommit[] = [];
    const startWriterRuntime = async (
      identity: Identity,
      onCommit?: (commit: ClientCommit) => void,
      onClient?: (client: MemoryClient.Client) => void,
      onSession?: (session: MemoryClient.SpaceSession) => void,
    ) => {
      const storage = LoopbackStorageManager.connectTo(
        server,
        FLAGS,
        { as: identity },
        onCommit,
        onClient,
        onSession,
      );
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        experimental: {
          persistentSchedulerState: true,
          serverPrimaryExecution: true,
        },
      });
      await runtime.patternManager.compilePattern(PROGRAM, { space });
      const resumed = runtime.getCellFromLink<number>(resultLink);
      await resumed.sync();
      assertEquals(await runtime.start(resumed), true);
      await resumed.pull();
      await runtime.settled();
      return { storage, runtime, resumed };
    };
    const clientA = await startWriterRuntime(
      writerA,
      undefined,
      (client) => connectionA = client,
      (session) => sessionA = session,
    );
    storageA = clientA.storage;
    runtimeA = clientA.runtime;
    await sessionA!.setExecutionDemand("", [result.sourceURI]);
    await pool.idle();
    const clientB = await startWriterRuntime(
      writerB,
      (commit) => commitsB.push(commit),
      undefined,
      (session) => sessionB = session,
    );
    storageB = clientB.storage;
    runtimeB = clientB.runtime;
    await sessionB!.setExecutionDemand("", [result.sourceURI]);
    await pool.idle();
    assertEquals(
      server.listExecutionDemands(space, "").map((demand) => demand.principal)
        .sort(),
      [writerA.did(), writerB.did()].sort(),
    );
    assertEquals(startSponsors, [writerA.did()]);

    const initialClaimPending = waitForClaim(() => true);
    const baselineOutput = waitForOutput(12);
    const baselineSource = await observer.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: 6 },
      }],
    });
    firstClaim = await within(initialClaimPending, "sponsor A claim");
    await within(baselineOutput, "sponsor A baseline output");
    await within(
      waitForSettlement((settlement) =>
        settlement.claim.leaseGeneration === firstClaim!.leaseGeneration &&
        settlement.inputBasisSeq >= baselineSource.seq
      ),
      "sponsor A baseline settlement",
    );
    const firstLease = await server.currentExecutionLease(space, "");
    assertEquals(firstLease?.onBehalfOf, writerA.did());

    const gate = server.armClaimedAttempt();
    const fallbackOutput = waitForOutput(14);
    commitsB.length = 0;
    countedOutputRevisions = 0;
    countOutputRevisions = true;
    await observer.transact({
      localSeq: 4,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: 7 },
      }],
    });
    await within(gate.started, "gated sponsor A attempt");
    await connectionA!.close();
    connectionA = null;
    await within(revoked.promise, "sponsor A claim revoke");
    await within(replacementStart.promise, "sponsor B replacement start");
    await clientB.resumed.pull();
    await runtimeB.settled();
    await within(fallbackOutput, "sponsor-loss client fallback");
    gate.release();
    const staleResponse = await within(
      gate.response,
      "stale sponsor A rejection",
    );
    countOutputRevisions = false;
    assertEquals("error" in staleResponse, true);
    assertEquals(countedOutputRevisions, 1);
    const fallbackCommit = commitsB.find((commit) =>
      commit.operations.some((operation) =>
        operation.op !== "sqlite" && operation.id === outputId
      )
    );
    assertEquals(fallbackCommit !== undefined, true);
    const fallbackObservation = fallbackCommit?.schedulerObservation as
      | { executionClaimAssertion?: unknown }
      | undefined;
    assertEquals(fallbackObservation?.executionClaimAssertion, undefined);
    const fallbackSnapshots = await observer.listSchedulerActionSnapshots({
      actionId: firstClaim.actionId,
      pieceId: firstClaim.pieceId,
    });
    const fallbackProvenance = fallbackSnapshots.snapshots.at(-1)
      ?.observation as { executionProvenance?: unknown } | undefined;
    assertEquals(fallbackProvenance?.executionProvenance, undefined);

    allowReplacement.resolve();
    await pool.idle();
    assertEquals(startSponsors, [writerA.did(), writerB.did()]);
    const replacementLease = await server.currentExecutionLease(space, "");
    assertEquals(replacementLease?.onBehalfOf, writerB.did());
    assertEquals(
      replacementLease?.leaseGeneration,
      firstClaim.leaseGeneration + 1,
    );

    const replacementClaimPending = waitForClaim((claim) =>
      claim.leaseGeneration > firstClaim!.leaseGeneration
    );
    const reacquisitionOutput = waitForOutput(16);
    countedOutputRevisions = 0;
    countOutputRevisions = true;
    await observer.transact({
      localSeq: 5,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: 8 },
      }],
    });
    const replacementClaim = await within(
      replacementClaimPending,
      "sponsor B replacement claim",
    );
    await within(reacquisitionOutput, "sponsor B reacquisition output");
    await runtimeB.settled();
    countOutputRevisions = false;
    assertEquals(countedOutputRevisions, 1);

    const authoritativeOutput = waitForOutput(18);
    countedOutputRevisions = 0;
    countOutputRevisions = true;
    const authoritativeSource = await observer.transact({
      localSeq: 6,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: 9 },
      }],
    });
    await within(authoritativeOutput, "sponsor B authoritative output");
    const authoritativeSettlement = await within(
      waitForSettlement((settlement) =>
        settlement.claim.leaseGeneration ===
          replacementClaim.leaseGeneration &&
        settlement.inputBasisSeq >= authoritativeSource.seq
      ),
      "sponsor B authoritative settlement",
    );
    countOutputRevisions = false;
    assertEquals(authoritativeSettlement.outcome, "committed");
    assertEquals(countedOutputRevisions, 1);
    const snapshots = await observer.listSchedulerActionSnapshots({
      actionId: replacementClaim.actionId,
      pieceId: replacementClaim.pieceId,
    });
    const provenance = snapshots.snapshots.at(-1)?.observation as {
      executionProvenance?: {
        onBehalfOf?: string;
        leaseGeneration?: number;
      };
    } | undefined;
    assertEquals(
      provenance?.executionProvenance?.onBehalfOf,
      writerB.did(),
    );
    assertEquals(
      provenance?.executionProvenance?.leaseGeneration,
      replacementClaim.leaseGeneration,
    );
    assertEquals(pool.metrics().sponsorRotations, 1);
    assertEquals(pool.metrics().leaseReplacements, 1);
  } finally {
    unsubscribeAccepted();
    unsubscribeControl();
    await (connectionA as MemoryClient.Client | null)?.close();
    allowReplacementOnCleanup();
    await pool?.close();
    await runtimeA?.dispose();
    await runtimeB?.dispose();
    await storageA?.close();
    await storageB?.close();
    await seedRuntime.dispose();
    await seedStorage.close();
    await ownerClient?.close();
    await server.close();
  }
});
