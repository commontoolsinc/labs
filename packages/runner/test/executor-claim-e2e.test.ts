import { assertEquals, assertExists } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import type {
  ActionSettlement,
  ClientCommit,
  ExecutionClaim,
  ExecutionControlEvent,
  MemoryProtocolFlags,
  TransactRequest,
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
import {
  type ExecutorExecutionMetricsSnapshot,
  SharedExecutionPool,
} from "../src/executor/shared-execution-pool.ts";
import {
  ServerBuiltinEgressError,
  type ServerBuiltinFetchRequest,
} from "../src/executor/server-builtin-egress.ts";

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

const NESTED_OUTPUT_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { pattern, computed } from 'commonfabric';",
      "export default pattern<{ value: number }>(({ value }) => ({",
      "  doubled: computed(() => (value as any) * 2),",
      "}));",
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

const DISTINCT_ASYNC_BUILTIN_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { pattern, fetchProgram, generateObject } from 'commonfabric';",
      "export default pattern<{ programUrl: string; prompt: string }>",
      "  (({ programUrl, prompt }) => ({",
      "    program: fetchProgram({ url: programUrl }),",
      "    object: generateObject<{ title: string }>({",
      "      prompt,",
      "      schema: {",
      "        type: 'object',",
      "        properties: { title: { type: 'string' } },",
      "        required: ['title'],",
      "      },",
      "    }),",
      "  }));",
    ].join("\n"),
  }],
};

const FETCH_BUILTIN_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { pattern, fetchText } from 'commonfabric';",
      "export default pattern<{ url: string }>(({ url }) => ({",
      "  fetched: fetchText({ url }),",
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

class RejectNextClaimedCommitServer extends Server {
  #rejectNextClaimedCommit = false;
  #delayNextUnclaimedCommitResponse = false;
  #releaseDelayedUnclaimedCommitResponse = Promise.withResolvers<void>();

  rejectNextClaimedCommit(): void {
    this.#rejectNextClaimedCommit = true;
  }

  delayNextUnclaimedCommitResponse(): void {
    this.#delayNextUnclaimedCommitResponse = true;
    this.#releaseDelayedUnclaimedCommitResponse = Promise.withResolvers<void>();
  }

  releaseDelayedUnclaimedCommitResponse(): void {
    this.#releaseDelayedUnclaimedCommitResponse.resolve();
  }

  override transact(
    message: TransactRequest,
  ): ReturnType<Server["transact"]> {
    if (
      this.#rejectNextClaimedCommit &&
      hasExecutionClaimAssertion(message.commit)
    ) {
      this.#rejectNextClaimedCommit = false;
      return Promise.resolve({
        type: "response",
        requestId: message.requestId,
        error: {
          name: "AuthorizationError",
          message: "injected claimed rerun rejection",
        },
      });
    }
    const response = super.transact(message);
    if (
      this.#delayNextUnclaimedCommitResponse &&
      !hasExecutionClaimAssertion(message.commit)
    ) {
      this.#delayNextUnclaimedCommitResponse = false;
      return response.then(async (value) => {
        await this.#releaseDelayedUnclaimedCommitResponse.promise;
        return value;
      });
    }
    return response;
  }
}

class GatedSchedulerListServer extends Server {
  schedulerListStarted = Promise.withResolvers<void>();
  releaseSchedulerList = Promise.withResolvers<void>();
  #gateNextSchedulerList = false;

  gateNextSchedulerList(): void {
    this.schedulerListStarted = Promise.withResolvers<void>();
    this.releaseSchedulerList = Promise.withResolvers<void>();
    this.#gateNextSchedulerList = true;
  }

  override async listSchedulerActionSnapshots(
    message: Parameters<Server["listSchedulerActionSnapshots"]>[0],
  ): ReturnType<Server["listSchedulerActionSnapshots"]> {
    if (this.#gateNextSchedulerList) {
      this.#gateNextSchedulerList = false;
      this.schedulerListStarted.resolve();
      await this.releaseSchedulerList.promise;
    }
    return await super.listSchedulerActionSnapshots(message);
  }
}

async function exercisePoolDemandRestart(
  options: {
    nestedRoot?: boolean;
    replaceShadowWorker?: boolean;
    sameWindowRemoteObservation?: boolean;
    initialCleanSnapshotRace?: boolean;
    initialCleanSnapshotClaim?: boolean;
  } = {},
): Promise<void> {
  const principal = await Identity.fromPassphrase(
    `executor pool transition ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  let executionNow = Date.now();
  const executionLeaseTtlMs = 30_000;
  const server = new GatedSchedulerListServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-executor-pool-transition" },
    protocolFlags: FLAGS,
    acl: { mode: "off", serviceDids: [space] },
    executionControl: {
      leaseTtlMs: executionLeaseTtlMs,
      claimTtlMs: executionLeaseTtlMs,
      nowMs: () => executionNow,
    },
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
  const clientCommits: ClientCommit[] = [];
  const seedStorage = LoopbackStorageManager.connectTo(
    server,
    FLAGS,
    { as: principal },
    (commit) => clientCommits.push(commit),
  );
  const seedRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: seedStorage,
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
  });
  let observerClient: MemoryClient.Client | null = null;
  const raceObserverClients: MemoryClient.Client[] = [];
  let clientStorage: LoopbackStorageManager | null = null;
  let clientRuntime: Runtime | null = null;
  let coldStorage: LoopbackStorageManager | null = null;
  let coldRuntime: Runtime | null = null;
  let pool: SharedExecutionPool | null = null;
  let unsubscribeControl = () => {};
  let cancelWarmSink = () => {};
  let seedRuntimeDisposed = false;
  let seedStorageClosed = false;
  const acceptedEvents: string[] = [];

  try {
    const program = options.nestedRoot === true
      ? NESTED_OUTPUT_PROGRAM
      : PROGRAM;
    const compiled = await seedRuntime.patternManager.compilePattern(program, {
      space,
    });
    const seedTx = seedRuntime.edit();
    const input = seedRuntime.getCell<number>(
      space,
      "executor-pool-transition-input",
      undefined,
      seedTx,
    );
    input.set(5);
    const result = seedRuntime.getCell<number>(
      space,
      "executor-pool-transition-result",
      undefined,
      seedTx,
    );
    const stableInputId = input.sourceURI;
    const stableInputLink = input.getAsNormalizedFullLink();
    const stableResultId = result.sourceURI;
    const stableResultLink = result.getAsNormalizedFullLink();
    const seedHandle = seedRuntime.run(
      seedTx,
      compiled,
      { value: input },
      result,
    );
    assertEquals((await seedTx.commit()).error, undefined);
    const seedVisibleResult = options.nestedRoot === true
      ? seedHandle.key("doubled")
      : seedHandle;
    assertEquals(await seedVisibleResult.pull() as unknown, 10);
    await seedRuntime.settled();
    await seedRuntime.storageManager.synced();
    const seedPieceDocument = await server.readDocument(
      space,
      stableResultId,
    ) as
      & Record<string, unknown>
      & { value: { "/": { "link@1": { id: string } } } };
    const stableOutputId = options.nestedRoot === true
      ? seedHandle.key("doubled").resolveAsCell().getAsNormalizedFullLink().id
      : seedPieceDocument.value["/"]["link@1"].id;
    if (options.nestedRoot === true) {
      assertEquals(
        containsStoredValue(seedPieceDocument, stableOutputId),
        true,
      );
    }
    assertEquals(
      (await server.readDocument(space, stableOutputId) as { value?: unknown })
        ?.value,
      10,
    );
    observerClient = await MemoryClient.connect({
      transport: MemoryClient.loopback(server),
      protocolFlags: FLAGS,
    });
    const observer = await observerClient.mount(space, {
      sessionId: `session:pool-transition-observer:${crypto.randomUUID()}`,
    }, authorize);
    let raceObserver: typeof observer | undefined;
    let raceObserverLocalSeq = 0;
    const getRaceObserver = async (): Promise<typeof observer> => {
      if (raceObserver !== undefined) return raceObserver;
      const client = await MemoryClient.connect({
        transport: MemoryClient.loopback(server),
        protocolFlags: FLAGS,
      });
      raceObserverClients.push(client);
      raceObserver = await client.mount(space, {
        sessionId: `session:pool-transition-race:${crypto.randomUUID()}`,
      }, authorize);
      return raceObserver;
    };
    await observer.watchSet([{
      id: "executor-pool-transition-piece",
      kind: "graph",
      query: {
        roots: [{
          id: stableResultId,
          selector: { path: [], schema: true },
        }],
      },
    }]);

    const controlEvents: ExecutionControlEvent[] = [];
    const controlListeners = new Set<
      (event: ExecutionControlEvent) => void
    >();
    unsubscribeControl = observer.subscribeExecutionControl((event) => {
      controlEvents.push(event);
      acceptedEvents.push(event.type);
      for (const listener of controlListeners) listener(event);
    });
    const waitForControl = async <T extends ExecutionControlEvent>(
      predicate: (event: ExecutionControlEvent) => event is T,
      name: string,
    ): Promise<T> => {
      const existing = controlEvents.find(predicate);
      if (existing !== undefined) return existing;
      const found = Promise.withResolvers<T>();
      const listener = (event: ExecutionControlEvent) => {
        if (predicate(event)) found.resolve(event);
      };
      controlListeners.add(listener);
      try {
        return await awaitBarrier(found.promise, name, acceptedEvents);
      } finally {
        controlListeners.delete(listener);
      }
    };

    let candidateActionId: string | undefined;
    const factory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: new URL("https://toolshed.example/"),
      patternApiUrl: new URL("https://toolshed.example/"),
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
      onCandidateClaim(candidate) {
        candidateActionId = candidate.claimKey.actionId;
        acceptedEvents.push(`candidate:${candidate.claimKey.actionId}`);
      },
      onCandidateDiagnostic(diagnostic) {
        acceptedEvents.push(`diagnostic:${diagnostic.diagnosticCode}`);
      },
      now: () => executionNow,
    });
    pool = new SharedExecutionPool({
      control: server,
      factory,
      settleTimeoutMs: 10_000,
      now: () => executionNow,
    });
    pool.start();
    await observer.setExecutionDemand("", [stableResultId]);
    await pool.idle();
    assertEquals(pool.snapshot(space, ""), {
      state: "live",
      referenceCount: 1,
      pieces: [stableResultId],
      leaseGeneration: 1,
    });
    assertEquals(pool.metrics().workersStarted, 1);

    // Keep the creator runtime warm as the client. Its action has already run
    // and is subscribed, exactly like a browser that was open before the
    // server shadow pool started; the final phase still proves a cold resume.
    clientStorage = seedStorage;
    clientRuntime = seedRuntime;
    const visibleRoot = seedRuntime.getCellFromLink(stableResultLink);
    assertEquals(visibleRoot.sourceURI, stableResultId);
    const visibleResult = options.nestedRoot === true
      ? visibleRoot.key("doubled")
      : visibleRoot;
    cancelWarmSink = visibleResult.sink(() => {});
    await seedRuntime.settled();
    const initialObservationTemplate = clientCommits.find((commit) => {
      const observation = commit.schedulerObservation as {
        actionKind?: string;
      } | undefined;
      return observation?.actionKind === "computation" &&
        commit.operations.length > 0;
    });
    clientCommits.length = 0;

    let observerLocalSeq = 0;
    const assertStableIdentity = async (): Promise<void> => {
      assertEquals(input.sourceURI, stableInputId);
      assertEquals(input.getAsNormalizedFullLink(), stableInputLink);
      assertEquals(result.sourceURI, stableResultId);
      assertEquals(result.getAsNormalizedFullLink(), stableResultLink);
      const pieceDocument = await server.readDocument(space, stableResultId) as
        & Record<string, unknown>
        & { value: { "/": { "link@1": { id: string } } } };
      if (options.nestedRoot === true) {
        assertEquals(containsStoredValue(pieceDocument, stableOutputId), true);
      } else {
        assertEquals(pieceDocument.value["/"]["link@1"].id, stableOutputId);
      }
    };
    const runSource = async (
      value: number,
      settleClient = true,
    ): Promise<number> => {
      const outputAccepted = Promise.withResolvers<void>();
      const unsubscribeAccepted = server.subscribeAcceptedCommits(
        space,
        (event) => {
          acceptedEvents.push(
            `accepted:${
              event.revisions.map((revision) => revision.id).join(",")
            }:stale=${
              event.staleDemandedReaders.map((reader) => reader.pieceId).join(
                ",",
              )
            }`,
          );
          if (
            event.revisions.some((revision) => revision.id === stableOutputId)
          ) {
            outputAccepted.resolve();
          }
        },
      );
      let sourceSeq = 0;
      try {
        const source = await observer.transact({
          localSeq: ++observerLocalSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: stableInputId,
            value: { value },
          }],
        });
        sourceSeq = source.seq;
        if (settleClient) {
          await clientStorage!.synced();
          await visibleResult.pull();
          await clientRuntime!.settled();
        }
        await awaitBarrier(
          outputAccepted.promise,
          `pool transition output ${value}`,
          acceptedEvents,
        );
      } finally {
        unsubscribeAccepted();
      }
      if (settleClient) {
        await clientStorage!.synced();
        assertEquals(await visibleResult.pull() as unknown, value * 2);
        await clientRuntime!.settled();
      }
      assertEquals(
        (await server.readDocument(space, stableOutputId) as {
          value?: unknown;
        })?.value,
        value * 2,
      );
      await assertStableIdentity();
      return sourceSeq;
    };
    const isDerivedWireCommit = (commit: ClientCommit): boolean => {
      const observation = commit.schedulerObservation as {
        actionId?: string;
        actionKind?: string;
      } | undefined;
      return observation?.actionId === candidateActionId &&
        observation?.actionKind === "computation" &&
        commit.operations.length > 0;
    };
    const runRemoteObservedSource = async (
      value: number,
      template: ClientCommit,
      verifyClient = true,
      sourceSession = observer,
    ): Promise<number> => {
      assertExists(template.schedulerObservation);
      const outputAccepted = Promise.withResolvers<void>();
      const unsubscribeAccepted = server.subscribeAcceptedCommits(
        space,
        (event) => {
          acceptedEvents.push(
            `accepted-remote:${
              event.revisions.map((revision) => revision.id).join(",")
            }`,
          );
          if (
            event.revisions.some((revision) => revision.id === stableOutputId)
          ) {
            outputAccepted.resolve();
          }
        },
      );
      try {
        const source = await sourceSession.transact({
          localSeq: sourceSession === observer
            ? ++observerLocalSeq
            : ++raceObserverLocalSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: stableInputId,
            value: { value },
          }, {
            op: "set",
            id: stableOutputId,
            value: { value: value * 2 },
          }],
          schedulerObservation: structuredClone(
            template.schedulerObservation,
          ),
        });
        assertEquals(
          source.schedulerObservationResults?.some((result) =>
            result.status === "kept"
          ),
          true,
        );
        assertEquals(
          source.schedulerDirtiedReaders?.some((reader) =>
            reader.actionId === candidateActionId
          ),
          true,
        );
        await awaitBarrier(
          outputAccepted.promise,
          `pool transition remote-observed output ${value}`,
          acceptedEvents,
        );
        if (verifyClient) {
          await clientStorage!.synced();
          await visibleResult.pull();
          await clientRuntime!.settled();
          assertEquals(await visibleResult.pull() as unknown, value * 2);
        }
        assertEquals(
          (await server.readDocument(space, stableOutputId) as {
            value?: unknown;
          })?.value,
          value * 2,
        );
        await assertStableIdentity();
        return source.seq;
      } finally {
        unsubscribeAccepted();
      }
    };
    const loggerCount = (key: string): number => {
      const value = getLoggerCountsBreakdown()["storage.v2"]?.[key];
      if (typeof value === "number") return value;
      return value?.debug ?? value?.total ?? 0;
    };

    // With server-primary execution enabled, the first invalidation promotes
    // the discovered computation directly to an exact server claim.
    clientCommits.length = 0;
    const initialSourceSeq = await runSource(6, false);
    assertExists(candidateActionId);
    const initialClaimEvent = await waitForControl(
      (event): event is Extract<
        ExecutionControlEvent,
        { type: "session.execution.claim.set" }
      > =>
        event.type === "session.execution.claim.set" &&
        event.claim.actionId === candidateActionId &&
        event.claim.leaseGeneration === 1,
      "initial server-primary claim",
    );
    await waitForControl(
      (event): event is Extract<
        ExecutionControlEvent,
        { type: "session.execution.settlement" }
      > =>
        event.type === "session.execution.settlement" &&
        event.settlement.claim.claimGeneration ===
          initialClaimEvent.claim.claimGeneration &&
        event.settlement.inputBasisSeq >= initialSourceSeq,
      "initial server-primary settlement",
    );
    await clientStorage.synced();
    await visibleResult.pull();
    await clientRuntime.settled();
    assertEquals(server.listExecutionClaims(space), [initialClaimEvent.claim]);
    const remoteObservationTemplate =
      options.sameWindowRemoteObservation || options.initialCleanSnapshotRace
        ? initialObservationTemplate
        : undefined;
    if (
      options.sameWindowRemoteObservation || options.initialCleanSnapshotRace
    ) {
      assertExists(remoteObservationTemplate);
    }

    if (
      options.initialCleanSnapshotRace || options.initialCleanSnapshotClaim
    ) {
      // Removing and restoring the active demand restarts the executor on a
      // clean snapshot. The replacement must rediscover its exact claim
      // without replaying effects or builtins.
      const sourceSession = options.initialCleanSnapshotRace
        ? await getRaceObserver()
        : observer;
      await observer.setExecutionDemand("", []);
      await pool.idle();
      assertEquals(pool.snapshot(space, ""), undefined);
      if (options.initialCleanSnapshotRace) server.gateNextSchedulerList();
      const restore = observer.setExecutionDemand("", [stableResultId]);
      let racedSourceSeq: number | undefined;
      if (options.initialCleanSnapshotRace) {
        await server.schedulerListStarted.promise;
        racedSourceSeq = await runRemoteObservedSource(
          7,
          remoteObservationTemplate!,
          false,
          sourceSession,
        );
        server.releaseSchedulerList.resolve();
      }
      await restore;
      await pool.idle();
      assertEquals(pool.snapshot(space, ""), {
        state: "live",
        referenceCount: 1,
        pieces: [stableResultId],
        leaseGeneration: 2,
      });
      assertEquals(pool.metrics().leaseLosses, 0);
      assertEquals(pool.metrics().leaseReplacements, 0);
      assertEquals(pool.metrics().workersStarted, 2);

      if (options.initialCleanSnapshotClaim) {
        const cleanResumeClaim = await waitForControl(
          (event): event is Extract<
            ExecutionControlEvent,
            { type: "session.execution.claim.set" }
          > =>
            event.type === "session.execution.claim.set" &&
            event.claim.actionId === candidateActionId &&
            event.claim.leaseGeneration === 2,
          "initial clean snapshot claim discovery",
        );
        const cleanResumeSettlement = await waitForControl(
          (event): event is Extract<
            ExecutionControlEvent,
            { type: "session.execution.settlement" }
          > =>
            event.type === "session.execution.settlement" &&
            event.settlement.claim.claimGeneration ===
              cleanResumeClaim.claim.claimGeneration &&
            event.settlement.inputBasisSeq >= initialSourceSeq,
          "initial clean snapshot settlement",
        );
        assertEquals(cleanResumeClaim.claim.claimGeneration, 1);
        assertEquals(server.listExecutionClaims(space), [
          cleanResumeClaim.claim,
        ]);
        assertEquals(
          cleanResumeSettlement.settlement.outcome === "committed" ||
            cleanResumeSettlement.settlement.outcome === "no-op",
          true,
        );
        assertEquals(
          (await server.readDocument(space, stableOutputId) as {
            value?: unknown;
          })?.value,
          12,
        );
        return;
      }

      assertExists(racedSourceSeq);
      const racedClaim = await waitForControl(
        (event): event is Extract<
          ExecutionControlEvent,
          { type: "session.execution.claim.set" }
        > =>
          event.type === "session.execution.claim.set" &&
          event.claim.actionId === candidateActionId &&
          event.claim.leaseGeneration === 2,
        "initial clean snapshot replacement claim",
      );
      await waitForControl(
        (event): event is Extract<
          ExecutionControlEvent,
          { type: "session.execution.settlement" }
        > =>
          event.type === "session.execution.settlement" &&
          event.settlement.claim.claimGeneration ===
            racedClaim.claim.claimGeneration &&
          event.settlement.inputBasisSeq >= racedSourceSeq,
        "initial clean snapshot replacement settlement",
      );
      return;
    }

    if (options.replaceShadowWorker === true) {
      // Preserve a separate replacement case: generation 1 has discovered
      // and claimed the writer, then expires before the demand is refreshed.
      executionNow += executionLeaseTtlMs + 1;
      await observer.setExecutionDemand("", [stableResultId]);
      await pool.idle();
      assertEquals(pool.snapshot(space, ""), {
        state: "live",
        referenceCount: 1,
        pieces: [stableResultId],
        leaseGeneration: 2,
      });
      assertEquals(pool.metrics().leaseLosses, 2);
      assertEquals(pool.metrics().leaseReplacements, 1);
      assertEquals(pool.metrics().workersStarted, 2);
    }

    // Clear and restore demand to fence the current generation and start one
    // clean replacement. No piece or document is recreated.
    const workersBeforeRestart = pool.metrics().workersStarted;
    const leaseGenerationBeforeRestart = pool.snapshot(space, "")
      ?.leaseGeneration;
    assertExists(leaseGenerationBeforeRestart);
    await observer.setExecutionDemand("", []);
    await pool.idle();
    assertEquals(pool.snapshot(space, ""), undefined);
    await observer.setExecutionDemand("", [stableResultId]);
    await pool.idle();
    assertEquals(pool.snapshot(space, ""), {
      state: "live",
      referenceCount: 1,
      pieces: [stableResultId],
      leaseGeneration: leaseGenerationBeforeRestart + 1,
    });
    assertEquals(pool.metrics().workersStarted, workersBeforeRestart + 1);
    clientCommits.length = 0;
    const restartedSeq = await runSource(7, false);
    const claimEvent = await waitForControl(
      (event): event is Extract<
        ExecutionControlEvent,
        { type: "session.execution.claim.set" }
      > =>
        event.type === "session.execution.claim.set" &&
        event.claim.actionId === candidateActionId &&
        event.claim.leaseGeneration === leaseGenerationBeforeRestart + 1,
      "restarted executor claim",
    );
    const claim = claimEvent.claim;
    await waitForControl(
      (event): event is Extract<
        ExecutionControlEvent,
        { type: "session.execution.settlement" }
      > =>
        event.type === "session.execution.settlement" &&
        event.settlement.claim.actionId === claim.actionId &&
        event.settlement.claim.claimGeneration === claim.claimGeneration &&
        event.settlement.inputBasisSeq >= restartedSeq,
      "restarted executor settlement",
    );
    await clientStorage.synced();
    await visibleResult.pull();
    await clientRuntime.settled();
    assertEquals(await visibleResult.pull() as unknown, 14);
    assertEquals(server.listExecutionClaims(space), [claim]);

    // A subsequent invalidation measures the stable claimed posture: only the
    // server writes, any client speculation is local and settles away.
    const overlaysCreatedBefore = loggerCount("execution-overlay-created");
    const overlaysDroppedBefore = loggerCount("execution-overlay-dropped");
    const settlementsBefore = server.executionStats.settlementsPublished;
    clientCommits.length = 0;
    const claimedSeq = await runSource(8, false);
    const claimedSettlement = await waitForControl(
      (event): event is Extract<
        ExecutionControlEvent,
        { type: "session.execution.settlement" }
      > =>
        event.type === "session.execution.settlement" &&
        event.settlement.claim.claimGeneration === claim.claimGeneration &&
        event.settlement.inputBasisSeq >= claimedSeq,
      "pool transition claimed settlement",
    );
    assertEquals(
      claimedSettlement.settlement.outcome === "committed" ||
        claimedSettlement.settlement.outcome === "no-op",
      true,
    );
    const snapshots = await observer.listSchedulerActionSnapshots({
      actionId: claim.actionId,
      pieceId: claim.pieceId,
    });
    const acceptedObservation = snapshots.snapshots.find((snapshot) => {
      const observation = snapshot.observation as {
        executionProvenance?: {
          leaseGeneration?: number;
          claimGeneration?: number;
        };
      };
      return snapshot.executionContextKey === claim.contextKey &&
        observation.executionProvenance?.leaseGeneration ===
          claim.leaseGeneration &&
        observation.executionProvenance?.claimGeneration ===
          claim.claimGeneration;
    })?.observation as {
      executionProvenance?: { onBehalfOf?: string };
    } | undefined;
    assertExists(
      acceptedObservation,
      `missing claimed snapshot: ${JSON.stringify(snapshots.snapshots)}`,
    );
    assertEquals(acceptedObservation.executionProvenance?.onBehalfOf, space);
    await clientStorage.synced();
    await visibleResult.pull();
    await clientRuntime.settled();
    assertEquals(await visibleResult.pull() as unknown, 16);
    assertEquals(clientCommits.some(isDerivedWireCommit), false);
    assertEquals(
      server.executionStats.settlementsPublished > settlementsBefore,
      true,
    );
    const overlaysCreated = loggerCount("execution-overlay-created") -
      overlaysCreatedBefore;

    // Dropping the last demand revokes the exact claim and fences the Worker.
    // While nothing is pulling the piece, the warm client is the fallback.
    const workersBeforeClear = pool.metrics().workersStarted;
    const leaseGenerationBeforeClear = pool.snapshot(space, "")
      ?.leaseGeneration;
    assertExists(leaseGenerationBeforeClear);
    await observer.setExecutionDemand("", []);
    await pool.idle();
    await waitForControl(
      (event): event is Extract<
        ExecutionControlEvent,
        { type: "session.execution.claim.revoke" }
      > =>
        event.type === "session.execution.claim.revoke" &&
        event.claim.actionId === claim.actionId &&
        event.leaseGeneration === claim.leaseGeneration &&
        event.claimGeneration === claim.claimGeneration,
      "demand-clear claim revoke",
    );
    await clientStorage.synced();
    await clientRuntime.settled();
    assertEquals(server.listExecutionClaims(space), []);
    assertEquals(pool.snapshot(space, ""), undefined);
    assertEquals(pool.metrics().workersStarted, workersBeforeClear);
    assertEquals(pool.metrics().crashes, 0);
    const overlaysDropped = loggerCount("execution-overlay-dropped") -
      overlaysDroppedBefore;
    assertEquals(overlaysDropped >= overlaysCreated, true);
    const overlayCountAfterClear = loggerCount("execution-overlay-created");
    clientCommits.length = 0;
    // Keep the replacement clean in the observation-adoption regression. A
    // fallback run here would change the snapshot before the remote
    // observation arrives and turn the race into a false green.
    if (remoteObservationTemplate === undefined) {
      await runSource(9);
      assertEquals(clientCommits.some(isDerivedWireCommit), true);
    }
    assertEquals(
      loggerCount("execution-overlay-created"),
      overlayCountAfterClear,
    );
    assertEquals(server.listExecutionClaims(space), []);
    assertEquals(pool.metrics().crashes, 0);

    // Restoring demand starts the next authoritative generation. For the
    // remote-observation race, hold replacement rehydration while the client
    // commit lands so startup must prove the computation before adopting it.
    const workersBeforeRestore = pool.metrics().workersStarted;
    if (remoteObservationTemplate !== undefined) {
      server.gateNextSchedulerList();
    }
    const sourceSession = remoteObservationTemplate === undefined
      ? observer
      : await getRaceObserver();
    clientCommits.length = 0;
    const restore = observer.setExecutionDemand("", [stableResultId]);
    let reclaimSeq: number;
    if (remoteObservationTemplate === undefined) {
      await restore;
      reclaimSeq = await runSource(10);
    } else {
      await server.schedulerListStarted.promise;
      reclaimSeq = await runRemoteObservedSource(
        10,
        remoteObservationTemplate,
        false,
        sourceSession,
      );
      server.releaseSchedulerList.resolve();
      await restore;
      await clientStorage.synced();
      await input.pull();
      await visibleResult.pull();
      await clientRuntime.settled();
      assertEquals(await visibleResult.pull() as unknown, 20);
    }
    await pool.idle();
    assertEquals(pool.snapshot(space, ""), {
      state: "live",
      referenceCount: 1,
      pieces: [stableResultId],
      leaseGeneration: leaseGenerationBeforeClear + 1,
    });
    assertEquals(pool.metrics().workersStarted, workersBeforeRestore + 1);
    const reclaimEvent = await waitForControl(
      (event): event is Extract<
        ExecutionControlEvent,
        { type: "session.execution.claim.set" }
      > =>
        event.type === "session.execution.claim.set" &&
        event.claim.actionId === claim.actionId &&
        event.claim.leaseGeneration === leaseGenerationBeforeClear + 1,
      "demand-restore replacement claim",
    );
    const reclaimed = reclaimEvent.claim;
    await waitForControl(
      (event): event is Extract<
        ExecutionControlEvent,
        { type: "session.execution.settlement" }
      > =>
        event.type === "session.execution.settlement" &&
        event.settlement.claim.leaseGeneration ===
          reclaimed.leaseGeneration &&
        event.settlement.claim.claimGeneration ===
          reclaimed.claimGeneration &&
        event.settlement.inputBasisSeq >= reclaimSeq,
      "pool transition replacement settlement",
    );
    assertEquals(
      reclaimed.leaseGeneration,
      leaseGenerationBeforeClear + 1,
    );
    assertEquals(server.listExecutionClaims(space), [reclaimed]);
    clientCommits.length = 0;
    await runSource(11);
    assertEquals(clientCommits.some(isDerivedWireCommit), false);
    assertEquals(pool.metrics().crashes, 0);

    // Close every warm executor/runtime, then resume through a fresh client
    // realm. Durable state alone must name the same cells and converge.
    await observer.setExecutionDemand("", []);
    cancelWarmSink();
    cancelWarmSink = () => {};
    await clientRuntime.dispose();
    seedRuntimeDisposed = true;
    clientRuntime = null;
    await clientStorage.close();
    seedStorageClosed = true;
    clientStorage = null;
    await pool.close();
    pool = null;
    assertEquals(server.listExecutionClaims(space), []);

    const coldCommits: ClientCommit[] = [];
    coldStorage = LoopbackStorageManager.connectTo(
      server,
      FLAGS,
      { as: principal },
      (commit) => coldCommits.push(commit),
    );
    coldRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: coldStorage,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
    });
    await coldRuntime.patternManager.compilePattern(program, { space });
    const coldRoot = coldRuntime.getCellFromLink(stableResultLink);
    await coldRoot.sync();
    assertEquals(coldRoot.sourceURI, stableResultId);
    assertEquals(await coldRuntime.start(coldRoot), true);
    const coldResult = options.nestedRoot === true
      ? coldRoot.key("doubled")
      : coldRoot;
    assertEquals(await coldResult.pull() as unknown, 22);
    await coldRuntime.settled();
    await coldStorage.synced();
    await assertStableIdentity();
    assertEquals(server.listExecutionClaims(space), []);
    assertEquals(
      coldCommits.filter((commit) => commit.operations.length > 0),
      [],
    );
  } finally {
    server.releaseSchedulerList.resolve();
    unsubscribeControl();
    cancelWarmSink();
    await coldRuntime?.dispose().catch(() => undefined);
    await coldStorage?.close().catch(() => undefined);
    await clientRuntime?.dispose().catch(() => undefined);
    await clientStorage?.close().catch(() => undefined);
    await pool?.close().catch(() => undefined);
    if (!seedRuntimeDisposed) {
      await seedRuntime.dispose().catch(() => undefined);
    }
    if (!seedStorageClosed) await seedStorage.close().catch(() => undefined);
    await observerClient?.close().catch(() => undefined);
    for (const client of raceObserverClients) {
      await client.close().catch(() => undefined);
    }
    await server.close();
  }
}

Deno.test("a later claimed rerun rejection revokes its exact live Worker claim", async () => {
  const principal = await Identity.fromPassphrase(
    `executor later rerun rejection ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const server = new RejectNextClaimedCommitServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-executor-rerun-rejection" },
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
  let unsubscribeControl = () => {};
  const events: string[] = [];
  try {
    const compiled = await seedRuntime.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const tx = seedRuntime.edit();
    const input = seedRuntime.getCell<number>(
      space,
      "executor-rerun-rejection-input",
      undefined,
      tx,
    );
    input.set(5);
    const result = seedRuntime.getCell<number>(
      space,
      "executor-rerun-rejection-result",
      undefined,
      tx,
    );
    const handle = seedRuntime.run(tx, compiled, { value: input }, result);
    assertEquals((await tx.commit()).error, undefined);
    assertEquals(await handle.pull(), 10);
    await seedRuntime.settled();
    await seedRuntime.storageManager.synced();

    observerClient = await MemoryClient.connect({
      transport: MemoryClient.loopback(server),
      protocolFlags: FLAGS,
    });
    const observer = await observerClient.mount(space, {}, authorize);
    await observer.setExecutionDemand("", [result.sourceURI]);
    await observer.watchSet([{
      id: "executor-rerun-rejection-piece",
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

    const claimed = Promise.withResolvers<ExecutionClaim>();
    const firstSettled = Promise.withResolvers<ActionSettlement>();
    const revoked = Promise.withResolvers<void>();
    const rejectedDiagnostic = Promise.withResolvers<string>();
    const settlements: ActionSettlement[] = [];
    const expectedFirstAttempt: {
      claim?: ExecutionClaim;
      sourceSeq: number;
    } = { sourceSeq: Number.POSITIVE_INFINITY };
    let liveClaim: ExecutionClaim | undefined;
    const resolveFirstCommittedSettlement = (
      settlement: ActionSettlement,
    ): void => {
      if (
        expectedFirstAttempt.claim !== undefined &&
        settlement.outcome === "committed" &&
        settlement.claim.actionId === expectedFirstAttempt.claim.actionId &&
        settlement.claim.leaseGeneration ===
          expectedFirstAttempt.claim.leaseGeneration &&
        settlement.claim.claimGeneration ===
          expectedFirstAttempt.claim.claimGeneration &&
        settlement.inputBasisSeq >= expectedFirstAttempt.sourceSeq
      ) {
        firstSettled.resolve(settlement);
      }
    };
    unsubscribeControl = observer.subscribeExecutionControl((event) => {
      events.push(event.type);
      if (event.type === "session.execution.claim.set") {
        liveClaim = event.claim;
        claimed.resolve(event.claim);
      } else if (event.type === "session.execution.settlement") {
        settlements.push(event.settlement);
        if (event.settlement.outcome === "committed") {
          server.releaseDelayedUnclaimedCommitResponse();
        }
        resolveFirstCommittedSettlement(event.settlement);
      } else if (
        event.type === "session.execution.claim.revoke" &&
        liveClaim !== undefined &&
        event.claim.actionId === liveClaim.actionId &&
        event.leaseGeneration === liveClaim.leaseGeneration &&
        event.claimGeneration === liveClaim.claimGeneration
      ) {
        revoked.resolve();
      }
    });

    const factory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: new URL("https://toolshed.example/"),
      patternApiUrl: new URL("https://toolshed.example/"),
      protocolFlags: FLAGS,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
      onCandidateDiagnostic(diagnostic) {
        events.push(`diagnostic:${diagnostic.diagnosticCode}`);
        if (
          diagnostic.diagnosticCode === "commit-rejected:AuthorizationError"
        ) {
          rejectedDiagnostic.resolve(diagnostic.diagnosticCode);
        }
      },
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

    // Force the accepted commit notification to win the source transaction
    // response. A later coalesced no-op may share this input basis, so the
    // assertion must recover the already buffered committed settlement.
    server.delayNextUnclaimedCommitResponse();
    const firstSourcePromise = observer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: 7 },
      }],
    });
    const exactClaim = await awaitBarrier(claimed.promise, "claim", events);
    expectedFirstAttempt.claim = exactClaim;
    const firstSource = await awaitBarrier(
      firstSourcePromise,
      "first source response after committed settlement",
      events,
    );
    expectedFirstAttempt.sourceSeq = firstSource.seq;
    for (const settlement of settlements) {
      resolveFirstCommittedSettlement(settlement);
    }
    const accepted = await awaitBarrier(
      firstSettled.promise,
      "first settlement",
      events,
    );
    assertEquals(accepted.outcome, "committed");
    assertEquals(await executor.settle() >= firstSource.seq, true);

    // The successful activation lifecycle has ended, but its authority remains
    // attached to the live Action for later reactive reruns.
    server.rejectNextClaimedCommit();
    const rejectedSource = await observer.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: 8 },
      }],
    });
    assertEquals(
      await awaitBarrier(
        rejectedDiagnostic.promise,
        "rejected rerun diagnostic",
        events,
      ),
      "commit-rejected:AuthorizationError",
    );
    await awaitBarrier(revoked.promise, "exact claim revoke", events);
    await executor.settle();

    assertEquals(server.hasLiveExecutionClaim(exactClaim), false);
    assertEquals(
      settlements.some((settlement) =>
        settlement.inputBasisSeq >= rejectedSource.seq
      ),
      false,
    );
    assertEquals(events.some((event) => event.startsWith("crash:")), false);
  } finally {
    server.releaseDelayedUnclaimedCommitResponse();
    unsubscribeControl();
    await executor?.stop().catch(() => undefined);
    await seedRuntime.dispose().catch(() => undefined);
    await seedStorage.close().catch(() => undefined);
    await observerClient?.close().catch(() => undefined);
    await server.close();
  }
});

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
      // Key on the COMMITTED settlement covering the source commit. A
      // committed settlement's client delivery gates on the session's data
      // sync reaching its acceptedCommitSeq, while a trailing no-op
      // follow-up attempt (which carries no data) is not gated — so with the
      // F2 point-read refresh the Worker can settle that no-op fast enough
      // to arrive first. Consumers merge settlements per claim
      // (mergeSuccessfulExecutionSettlements keeps the committed outcome),
      // so arrival order is not a contract.
      if (
        event.type === "session.execution.settlement" &&
        event.settlement.outcome === "committed" &&
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

    // Client computation remains live for speculative UI latency. Each lazy
    // replica may either run once or adopt a server observation; which replicas
    // do each is timing-dependent. This runner gate forbids per-client
    // duplicate work and client-derived writes across an executor restart.
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
    const clientActionRunCounts = (): number[] =>
      clientRuntimes.map(
        (runtime) =>
          runtime.scheduler.getActionRunTrace().filter((entry) =>
            entry.actionId === actionId && entry.actionType === "computation"
          ).length,
      );

    let observerLocalSeq = 4;
    const runInvalidation = async (value: number): Promise<number[]> => {
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
      return clientActionRunCounts();
    };
    const runPhase = async (startValue: number): Promise<number[][]> => {
      const samples: number[][] = [];
      for (let offset = 0; offset < 20; offset++) {
        samples.push(await runInvalidation(startValue + offset));
      }
      return samples;
    };

    // Restart the direct executor under the same global server-primary mode.
    // The old generation is fenced before the replacement acquires authority.
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
    assertExists(executor);
    await executor.stop();
    executor = null;
    const drainingLease = await server.beginExecutionLeaseDrain(lease);
    assertExists(drainingLease);
    assertEquals(drainingLease.state, "draining");
    assertExists(await server.finishExecutionLeaseDrain(drainingLease));
    try {
      await awaitBarrier(revoked.promise, "restarted claim revoke", events);
    } finally {
      unsubscribeRevoke();
    }
    const rolloutLease = await server.acquireExecutionLease(space, "");
    assertExists(rolloutLease);
    const reclaimed = Promise.withResolvers<void>();
    let reclaimedClaim: ExecutionClaim | undefined;
    const unsubscribeReclaim = observer.subscribeExecutionControl((event) => {
      if (
        event.type === "session.execution.claim.set" &&
        event.claim.actionId === actionId &&
        event.claim.leaseGeneration === rolloutLease.leaseGeneration
      ) {
        reclaimedClaim = event.claim;
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
      await awaitBarrier(reclaimed.promise, "restarted claim restore", events);
    } finally {
      unsubscribeReclaim();
    }
    assertExists(reclaimedClaim);
    assertEquals(reclaimedClaim.leaseGeneration, rolloutLease.leaseGeneration);
    assertEquals(reclaimedClaim.claimGeneration, 1);
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

    assertEquals(
      enabledRuns.every((perClient) => perClient.every((runs) => runs <= 1)),
      true,
      `enabled client action runs contained duplicates: ${
        enabledRuns.map((perClient) => perClient.join(",")).join(";")
      }`,
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

Deno.test("an ordinary demand shrink releases only the removed root's claims", async () => {
  const principal = await Identity.fromPassphrase(
    `executor shrink e2e ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const server = new Server({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-executor-shrink-e2e" },
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
  let unsubscribeControl = () => {};
  const events: string[] = [];
  try {
    const compiled = await seedRuntime.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const seed = async (name: string, value: number) => {
      const tx = seedRuntime.edit();
      const input = seedRuntime.getCell<number>(
        space,
        `executor-shrink-input-${name}`,
        undefined,
        tx,
      );
      input.set(value);
      const result = seedRuntime.getCell<number>(
        space,
        `executor-shrink-result-${name}`,
        undefined,
        tx,
      );
      const handle = seedRuntime.run(tx, compiled, { value: input }, result);
      assertEquals((await tx.commit()).error, undefined);
      assertEquals(await handle.pull(), value * 2);
      return { input, result };
    };
    const pieceA = await seed("a", 5);
    const pieceB = await seed("b", 6);
    await seedRuntime.settled();
    await seedRuntime.storageManager.synced();
    await seedRuntime.dispose();

    observerClient = await MemoryClient.connect({
      transport: MemoryClient.loopback(server),
      protocolFlags: FLAGS,
    });
    const observer = await observerClient.mount(space, {}, authorize);
    await observer.setExecutionDemand("", [
      pieceA.result.sourceURI,
      pieceB.result.sourceURI,
    ]);
    // Settlements are ordered against the session's data feed; watch both
    // roots so the control events can deliver.
    await observer.watchSet([{
      id: "executor-shrink-e2e-a",
      kind: "graph",
      query: {
        roots: [{
          id: pieceA.result.sourceURI,
          selector: { path: [], schema: true },
        }],
      },
    }, {
      id: "executor-shrink-e2e-b",
      kind: "graph",
      query: {
        roots: [{
          id: pieceB.result.sourceURI,
          selector: { path: [], schema: true },
        }],
      },
    }]);
    const lease = await server.acquireExecutionLease(space, "");
    assertExists(lease);

    const claims = new Map<string, ExecutionClaim>();
    const revokes: Array<{ pieceId: string; claimGeneration: number }> = [];
    const settlements: ActionSettlement[] = [];
    const bothClaimed = Promise.withResolvers<void>();
    const revokedB = Promise.withResolvers<void>();
    const pieceIdA = `space:${pieceA.result.sourceURI}`;
    const pieceIdB = `space:${pieceB.result.sourceURI}`;
    unsubscribeControl = observer.subscribeExecutionControl((event) => {
      events.push(event.type);
      if (event.type === "session.execution.claim.set") {
        claims.set(event.claim.pieceId, event.claim);
        if (claims.has(pieceIdA) && claims.has(pieceIdB)) {
          bothClaimed.resolve();
        }
      }
      if (event.type === "session.execution.claim.revoke") {
        revokes.push({
          pieceId: event.claim.pieceId,
          claimGeneration: event.claimGeneration,
        });
        if (event.claim.pieceId === pieceIdB) revokedB.resolve();
      }
      if (event.type === "session.execution.settlement") {
        settlements.push(event.settlement);
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
    });
    executor = await factory.start({
      space,
      branch: "",
      lease,
      pieces: [pieceA.result.sourceURI, pieceB.result.sourceURI],
      onCrash(error) {
        events.push(`crash:${error}`);
      },
    });
    // One source invalidation per piece drives discovery to exact claims.
    await observer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: pieceA.input.sourceURI,
        value: { value: 7 },
      }],
    });
    await observer.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: pieceB.input.sourceURI,
        value: { value: 8 },
      }],
    });
    await awaitBarrier(bothClaimed.promise, "both pieces claimed", events);
    const claimA = claims.get(pieceIdA)!;

    // Shrink away piece B. The Worker's scheduler-unregister hook must
    // release exactly B's claim; A's incarnation survives untouched.
    await executor.setDemand([pieceA.result.sourceURI]);
    await awaitBarrier(revokedB.promise, "shrink releases B's claim", events);
    assertEquals(
      revokes.filter((revoke) => revoke.pieceId === pieceIdA),
      [],
    );
    assertEquals(server.listExecutionClaims(space), [claimA]);
    assertEquals(
      server.listExecutionClaims(space)[0]!.claimGeneration,
      claimA.claimGeneration,
    );
    assertEquals(events.filter((event) => event.startsWith("crash:")), []);

    // A's authority is uninterrupted: the next source invalidation settles
    // under the same claim incarnation without a reclaim.
    const settledA = Promise.withResolvers<ActionSettlement>();
    let sourceSeqA = Number.POSITIVE_INFINITY;
    const unsubscribeSettled = observer.subscribeExecutionControl((event) => {
      if (
        event.type === "session.execution.settlement" &&
        event.settlement.claim.pieceId === pieceIdA &&
        event.settlement.inputBasisSeq >= sourceSeqA
      ) {
        settledA.resolve(event.settlement);
      }
    });
    try {
      const source = await observer.transact({
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: pieceA.input.sourceURI,
          value: { value: 9 },
        }],
      });
      sourceSeqA = source.seq;
      const settlement = await awaitBarrier(
        settledA.promise,
        "post-shrink settlement for A",
        events,
      );
      assertEquals(
        settlement.outcome === "committed" || settlement.outcome === "no-op",
        true,
      );
      assertEquals(settlement.claim.claimGeneration, claimA.claimGeneration);
      assertEquals(settlement.claim.leaseGeneration, claimA.leaseGeneration);
    } finally {
      unsubscribeSettled();
    }
    assertEquals(events.filter((event) => event.startsWith("crash:")), []);
  } finally {
    unsubscribeControl();
    await executor?.stop();
    await seedStorage.close();
    await observerClient?.close();
    await server.close();
  }
});

Deno.test("shared execution pool releases and restores server authority with demand", async () => {
  await exercisePoolDemandRestart();
});

Deno.test("replacement executor restores claimed discovery after lease expiry", async () => {
  await exercisePoolDemandRestart({ replaceShadowWorker: true });
});

Deno.test("replacement executor reruns before adopting a same-window client observation", async () => {
  await exercisePoolDemandRestart({
    nestedRoot: true,
    replaceShadowWorker: true,
    sameWindowRemoteObservation: true,
  });
});

Deno.test("replacement executor does not initially rehydrate a raced client observation clean", async () => {
  await exercisePoolDemandRestart({
    nestedRoot: true,
    replaceShadowWorker: true,
    initialCleanSnapshotRace: true,
  });
});

Deno.test("replacement executor reruns an initially clean snapshot for claim discovery", async () => {
  await exercisePoolDemandRestart({
    nestedRoot: true,
    replaceShadowWorker: true,
    initialCleanSnapshotClaim: true,
  });
});

Deno.test("real Worker settles permanent builtin failures unserved but retains transient claims", async (t) => {
  const cases = [
    {
      mode: "broker-policy" as const,
      diagnosticCode: "server-builtin-egress-blocked-destination",
      forbiddenStoredError: "blocked destination fixture",
    },
    {
      mode: "invalid-url" as const,
      diagnosticCode: "server-builtin-egress-invalid-url",
      forbiddenStoredError: "invalid URL fixture",
    },
    {
      mode: "causal-mismatch" as const,
      diagnosticCode: "builtin-causal-actor-mismatch",
      forbiddenStoredError:
        "server builtin causal actor does not match the lease sponsor",
    },
    {
      mode: "transient" as const,
      storedError: "HTTP 503: temporary broker failure",
    },
  ];

  for (const fixture of cases) {
    await t.step(fixture.mode, async () => {
      const sponsor = await Identity.fromPassphrase(
        `executor builtin permanent sponsor ${fixture.mode} ${crypto.randomUUID()}`,
      );
      const other = await Identity.fromPassphrase(
        `executor builtin permanent other ${fixture.mode} ${crypto.randomUUID()}`,
      );
      const space = sponsor.did();
      const servingOrigin = new URL("https://toolshed.example/");
      const server = new Server({
        authorizeSessionOpen(message) {
          const value = (message.authorization as { principal?: unknown })
            ?.principal;
          return typeof value === "string" ? value : undefined;
        },
        sessionOpenAuth: {
          audience: "did:key:z6Mk-executor-builtin-permanent-e2e",
        },
        protocolFlags: BUILTIN_FLAGS,
        acl: { mode: "off", serviceDids: [space] },
      });
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
      const seedStorage = LoopbackStorageManager.connectTo(
        server,
        BUILTIN_FLAGS,
        { as: sponsor },
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
      let observerClient: MemoryClient.Client | undefined;
      let otherClient: MemoryClient.Client | undefined;
      let executor:
        | Awaited<ReturnType<DenoSpaceExecutorFactory["start"]>>
        | undefined;
      let unsubscribeAccepted = () => {};
      let unsubscribeControl = () => {};
      const events: string[] = [];
      try {
        const compiled = await seedRuntime.patternManager.compilePattern(
          FETCH_BUILTIN_PROGRAM,
          { space },
        );
        const tx = seedRuntime.edit();
        const input = seedRuntime.getCell<string>(
          space,
          `executor-builtin-permanent-input-${fixture.mode}`,
          undefined,
          tx,
        );
        input.set(fixture.mode === "invalid-url" ? "http://[" : "/initial");
        const result = seedRuntime.getCell<Record<string, unknown>>(
          space,
          `executor-builtin-permanent-result-${fixture.mode}`,
          undefined,
          tx,
        );
        const handle = seedRuntime.run(tx, compiled, { url: input }, result);
        assertEquals((await tx.commit()).error, undefined);
        await handle.pull();
        await seedRuntime.settled();
        await seedRuntime.storageManager.synced();
        await seedRuntime.dispose();

        observerClient = await MemoryClient.connect({
          transport: MemoryClient.loopback(server),
          protocolFlags: BUILTIN_FLAGS,
        });
        const observer = await observerClient.mount(
          space,
          {},
          authorize(sponsor.did()),
        );
        await observer.setExecutionDemand("", [result.sourceURI]);
        await observer.watchSet([{
          id: `executor-builtin-permanent-watch-${fixture.mode}`,
          kind: "graph",
          query: {
            roots: [{
              id: result.sourceURI,
              selector: { path: [], schema: true },
            }],
          },
        }]);
        const lease = await server.acquireExecutionLease(space, "", {
          preferredOriginSessionId: observer.sessionId,
        });
        assertExists(lease);

        const claimed = Promise.withResolvers<ExecutionClaim>();
        const initialResult = Promise.withResolvers<void>();
        const terminalSettlement = Promise.withResolvers<ActionSettlement>();
        const transientErrorStored = Promise.withResolvers<void>();
        const revisedIds = new Set<string>();
        const settlements: ActionSettlement[] = [];
        let revokes = 0;
        unsubscribeControl = observer.subscribeExecutionControl((event) => {
          events.push(
            event.type === "session.execution.settlement"
              ? event.type + ":" + event.settlement.outcome + ":" +
                (event.settlement.diagnosticCode ?? "")
              : event.type,
          );
          if (event.type === "session.execution.claim.set") {
            claimed.resolve(event.claim);
          } else if (event.type === "session.execution.claim.revoke") {
            revokes++;
          } else if (event.type === "session.execution.settlement") {
            settlements.push(event.settlement);
            if (
              fixture.mode !== "transient" &&
              event.settlement.outcome === "unserved"
            ) {
              terminalSettlement.resolve(event.settlement);
            }
          }
        });
        unsubscribeAccepted = server.subscribeAcceptedCommits(
          space,
          (event) => {
            for (const revision of event.revisions) {
              revisedIds.add(revision.id);
              void server.readDocument(space, revision.id).then((document) => {
                if (containsStoredValue(document, "initial response")) {
                  initialResult.resolve();
                }
                if (
                  fixture.mode === "transient" &&
                  containsStoredValue(document, fixture.storedError)
                ) {
                  transientErrorStored.resolve();
                }
              });
            }
          },
        );

        let brokerCalls = 0;
        const factory = new DenoSpaceExecutorFactory({
          server,
          apiUrl: servingOrigin,
          patternApiUrl: servingOrigin,
          experimental: {
            persistentSchedulerState: true,
            serverPrimaryExecution: true,
          },
          createBuiltinBroker: () => ({
            fetch() {
              brokerCalls++;
              events.push(`broker:${fixture.mode}:${brokerCalls}`);
              if (fixture.mode === "broker-policy") {
                throw new ServerBuiltinEgressError(
                  "blocked-destination",
                  "blocked destination fixture",
                );
              }
              if (fixture.mode === "invalid-url") {
                throw new ServerBuiltinEgressError(
                  "invalid-url",
                  "invalid URL fixture",
                );
              }
              if (fixture.mode === "transient") {
                return Promise.resolve({
                  response: new Response("retry later", {
                    status: 503,
                    statusText: "temporary broker failure",
                  }),
                  finalUrl: new URL("/transient", servingOrigin),
                  redirectCount: 0,
                });
              }
              return Promise.resolve({
                response: new Response("initial response"),
                finalUrl: new URL("/initial", servingOrigin),
                redirectCount: 0,
              });
            },
          }),
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
        const liveClaim = await awaitBarrier(
          claimed.promise,
          `${fixture.mode} claim`,
          events,
        );

        if (fixture.mode === "causal-mismatch") {
          await awaitBarrier(
            initialResult.promise,
            "causal mismatch initial result",
            events,
          );
          otherClient = await MemoryClient.connect({
            transport: MemoryClient.loopback(server),
            protocolFlags: BUILTIN_FLAGS,
          });
          const otherSession = await otherClient.mount(
            space,
            {},
            authorize(other.did()),
          );
          await otherSession.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: input.sourceURI,
              value: { value: "/mismatched" },
            }],
          });
        }

        const terminal = fixture.mode === "transient"
          ? (await awaitBarrier(
            transientErrorStored.promise,
            "transient builtin error writeback",
            events,
          ),
            undefined)
          : await awaitBarrier(
            terminalSettlement.promise,
            `${fixture.mode} terminal settlement`,
            events,
          );
        await executor.settle();
        const storedDocuments = await Promise.all(
          [...revisedIds].map((id) => server.readDocument(space, id)),
        );
        assertEquals(events.some((event) => event.startsWith("crash:")), false);
        assertEquals(brokerCalls, 1);

        if (fixture.mode === "transient") {
          assertEquals(
            storedDocuments.some((document) =>
              containsStoredValue(document, fixture.storedError)
            ),
            true,
          );
          assertEquals(
            observer.executionClaims.some((entry) =>
              entry.actionId === liveClaim.actionId &&
              entry.claimGeneration === liveClaim.claimGeneration
            ),
            true,
          );
          assertEquals(revokes, 0);
        } else {
          assertExists(terminal);
          assertEquals(terminal.outcome, "unserved");
          assertEquals(terminal.diagnosticCode, fixture.diagnosticCode);
          assertEquals(
            settlements.filter((entry) => entry.outcome === "unserved").length,
            1,
          );
          assertEquals(revokes, 1);
          assertEquals(
            storedDocuments.some((document) =>
              containsStoredValue(document, fixture.forbiddenStoredError)
            ),
            false,
          );
          assertEquals(observer.executionClaims, []);
        }
      } finally {
        unsubscribeControl();
        unsubscribeAccepted();
        await executor?.stop();
        await otherClient?.close();
        await observerClient?.close();
        await seedRuntime.dispose();
        await seedStorage.close();
        await server.close();
      }
    });
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
  const fourAsyncRequestsPublished = Promise.withResolvers<
    ExecutorExecutionMetricsSnapshot
  >();
  const completedBrokerRoundPublished = Promise.withResolvers<
    ExecutorExecutionMetricsSnapshot
  >();
  let brokerRoundCompletionBaseline:
    | ExecutorExecutionMetricsSnapshot
    | undefined;
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
      onExecutionMetrics(snapshot) {
        if (snapshot.asyncRequests >= 4) {
          fourAsyncRequestsPublished.resolve(snapshot);
        }
        const baseline = brokerRoundCompletionBaseline;
        if (
          baseline !== undefined &&
          snapshot.schedulerRuns > baseline.schedulerRuns &&
          snapshot.actionTransactions.authoritative >
            baseline.actionTransactions.authoritative
        ) {
          completedBrokerRoundPublished.resolve(snapshot);
        }
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
      assertExists(executor);
      const startedRoundMetrics = await awaitBarrier(
        fourAsyncRequestsPublished.promise,
        "server async placement metrics",
        events,
      );
      assertEquals(
        startedRoundMetrics.asyncRequests,
        4,
        "server async request placement must publish without another Worker request",
      );
      brokerRoundCompletionBaseline = startedRoundMetrics;
      await awaitBarrier(
        executor.wake(),
        "executor wake while claimed broker work remains unsettled",
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
      const [, completedRoundMetrics] = await Promise.all([
        awaitBarrier(
          clientResultsObserved.promise,
          "client builtin result state",
          events,
        ),
        awaitBarrier(
          completedBrokerRoundPublished.promise,
          "completed server placement metrics",
          events,
        ),
      ]);
      assertEquals(
        completedRoundMetrics.schedulerRuns >
          startedRoundMetrics.schedulerRuns,
        true,
      );
      assertEquals(
        completedRoundMetrics.actionTransactions.authoritative >
          startedRoundMetrics.actionTransactions.authoritative,
        true,
      );
    } finally {
      releaseSecondBrokerRound.resolve();
      heldBrokerRound = undefined;
    }
    for (const runtime of clientRuntimes) await runtime.settled();
    assertEquals(clientNetworkRequests, []);
    assertEquals(clientDerivedWrites(), []);
  } finally {
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

Deno.test("claimed fetchProgram and generateObject complete once through deterministic host brokers", async () => {
  const principal = await Identity.fromPassphrase(
    `executor distinct builtin e2e ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const servingOrigin = new URL("https://toolshed.example/");
  const server = new Server({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-distinct-builtin-e2e",
    },
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
  let unsubscribeControl = () => {};
  const events: string[] = [];
  const brokerUrls: string[] = [];
  const authorized: Array<{
    builtinId: string;
    claim: ExecutionClaim;
  }> = [];
  try {
    const compiled = await seedRuntime.patternManager.compilePattern(
      DISTINCT_ASYNC_BUILTIN_PROGRAM,
      { space },
    );
    const tx = seedRuntime.edit();
    const programUrl = seedRuntime.getCell<string>(
      space,
      "executor-distinct-builtin-program-url",
      undefined,
      tx,
    );
    programUrl.set("/program.ts");
    const prompt = seedRuntime.getCell<string>(
      space,
      "executor-distinct-builtin-prompt",
      undefined,
      tx,
    );
    prompt.set("produce the deterministic object");
    const result = seedRuntime.getCell<Record<string, unknown>>(
      space,
      "executor-distinct-builtin-result",
      undefined,
      tx,
    );
    const handle = seedRuntime.run(
      tx,
      compiled,
      { programUrl, prompt },
      result,
    );
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    await seedRuntime.settled();
    await seedRuntime.storageManager.synced();
    await seedRuntime.dispose();

    observerClient = await MemoryClient.connect({
      transport: MemoryClient.loopback(server),
      protocolFlags: BUILTIN_FLAGS,
    });
    const observer = await observerClient.mount(space, {}, authorize);
    await observer.setExecutionDemand("", [result.sourceURI]);
    await observer.watchSet([{
      id: "executor-distinct-builtin-piece",
      kind: "graph",
      query: {
        roots: [{
          id: result.sourceURI,
          selector: { path: [], schema: true },
        }],
      },
    }]);

    const expectedBuiltins = ["fetchProgram", "generateObject"] as const;
    const builtinForClaim = (claim: ExecutionClaim) =>
      expectedBuiltins.find((builtinId) =>
        claim.implementationFingerprint.includes(builtinId)
      );
    const claims = new Map<string, ExecutionClaim>();
    const claimsReady = Promise.withResolvers<void>();
    const settlements = new Set<string>();
    const settlementsReady = Promise.withResolvers<void>();
    unsubscribeControl = observer.subscribeExecutionControl((event) => {
      events.push(event.type);
      if (event.type === "session.execution.claim.revoke") {
        events.push(`revoke:${event.claim.actionId}`);
      }
      if (event.type === "session.execution.claim.set") {
        const builtinId = builtinForClaim(event.claim);
        if (builtinId !== undefined) claims.set(builtinId, event.claim);
        if (claims.size === expectedBuiltins.length) claimsReady.resolve();
      }
      if (event.type === "session.execution.settlement") {
        const builtinId = builtinForClaim(event.settlement.claim);
        if (
          builtinId !== undefined &&
          (event.settlement.outcome === "committed" ||
            event.settlement.outcome === "no-op")
        ) {
          settlements.add(builtinId);
        }
        if (settlements.size === expectedBuiltins.length) {
          settlementsReady.resolve();
        }
      }
    });

    const acceptedResults = new Set<string>();
    const resultsReady = Promise.withResolvers<void>();
    unsubscribeAccepted = server.subscribeAcceptedCommits(space, (event) => {
      for (const revision of event.revisions) {
        void server.readDocument(space, revision.id).then((document) => {
          const value = (document as { value?: unknown } | undefined)?.value;
          if (containsStoredValue(value, "export default 7;\n")) {
            acceptedResults.add("fetchProgram");
            events.push("accepted:fetchProgram");
          }
          if (containsStoredValue(value, "deterministic title")) {
            acceptedResults.add("generateObject");
            events.push("accepted:generateObject");
          }
          if (acceptedResults.size === expectedBuiltins.length) {
            resultsReady.resolve();
          }
        });
      }
    });

    const lease = await server.acquireExecutionLease(space, "");
    assertExists(lease);
    const factory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: servingOrigin,
      patternApiUrl: servingOrigin,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
      createBuiltinBroker: () => ({
        fetch(request) {
          brokerUrls.push(request.url);
          events.push(`broker:${request.url}`);
          if (request.url === "/program.ts") {
            return Promise.resolve({
              response: new Response("export default 7;\n", {
                headers: { "content-type": "text/typescript" },
              }),
              finalUrl: new URL(request.url, servingOrigin),
              redirectCount: 0,
            });
          }
          if (request.url === "/api/ai/llm/generateObject") {
            return Promise.resolve({
              response: Response.json({
                object: { title: "deterministic title" },
                id: "server-generate-object-e2e",
              }),
              finalUrl: new URL(request.url, servingOrigin),
              redirectCount: 0,
            });
          }
          return Promise.reject(
            new Error(`unexpected server builtin URL: ${request.url}`),
          );
        },
      }),
      authorizeBuiltinRequest(request) {
        authorized.push({
          builtinId: request.builtinId,
          claim: request.claim,
        });
      },
      onCandidateClaim: (candidate) =>
        events.push(`candidate:${candidate.builtinId}`),
      onCandidateDiagnostic: (diagnostic) =>
        events.push(
          `diagnostic:${diagnostic.claimKey?.actionId ?? "ownerless"}:` +
            diagnostic.diagnosticCode,
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

    await awaitBarrier(claimsReady.promise, "distinct builtin claims", events);
    await awaitBarrier(
      resultsReady.promise,
      "distinct builtin results",
      events,
    );
    await awaitBarrier(
      settlementsReady.promise,
      "distinct builtin settlements",
      events,
    );
    await executor.settle();

    assertEquals([...claims.keys()].sort(), [...expectedBuiltins].sort());
    assertEquals([...acceptedResults].sort(), [...expectedBuiltins].sort());
    assertEquals([...settlements].sort(), [...expectedBuiltins].sort());
    assertEquals(
      authorized.map((entry) => entry.builtinId).sort(),
      [...expectedBuiltins].sort(),
    );
    for (const entry of authorized) {
      assertEquals(entry.claim, claims.get(entry.builtinId));
    }
    assertEquals(brokerUrls.sort(), [
      "/api/ai/llm/generateObject",
      "/program.ts",
    ]);
    assertEquals(events.some((event) => event.startsWith("crash:")), false);

    const requestCount = brokerUrls.length;
    await executor.wake();
    await executor.settle();
    assertEquals(
      brokerUrls.length,
      requestCount,
      "an unchanged wake must not duplicate either external effect",
    );
  } finally {
    unsubscribeControl();
    unsubscribeAccepted();
    await executor?.stop();
    await seedRuntime.dispose();
    await seedStorage.close();
    await observerClient?.close();
    await server.close();
  }
});
