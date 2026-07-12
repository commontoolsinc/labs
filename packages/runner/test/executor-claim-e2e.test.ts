import { assertEquals, assertExists } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import type {
  ActionSettlement,
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

const BUILTIN_FLAGS = {
  ...FLAGS,
  serverPrimaryExecutionBuiltinPassivityV1: true,
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
      { ...options, memoryHost: new URL("memory://executor-claim-e2e") },
      new LoopbackSessionFactory(server, flags),
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
      apiUrl: new URL(import.meta.url),
      patternApiUrl: new URL(import.meta.url),
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
      protocolFlags: FLAGS,
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
  } finally {
    unsubscribeAccepted();
    unsubscribeControl();
    unsubscribeNoOp();
    await executor?.stop();
    await seedRuntime.dispose();
    await seedStorage.close();
    await observerClient?.close();
    await server.close();
  }
});

Deno.test("claimed fetch and generate builtins execute once through the host broker and persist async results", async () => {
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
  const events: string[] = [];
  const brokerRequests: ServerBuiltinFetchRequest[] = [];
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
      protocolFlags: BUILTIN_FLAGS,
      createBuiltinBroker: () => ({
        fetch(request) {
          events.push(`broker:${request.url}`);
          brokerRequests.push(request);
          const response = request.url.startsWith("/api/ai/llm")
            ? Response.json({
              role: "assistant",
              content: "generated response",
              id: "server-generate-e2e",
            })
            : new Response("server response");
          return Promise.resolve({
            response,
            finalUrl: new URL(request.url, servingOrigin),
            redirectCount: 0,
          });
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
  } finally {
    unsubscribeAccepted();
    await executor?.stop();
    await seedRuntime.dispose();
    await seedStorage.close();
    await observerClient?.close();
    await server.close();
  }
});
