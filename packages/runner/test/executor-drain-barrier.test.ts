import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import type {
  BranchName,
  ExecutionLease,
  MemoryProtocolFlags,
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
      { ...options, memoryHost: new URL("memory://executor-drain-barrier") },
      new LoopbackSessionFactory(server, flags),
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
