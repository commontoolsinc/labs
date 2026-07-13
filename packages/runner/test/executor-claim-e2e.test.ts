import { assertEquals, assertExists } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import {
  addMockResponse,
  enableMockMode,
  resetMockMode,
} from "@commonfabric/llm/client";
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
import { SharedExecutionPool } from "../src/executor/shared-execution-pool.ts";
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

  rejectNextClaimedCommit(): void {
    this.#rejectNextClaimedCommit = true;
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
    return super.transact(message);
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

async function exercisePoolAuthorityTransition(
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
    const shadowRejected = Promise.withResolvers<void>();
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
        if (diagnostic.diagnosticCode === "execution-policy-disabled") {
          shadowRejected.resolve();
        }
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

    // Absent policy: the pool owns one shadow Worker, but authority and the
    // accepted derived write remain client-side.
    clientCommits.length = 0;
    const shadowSourceSeq = await runSource(6);
    await awaitBarrier(
      shadowRejected.promise,
      "shadow policy rejection",
      acceptedEvents,
    );
    assertExists(candidateActionId);
    assertEquals(server.listExecutionClaims(space), []);
    assertEquals(clientCommits.some(isDerivedWireCommit), true);
    const remoteObservationTemplate =
      options.sameWindowRemoteObservation || options.initialCleanSnapshotRace
        ? clientCommits.find(isDerivedWireCommit)
        : undefined;
    if (
      options.sameWindowRemoteObservation || options.initialCleanSnapshotRace
    ) {
      assertExists(remoteObservationTemplate);
    }

    if (
      options.initialCleanSnapshotRace || options.initialCleanSnapshotClaim
    ) {
      // Enabling rotates the shadow lease before the server republishes the
      // unchanged demand. The replacement's clean startup is therefore the
      // candidate-proof boundary, without replaying effects or builtins.
      const sourceSession = options.initialCleanSnapshotRace
        ? await getRaceObserver()
        : observer;
      if (options.initialCleanSnapshotRace) server.gateNextSchedulerList();
      const enable = writePolicy(true);
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
      await enable;
      await pool.idle();
      assertEquals(pool.snapshot(space, ""), {
        state: "live",
        referenceCount: 1,
        pieces: [stableResultId],
        leaseGeneration: 2,
      });
      assertEquals(pool.metrics().leaseLosses, 1);
      assertEquals(pool.metrics().leaseReplacements, 1);
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
            event.settlement.inputBasisSeq >= shadowSourceSeq,
          "initial clean snapshot settlement",
        );
        assertEquals(cleanResumeClaim.claim.claimGeneration, 1);
        assertEquals(server.listExecutionClaims(space), [
          cleanResumeClaim.claim,
        ]);
        assertEquals(cleanResumeSettlement.settlement.outcome, "no-op");
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
      // Preserve a separate pre-promotion replacement case: generation 1 has
      // discovered the writer while shadowing, then expires. The policy
      // transition below must rotate this generation 2 once more.
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

    // Enable by fencing the shadow generation and starting one clean
    // replacement. No piece or document is recreated.
    const workersBeforeEnable = pool.metrics().workersStarted;
    const leaseGenerationBeforeEnable = pool.snapshot(space, "")
      ?.leaseGeneration;
    assertExists(leaseGenerationBeforeEnable);
    await writePolicy(true);
    assertEquals(pool.snapshot(space, ""), {
      state: "live",
      referenceCount: 1,
      pieces: [stableResultId],
      leaseGeneration: leaseGenerationBeforeEnable + 1,
    });
    assertEquals(pool.metrics().workersStarted, workersBeforeEnable + 1);
    clientCommits.length = 0;
    const promotionSeq = await runSource(7, false);
    const claimEvent = await waitForControl(
      (event): event is Extract<
        ExecutionControlEvent,
        { type: "session.execution.claim.set" }
      > =>
        event.type === "session.execution.claim.set" &&
        event.claim.actionId === candidateActionId &&
        event.claim.leaseGeneration === leaseGenerationBeforeEnable + 1,
      "pool transition claim",
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
        event.settlement.inputBasisSeq >= promotionSeq,
      "pool transition promotion settlement",
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

    // Disable in place. Revocation clears claim authority and the policy
    // commit does not return until the pool has fenced the old lease and
    // replaced its Worker with a fresh shadow realm.
    const workersBeforeDisable = pool.metrics().workersStarted;
    const leaseGenerationBeforeDisable = pool.snapshot(space, "")
      ?.leaseGeneration;
    await writePolicy(false);
    await waitForControl(
      (event): event is Extract<
        ExecutionControlEvent,
        { type: "session.execution.claim.revoke" }
      > =>
        event.type === "session.execution.claim.revoke" &&
        event.claim.actionId === claim.actionId &&
        event.leaseGeneration === claim.leaseGeneration &&
        event.claimGeneration === claim.claimGeneration,
      "pool transition claim revoke",
    );
    await clientStorage.synced();
    await clientRuntime.settled();
    assertEquals(server.listExecutionClaims(space), []);
    assertEquals(pool.snapshot(space, ""), {
      state: "live",
      referenceCount: 1,
      pieces: [stableResultId],
      leaseGeneration: leaseGenerationBeforeDisable! + 1,
    });
    assertEquals(pool.metrics().workersStarted, workersBeforeDisable + 1);
    assertEquals(pool.metrics().crashes, 0);
    const overlaysDropped = loggerCount("execution-overlay-dropped") -
      overlaysDroppedBefore;
    assertEquals(overlaysDropped >= overlaysCreated, true);
    const overlayCountAfterDisable = loggerCount("execution-overlay-created");
    clientCommits.length = 0;
    // Keep the replacement clean in the observation-adoption regression. A
    // disabled-policy run here would queue another candidate behind claim
    // control; re-enable could accept it before the remote observation arrives
    // and turn the race into a false green.
    if (remoteObservationTemplate === undefined) {
      await runSource(9);
      assertEquals(clientCommits.some(isDerivedWireCommit), true);
    }
    assertEquals(
      loggerCount("execution-overlay-created"),
      overlayCountAfterDisable,
    );
    assertEquals(server.listExecutionClaims(space), []);
    assertEquals(pool.metrics().crashes, 0);

    // Re-enable by rotating the live shadow realm once more. For the remote
    // observation race, hold replacement rehydration while the client commit
    // lands so startup must prove the computation before adopting it.
    const workersBeforeReenable = pool.metrics().workersStarted;
    const leaseGenerationBeforeReenable = pool.snapshot(space, "")
      ?.leaseGeneration;
    assertExists(leaseGenerationBeforeReenable);
    if (remoteObservationTemplate !== undefined) {
      server.gateNextSchedulerList();
    }
    const sourceSession = remoteObservationTemplate === undefined
      ? observer
      : await getRaceObserver();
    clientCommits.length = 0;
    const reenable = writePolicy(true);
    let reclaimSeq: number;
    if (remoteObservationTemplate === undefined) {
      await reenable;
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
      await reenable;
      await clientStorage.synced();
      await input.pull();
      await visibleResult.pull();
      await clientRuntime.settled();
      assertEquals(await visibleResult.pull() as unknown, 20);
    }
    assertEquals(pool.snapshot(space, ""), {
      state: "live",
      referenceCount: 1,
      pieces: [stableResultId],
      leaseGeneration: leaseGenerationBeforeReenable + 1,
    });
    assertEquals(pool.metrics().workersStarted, workersBeforeReenable + 1);
    const reclaimEvent = await waitForControl(
      (event): event is Extract<
        ExecutionControlEvent,
        { type: "session.execution.claim.set" }
      > =>
        event.type === "session.execution.claim.set" &&
        event.claim.actionId === claim.actionId &&
        event.claim.claimGeneration > claim.claimGeneration,
      "pool transition replacement claim",
    );
    const reclaimed = reclaimEvent.claim;
    await waitForControl(
      (event): event is Extract<
        ExecutionControlEvent,
        { type: "session.execution.settlement" }
      > =>
        event.type === "session.execution.settlement" &&
        event.settlement.claim.claimGeneration ===
          reclaimed.claimGeneration &&
        event.settlement.inputBasisSeq >= reclaimSeq,
      "pool transition replacement settlement",
    );
    assertEquals(
      reclaimed.leaseGeneration,
      leaseGenerationBeforeReenable + 1,
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
    let firstSourceSeq = Number.POSITIVE_INFINITY;
    let liveClaim: ExecutionClaim | undefined;
    unsubscribeControl = observer.subscribeExecutionControl((event) => {
      events.push(event.type);
      if (event.type === "session.execution.claim.set") {
        liveClaim = event.claim;
        claimed.resolve(event.claim);
      } else if (event.type === "session.execution.settlement") {
        settlements.push(event.settlement);
        if (event.settlement.inputBasisSeq >= firstSourceSeq) {
          firstSettled.resolve(event.settlement);
        }
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

    const firstSource = await observer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: input.sourceURI,
        value: { value: 7 },
      }],
    });
    firstSourceSeq = firstSource.seq;
    const exactClaim = await awaitBarrier(claimed.promise, "claim", events);
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
    // latency. Each lazy replica may either run once or adopt an observation;
    // which replicas do each is timing-dependent, so aggregate enabled versus
    // disabled cardinality is not a stable authority metric. This runner gate
    // instead forbids per-client duplicate work and client-derived writes. CPU
    // sampling is a separate browser measurement because scheduler duration is
    // elapsed time, not CPU time.
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
    assertEquals(
      disabledRuns.every((perClient) => perClient.some((runs) => runs > 0)),
      true,
    );

    // This test drives DenoSpaceExecutorFactory directly, outside the shared
    // pool that normally rotates the shadow lease at the policy boundary.
    // Finish the disabled generation, enable with no live lease, then acquire
    // the exact generation the replacement Worker will use.
    assertExists(executor);
    await executor.stop();
    executor = null;
    await server.flushExecutionLeaseTasks();
    const drainingLease = await server.acquireExecutionLease(space, "");
    assertExists(drainingLease);
    assertEquals(drainingLease.state, "draining");
    assertExists(await server.finishExecutionLeaseDrain(drainingLease));
    await writePolicy(true);
    const rolloutLease = await server.acquireExecutionLease(space, "");
    assertExists(rolloutLease);
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

Deno.test("shared execution pool transitions shadow to claimed and back without migration", async () => {
  await exercisePoolAuthorityTransition();
});

Deno.test("replacement executor resumes shadow discovery before claim promotion", async () => {
  await exercisePoolAuthorityTransition({ replaceShadowWorker: true });
});

Deno.test("replacement executor reruns before adopting a same-window client observation", async () => {
  await exercisePoolAuthorityTransition({
    nestedRoot: true,
    replaceShadowWorker: true,
    sameWindowRemoteObservation: true,
  });
});

Deno.test("replacement executor does not initially rehydrate a raced client observation clean", async () => {
  await exercisePoolAuthorityTransition({
    nestedRoot: true,
    replaceShadowWorker: true,
    initialCleanSnapshotRace: true,
  });
});

Deno.test("replacement executor reruns an initially clean snapshot for claim discovery", async () => {
  await exercisePoolAuthorityTransition({
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
      assertExists(executor);
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
