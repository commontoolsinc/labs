import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import type {
  ClientCommit,
  ExecutionClaim,
  ExecutionControlEvent,
  MemoryProtocolFlags,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { parseClientMessage, Server } from "@commonfabric/memory/v2/server";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import type { ActionTransactionRouteInput } from "../src/storage/v2.ts";
import { StorageManager as EmulatedStorageManager } from "../src/storage/cache.deno.ts";
import {
  createHostProviderChannel,
  type HostProviderChannel,
} from "../src/storage/v2-host-provider.ts";
import { DenoSpaceExecutorFactory } from "../src/executor/deno-space-executor.ts";
import {
  SharedExecutionPool,
  type SpaceExecutor,
  type SpaceExecutorFactory,
} from "../src/executor/shared-execution-pool.ts";
import {
  classifyStaticActionServability,
} from "../src/scheduler/servability.ts";
import type { SchedulerActionObservation } from "../src/scheduler/persistent-observation.ts";

const FLAGS = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
} as const satisfies Partial<MemoryProtocolFlags>;

const PACKAGES_ROOT = join(import.meta.dirname!, "../..");

type ProductCase = {
  readonly name: string;
  readonly sourcePath: string;
  readonly resolverRoot: string;
  readonly inputName: string;
  readonly initialValue: unknown;
  readonly warmValue: unknown;
  readonly measuredValue: unknown;
};

const PRODUCT_CASES: readonly ProductCase[] = [{
  name: "lunch-poll",
  sourcePath: join(
    import.meta.dirname!,
    "fixtures/server-execution-lunch-poll-product.tsx",
  ),
  resolverRoot: PACKAGES_ROOT,
  inputName: "voteCount",
  initialValue: 0,
  warmValue: 1,
  measuredValue: 2,
}, {
  name: "group-chat",
  sourcePath: join(
    import.meta.dirname!,
    "fixtures/server-execution-group-chat-product.tsx",
  ),
  resolverRoot: PACKAGES_ROOT,
  inputName: "roomCount",
  initialValue: 0,
  warmValue: 1,
  measuredValue: 2,
}];

class LoopbackSessionFactory implements SessionFactory {
  constructor(
    private readonly server: Server,
    private readonly onCommit?: (commit: ClientCommit) => void,
  ) {}

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    const client = await MemoryClient.connect({
      transport: MemoryClient.loopback(this.server),
      protocolFlags: FLAGS,
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
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
    onCommit?: (commit: ClientCommit) => void,
  ): LoopbackStorageManager {
    return new LoopbackStorageManager(
      { ...options, memoryHost: new URL("memory://product-rollout") },
      new LoopbackSessionFactory(server, onCommit),
    );
  }
}

const waitWithin = async <T>(
  promise: Promise<T>,
  label: string,
  events: readonly string[],
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out: ${events.join(" | ")}`)),
          20_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const covers = (
  envelope: IMemorySpaceAddress,
  address: IMemorySpaceAddress,
): boolean =>
  envelope.space === address.space && envelope.id === address.id &&
  (envelope.scope ?? "space") === (address.scope ?? "space") &&
  envelope.path.length <= address.path.length &&
  envelope.path.every((part, index) => part === address.path[index]);

const valueAtPath = (value: unknown, path: readonly string[]): unknown => {
  let current = value;
  for (const part of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

const rawAddressToLink = (
  address: IMemorySpaceAddress,
): NormalizedFullLink => ({
  space: address.space,
  id: address.id as URI,
  scope: address.scope ?? "space",
  path: address.path[0] === "value" ? address.path.slice(1) : [...address.path],
});

type SeededProduct = {
  readonly program: RuntimeProgram;
  readonly resultLink: NormalizedFullLink;
  readonly sourceLink: NormalizedFullLink;
  readonly actionId: string;
  readonly targetLink: NormalizedFullLink;
  readonly initialTargetValue: unknown;
};

async function seedProduct(
  product: ProductCase,
  principal: Signer,
  server: Server,
): Promise<SeededProduct> {
  const space = principal.did();
  const commits: ClientCommit[] = [];
  const storage = LoopbackStorageManager.connectTo(
    server,
    { as: principal },
    (commit) => commits.push(commit),
  );
  const runtime = new Runtime({
    apiUrl: new URL("https://toolshed.example/"),
    patternEnvironment: { apiUrl: new URL("https://toolshed.example/") },
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
  });
  try {
    const program = await runtime.harness.resolve(
      new FileSystemProgramResolver(product.sourcePath, product.resolverRoot),
    );
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
    });
    const tx = runtime.edit();
    const source = runtime.getCell<unknown>(
      space,
      `server-execution-${product.name}-${product.inputName}`,
      undefined,
      tx,
    );
    source.set(product.initialValue);
    const result = runtime.getCell<unknown>(
      space,
      `server-execution-${product.name}-result`,
      undefined,
      tx,
    );
    const resultLink = result.getAsNormalizedFullLink();
    const inputBindings: Record<string, unknown> = {
      [product.inputName]: source,
    };
    const handle = runtime.run(
      tx,
      compiled,
      inputBindings,
      result,
    );
    runtime.prepareTxForCommit(tx);
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    await runtime.settled();
    await storage.synced();

    // Select from the actions that actually re-ran for this product input,
    // instead of guessing through nested argument/result redirect documents.
    // This update is excluded from the measured shared-pool invalidation.
    commits.length = 0;
    const selectionTx = runtime.edit();
    source.withTx(selectionTx).set(product.warmValue);
    runtime.prepareTxForCommit(selectionTx);
    assertEquals((await selectionTx.commit()).error, undefined);
    await handle.pull();
    await runtime.settled();
    await storage.synced();

    const observations = commits.flatMap((commit) => {
      const observation = commit.schedulerObservation;
      return typeof observation === "object" && observation !== null &&
          !Array.isArray(observation) &&
          (observation as { transactionKind?: unknown }).transactionKind ===
            "action-run"
        ? [observation as SchedulerActionObservation]
        : [];
    }).filter((observation) =>
      observation.actionKind === "computation" &&
      observation.completeActionScopeSummary !== undefined &&
      classifyStaticActionServability(observation, space).status ===
        "claim-ready"
    ).sort((left, right) => left.actionId.localeCompare(right.actionId));
    assertEquals(
      observations.length,
      1,
      `${product.name} fixture must have one claim-ready computation`,
    );

    let selected:
      | {
        observation: SchedulerActionObservation;
        target: IMemorySpaceAddress;
        value: unknown;
      }
      | undefined;
    for (const observation of observations) {
      for (const target of observation.actualChangedWrites) {
        if (
          !observation.completeActionScopeSummary!.directOutputs.some(
            (output) => covers(output, target),
          )
        ) continue;
        const document = await server.readDocument(space, target.id);
        const value = valueAtPath(document, target.path);
        if (value !== undefined) {
          selected = { observation, target, value };
          break;
        }
      }
      if (selected !== undefined) break;
    }
    assertExists(
      selected,
      `${product.name} claim-ready computation had no changed direct output`,
    );
    return {
      program,
      resultLink,
      sourceLink: source.getAsNormalizedFullLink(),
      actionId: selected.observation.actionId,
      targetLink: rawAddressToLink(selected.target),
      initialTargetValue: selected.value,
    };
  } finally {
    await runtime.dispose();
  }
}

type ProviderMessage = {
  type?: unknown;
  payload?: unknown;
};

function instrumentProviderPort(
  hostPort: MessagePort,
  commits: ClientCommit[],
): { port: MessagePort; dispose(): void } {
  const relay = new MessageChannel();
  const relayHost = relay.port1;
  relayHost.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data as ProviderMessage;
    if (message.type === "memory" && typeof message.payload === "string") {
      const parsed = parseClientMessage(message.payload);
      if (parsed?.type === "transact") {
        commits.push(structuredClone(parsed.commit));
      }
    }
    hostPort.postMessage(event.data);
  });
  hostPort.addEventListener("message", (event: MessageEvent<unknown>) => {
    relayHost.postMessage(event.data);
  });
  relayHost.start();
  hostPort.start();
  return {
    port: relay.port2,
    dispose() {
      relayHost.close();
      hostPort.close();
    },
  };
}

class ProductClientWorker {
  readonly #worker: Worker;
  readonly #channel: HostProviderChannel;
  readonly #relay: ReturnType<typeof instrumentProviderPort>;
  readonly #pending = new Map<
    number,
    PromiseWithResolvers<Record<string, unknown>>
  >();
  readonly #booted = Promise.withResolvers<void>();
  #nextRequestId = 0;

  private constructor(
    worker: Worker,
    channel: HostProviderChannel,
    relay: ReturnType<typeof instrumentProviderPort>,
    readonly commits: ClientCommit[],
  ) {
    this.#worker = worker;
    this.#channel = channel;
    this.#relay = relay;
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      const message = event.data as {
        type?: string;
        requestId?: number;
        ok?: Record<string, unknown>;
        error?: string;
      };
      if (message.type === "booted") {
        this.#booted.resolve();
        return;
      }
      if (
        message.type !== "response" ||
        !Number.isSafeInteger(message.requestId)
      ) return;
      const pending = this.#pending.get(message.requestId!);
      if (pending === undefined) return;
      this.#pending.delete(message.requestId!);
      if (typeof message.error === "string") {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.ok ?? {});
      }
    });
    worker.addEventListener("error", (event) => {
      const error = event.error ?? new Error(event.message);
      this.#booted.reject(error);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  static async start(options: {
    server: Server;
    principal: MemorySpace;
    space: MemorySpace;
    clientId: string;
    program: RuntimeProgram;
    resultLink: NormalizedFullLink;
    targetLink: NormalizedFullLink;
    authorizeSessionOpen: MemoryClient.SessionOpenAuthFactory;
  }): Promise<ProductClientWorker> {
    const channel = createHostProviderChannel({
      server: options.server,
      space: options.space,
      authorizeSessionOpen: options.authorizeSessionOpen,
      allowExecutionDemand: true,
    });
    const commits: ClientCommit[] = [];
    const relay = instrumentProviderPort(channel.port, commits);
    const worker = new Worker(
      new URL(
        "./fixtures/server-execution-product-client.ts",
        import.meta.url,
      ).href,
      { type: "module", name: options.clientId },
    );
    const client = new ProductClientWorker(worker, channel, relay, commits);
    await waitWithin(client.#booted.promise, `${options.clientId} boot`, []);
    const requestId = ++client.#nextRequestId;
    const pending = Promise.withResolvers<Record<string, unknown>>();
    client.#pending.set(requestId, pending);
    worker.postMessage({
      type: "init",
      requestId,
      port: relay.port,
      principal: options.principal,
      space: options.space,
      clientId: options.clientId,
      program: options.program,
      resultLink: options.resultLink,
      targetLink: options.targetLink,
      protocolFlags: FLAGS,
    }, [relay.port]);
    await waitWithin(pending.promise, `${options.clientId} init`, []);
    return client;
  }

  request(
    type: "reset" | "measure",
    claim: ExecutionClaim,
  ): Promise<Record<string, unknown>> {
    const requestId = ++this.#nextRequestId;
    const pending = Promise.withResolvers<Record<string, unknown>>();
    this.#pending.set(requestId, pending);
    this.#worker.postMessage({
      type,
      requestId,
      actionId: claim.actionId,
      claim,
    });
    return pending.promise;
  }

  async dispose(): Promise<void> {
    const requestId = ++this.#nextRequestId;
    const pending = Promise.withResolvers<Record<string, unknown>>();
    this.#pending.set(requestId, pending);
    this.#worker.postMessage({ type: "dispose", requestId });
    await pending.promise.catch(() => undefined);
    this.#worker.terminate();
    this.#relay.dispose();
    await this.#channel.dispose();
  }
}

const isExactDerivedCommit = (
  commit: ClientCommit,
  actionId: string,
): boolean => {
  const observation = commit.schedulerObservation as
    | { actionId?: unknown; actionKind?: unknown }
    | undefined;
  return observation?.actionId === actionId &&
    observation.actionKind === "computation" && commit.operations.length > 0;
};

for (const product of PRODUCT_CASES) {
  Deno.test(`${product.name} uses one shared server action attempt for three client demands`, async () => {
    const principal = await Identity.fromPassphrase(
      `server execution rollout ${product.name} ${crypto.randomUUID()}`,
    );
    const space = principal.did();
    const server = new Server({
      authorizeSessionOpen(message) {
        const value = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof value === "string" ? value : undefined;
      },
      sessionOpenAuth: {
        audience: "did:key:z6Mk-server-execution-product-rollout",
      },
      protocolFlags: FLAGS,
      acl: { mode: "off", serviceDids: [space] },
    });
    const authorizeSessionOpen: MemoryClient.SessionOpenAuthFactory = (
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
    const clients: ProductClientWorker[] = [];
    let observerClient: MemoryClient.Client | undefined;
    let pool: SharedExecutionPool | undefined;
    let unsubscribeControl = () => {};
    const events: string[] = [];
    try {
      const seeded = await seedProduct(product, principal, server);
      observerClient = await MemoryClient.connect({
        transport: MemoryClient.loopback(server),
        protocolFlags: FLAGS,
      });
      const observer = await observerClient.mount(
        space,
        { sessionId: `product-observer:${product.name}` },
        authorizeSessionOpen,
      );
      await observer.watchSet([{
        id: `product-rollout-watch:${product.name}`,
        kind: "graph",
        query: {
          roots: [{
            id: seeded.resultLink.id,
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
        events.push(
          event.type === "session.execution.settlement"
            ? `settlement:${event.settlement.claim.actionId}:` +
              `${event.settlement.inputBasisSeq}:${event.settlement.outcome}`
            : event.type,
        );
        for (const listener of controlListeners) listener(event);
      });
      const waitForControl = <T extends ExecutionControlEvent>(
        predicate: (event: ExecutionControlEvent) => event is T,
      ): Promise<T> => {
        const existing = controlEvents.find(predicate);
        if (existing !== undefined) return Promise.resolve(existing);
        const pending = Promise.withResolvers<T>();
        const listener = (event: ExecutionControlEvent) => {
          if (!predicate(event)) return;
          controlListeners.delete(listener);
          pending.resolve(event);
        };
        controlListeners.add(listener);
        return pending.promise;
      };

      await observer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}:execution-policy`,
          value: { value: { version: 1, serverPrimaryExecution: true } },
        }],
      });

      const denoFactory = new DenoSpaceExecutorFactory({
        server,
        apiUrl: new URL("https://toolshed.example/"),
        patternApiUrl: new URL("https://toolshed.example/"),
        protocolFlags: FLAGS,
        experimental: {
          persistentSchedulerState: true,
          serverPrimaryExecution: true,
        },
        onCandidateClaim(candidate) {
          events.push(`candidate:${candidate.claimKey.actionId}`);
        },
        onCandidateDiagnostic(diagnostic) {
          events.push(
            `diagnostic:${diagnostic.claimKey?.actionId ?? "ownerless"}:` +
              diagnostic.diagnosticCode,
          );
        },
      });
      let liveExecutor: SpaceExecutor | undefined;
      const trackingFactory: SpaceExecutorFactory = {
        async start(options) {
          liveExecutor = await denoFactory.start({
            ...options,
            onCrash(error) {
              events.push(`crash:${String(error)}`);
              options.onCrash(error);
            },
          });
          return liveExecutor;
        },
      };
      pool = new SharedExecutionPool({
        control: server,
        factory: trackingFactory,
        settleTimeoutMs: 20_000,
      });
      pool.start();

      for (let index = 0; index < 3; index++) {
        clients.push(
          await ProductClientWorker.start({
            server,
            principal: space,
            space,
            clientId: `product-${product.name}-client-${index}`,
            program: seeded.program,
            resultLink: seeded.resultLink,
            targetLink: seeded.targetLink,
            authorizeSessionOpen,
          }),
        );
      }
      await pool.idle();
      assertEquals(pool.metrics().activeWorkers, 1);
      assertEquals(pool.metrics().activeDemands, 3);
      assertEquals(pool.snapshot(space, "")?.referenceCount, 3);
      assertExists(liveExecutor);

      let localSeq = 1;
      const writeSource = async (value: unknown) => {
        const current = await server.readDocument(
          space,
          seeded.sourceLink.id,
        ) ?? {};
        return await observer.transact({
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: seeded.sourceLink.id,
            value: {
              ...(current as Record<string, unknown>),
              value: value as FabricValue,
            },
          }],
        });
      };
      // The first invalidation publishes the shadow attempt that establishes
      // the claim. A claim only governs subsequent attempts, so use a second,
      // excluded warm invalidation before measuring the next one.
      await writeSource(product.initialValue);
      await liveExecutor.settle();
      await liveExecutor.wake();
      await liveExecutor.settle();
      const claimEvent = await waitWithin(
        waitForControl((event): event is Extract<
          ExecutionControlEvent,
          { type: "session.execution.claim.set" }
        > =>
          event.type === "session.execution.claim.set" &&
          event.claim.actionId === seeded.actionId
        ),
        `${product.name} selected claim`,
        events,
      );
      const claim = claimEvent.claim;
      const exactSettlement = (
        event: ExecutionControlEvent,
        sourceSeq: number,
      ): event is Extract<
        ExecutionControlEvent,
        { type: "session.execution.settlement" }
      > =>
        event.type === "session.execution.settlement" &&
        event.settlement.claim.actionId === claim.actionId &&
        event.settlement.claim.leaseGeneration === claim.leaseGeneration &&
        event.settlement.claim.claimGeneration === claim.claimGeneration &&
        event.settlement.inputBasisSeq >= sourceSeq;

      const warmSource = await writeSource(product.warmValue);
      await liveExecutor.settle();
      await liveExecutor.wake();
      await liveExecutor.settle();
      const warmMeasurements = Promise.all(
        clients.map((client) => client.request("measure", claim)),
      );
      await waitWithin(
        waitForControl((event): event is Extract<
          ExecutionControlEvent,
          { type: "session.execution.settlement" }
        > => exactSettlement(event, warmSource.seq)),
        `${product.name} warm settlement`,
        events,
      );
      const warmResults = await warmMeasurements;
      for (const measurement of warmResults) {
        assertEquals(measurement.claimIntegrated, true);
      }
      await liveExecutor.settle();

      for (const client of clients) {
        client.commits.length = 0;
        await client.request("reset", claim);
      }
      const settlementStart = controlEvents.length;
      const acceptedAttemptsBefore = server.executionStats
        .acceptedActionAttempts;
      const measuredSource = await writeSource(product.measuredValue);
      const measurementsPromise = Promise.all(
        clients.map((client) => client.request("measure", claim)),
      );
      await liveExecutor.settle();
      await liveExecutor.wake();
      await liveExecutor.settle();
      const measuredSettlement = await waitWithin(
        waitForControl((event): event is Extract<
          ExecutionControlEvent,
          { type: "session.execution.settlement" }
        > => exactSettlement(event, measuredSource.seq)),
        `${product.name} measured settlement`,
        events,
      );
      await liveExecutor.settle();
      await pool.idle();
      const measurements = await measurementsPromise;

      const exactSettlements = controlEvents.slice(settlementStart).filter(
        (event): event is Extract<
          ExecutionControlEvent,
          { type: "session.execution.settlement" }
        > => exactSettlement(event, measuredSource.seq),
      );
      assertEquals(exactSettlements.length, 1);
      assertEquals(
        exactSettlements[0].settlement,
        measuredSettlement.settlement,
      );
      assert(
        measuredSettlement.settlement.outcome === "committed" ||
          measuredSettlement.settlement.outcome === "no-op",
      );
      assertEquals(
        server.executionStats.acceptedActionAttempts - acceptedAttemptsBefore,
        1,
      );
      for (const client of clients) {
        assertEquals(
          client.commits.filter((commit) =>
            isExactDerivedCommit(commit, seeded.actionId)
          ),
          [],
        );
      }

      const targetDocument = await server.readDocument(
        space,
        seeded.targetLink.id,
      );
      const durableValue = valueAtPath(targetDocument, [
        "value",
        ...seeded.targetLink.path,
      ]);
      assert(
        !Object.is(durableValue, seeded.initialTargetValue),
        `${product.name} measured invalidation did not change the target`,
      );
      for (const measurement of measurements) {
        assertEquals(measurement.claimIntegrated, true);
        assertEquals(measurement.upstream, 0);
        assertEquals(measurement.value, durableValue);
        assertEquals(
          typeof measurement.runs === "number" && measurement.runs <= 1,
          true,
        );
      }
    } finally {
      unsubscribeControl();
      for (const client of clients) await client.dispose();
      await pool?.idle().catch(() => undefined);
      await pool?.close().catch(() => undefined);
      await observerClient?.close().catch(() => undefined);
      await server.close();
    }
  });
}

const PARITY_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { pattern, computed, Writable } from 'commonfabric';",
      "export default pattern<{ value: Writable<number> }>(({ value }) => ({",
      "  doubled: computed(() => value.get() * 2),",
      "}));",
    ].join("\n"),
  }],
};

type ParityCase = {
  readonly name: string;
  readonly scope: "space" | "user" | "session";
  readonly crossSpace: boolean;
  readonly expectedStatus: "claim-ready" | "unservable";
};

const PARITY_CASES: readonly ParityCase[] = [{
  name: "unclaimed",
  scope: "space",
  crossSpace: false,
  expectedStatus: "claim-ready",
}, {
  name: "per-user",
  scope: "user",
  crossSpace: false,
  expectedStatus: "unservable",
}, {
  name: "per-session",
  scope: "session",
  crossSpace: false,
  expectedStatus: "unservable",
}, {
  name: "cross-space",
  scope: "space",
  crossSpace: true,
  expectedStatus: "unservable",
}];

type ParityRun = {
  readonly initial: unknown;
  readonly updated: unknown;
  readonly status: string;
  readonly clientDerivedCommits: number;
};

async function runParityCase(
  testCase: ParityCase,
  serverPrimaryExecution: boolean,
): Promise<ParityRun> {
  const principal = await Identity.fromPassphrase(
    `execution parity ${testCase.name} ${serverPrimaryExecution}`,
  );
  const ownerSpace = principal.did();
  const foreign = await Identity.fromPassphrase(
    `execution parity foreign ${testCase.name} ${serverPrimaryExecution}`,
  );
  const sourceSpace = testCase.crossSpace ? foreign.did() : ownerSpace;
  const commits: ClientCommit[] = [];
  const storage = EmulatedStorageManager.emulate({
    as: principal,
    actionTransactionRouter(input: ActionTransactionRouteInput) {
      commits.push(structuredClone(input.commit));
      return { disposition: "upstream" };
    },
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution,
    },
  });
  try {
    const compiled = await runtime.patternManager.compilePattern(
      PARITY_PROGRAM,
      { space: ownerSpace },
    );
    const sourceTx = runtime.edit();
    const source = runtime.getCell<number>(
      sourceSpace,
      `parity-source-${testCase.name}`,
      undefined,
      sourceTx,
      testCase.scope,
    );
    source.set(2);
    runtime.prepareTxForCommit(sourceTx);
    assertEquals((await sourceTx.commit()).error, undefined);

    const tx = runtime.edit();
    const result = runtime.getCell<{ doubled: number }>(
      ownerSpace,
      `parity-result-${testCase.name}`,
      undefined,
      tx,
    );
    const handle = runtime.run(tx, compiled, { value: source }, result);
    runtime.prepareTxForCommit(tx);
    assertEquals((await tx.commit()).error, undefined);
    const initial = JSON.parse(JSON.stringify(await handle.pull()));
    await runtime.settled();

    const observation = commits.map((commit) => commit.schedulerObservation)
      .find((candidate): candidate is SchedulerActionObservation =>
        typeof candidate === "object" && candidate !== null &&
        !Array.isArray(candidate) &&
        (candidate as { actionKind?: unknown }).actionKind === "computation" &&
        (candidate as { completeActionScopeSummary?: unknown })
            .completeActionScopeSummary !== undefined
      );
    assertExists(observation);
    const status = classifyStaticActionServability(
      observation,
      ownerSpace,
    ).status;

    commits.length = 0;
    const update = runtime.edit();
    source.withTx(update).set(3);
    runtime.prepareTxForCommit(update);
    assertEquals((await update.commit()).error, undefined);
    const updated = JSON.parse(JSON.stringify(await handle.pull()));
    await runtime.settled();
    return {
      initial,
      updated,
      status,
      clientDerivedCommits: commits.filter((commit) => {
        const candidate = commit.schedulerObservation as
          | { actionKind?: unknown }
          | undefined;
        return candidate?.actionKind === "computation" &&
          commit.operations.length > 0;
      }).length,
    };
  } finally {
    await runtime.dispose();
  }
}

Deno.test("unclaimed, scoped, and cross-space client execution has flag-off parity", async () => {
  for (const testCase of PARITY_CASES) {
    const disabled = await runParityCase(testCase, false);
    const enabled = await runParityCase(testCase, true);
    assertEquals(enabled.initial, disabled.initial, `${testCase.name} initial`);
    assertEquals(enabled.updated, disabled.updated, `${testCase.name} updated`);
    assertEquals(enabled.updated, { doubled: 6 });
    assertEquals(enabled.status, testCase.expectedStatus, testCase.name);
    assertEquals(disabled.clientDerivedCommits > 0, true, testCase.name);
    assertEquals(enabled.clientDerivedCommits, disabled.clientDerivedCommits);
  }
});
