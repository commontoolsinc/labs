// P0-R3e piece linger (client-passivity plan §5b): a structurally removed
// piece keeps its live graph for the linger window, so ordinary navigation
// churn (remove one page's piece, re-demand it a page later) does not
// re-pay the measured 7-33s instantiation. Authority still fences at
// removal (claims release host-visibly; server-side issuance is
// fail-closed on the missing demand row regardless), and expiry performs
// the ordinary stop. Dial off (every other executor suite) keeps the
// legacy immediate-stop shape byte-identical.
import { assert, assertEquals, assertExists } from "@std/assert";
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

const LINGER_ENV = "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_PIECE_LINGER_MS";

const FLAGS = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: false,
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
      { ...options, memoryHost: new URL("memory://executor-piece-linger") },
      new LoopbackSessionFactory(server, flags),
    );
  }
}

Deno.test("piece linger: a demand blip revives the live graph without re-preparing; expiry re-prepares", async () => {
  Deno.env.set(LINGER_ENV, "60000");
  const principal = await Identity.fromPassphrase(
    `executor piece linger ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const server = new CountingServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-executor-piece-linger" },
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
  let executor:
    | Awaited<ReturnType<DenoSpaceExecutorFactory["start"]>>
    | null = null;

  try {
    const compiled = await seedRuntime.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const tx = seedRuntime.edit();
    const input = seedRuntime.getCell<number>(
      space,
      "piece-linger-input",
      undefined,
      tx,
    );
    input.set(2);
    const root = seedRuntime.getCell<number>(
      space,
      "piece-linger-root",
      undefined,
      tx,
    );
    seedRuntime.run(tx, compiled, { value: input }, root);
    await tx.commit();
    await seedRuntime.idle();
    await seedStorage.synced();

    observerClient = await MemoryClient.connect({
      transport: MemoryClient.loopback(server),
      protocolFlags: FLAGS,
    });
    const observer = await observerClient.mount(space, {}, authorize) as
      & MemoryClient.SpaceSession
      & {
        setExecutionDemand(
          branch: string,
          pieces: readonly string[],
        ): Promise<boolean>;
      };
    await observer.setExecutionDemand("", [root.sourceURI]);
    const lease = await server.acquireExecutionLease(space, "");
    assertExists(lease);

    const factory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: new URL("https://toolshed.example/"),
      patternApiUrl: new URL("https://toolshed.example/"),
      protocolFlags: FLAGS,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
    });
    const crashes: unknown[] = [];
    executor = await factory.start({
      space,
      branch: "",
      lease,
      pieces: [root.sourceURI],
      onCrash: (error) => crashes.push(error),
    });
    await executor.settle();
    const preparedOnce = server.writerLookupCount;
    assert(preparedOnce > 0, "initial activation performs writer lookups");

    // Demand blip inside the linger window: remove, then re-add. Revival
    // must not re-run prepare (writer lookups stay flat).
    await executor.setDemand([], undefined);
    await executor.setDemand([root.sourceURI], undefined);
    await executor.settle();
    assertEquals(
      server.writerLookupCount,
      preparedOnce,
      "a lingered piece revives without re-preparing",
    );

    // Expiry: shrink the window, remove, outlast it — the ordinary stop
    // runs, so the next re-demand re-prepares (writer lookups grow).
    Deno.env.set(LINGER_ENV, "250");
    await executor.setDemand([], undefined);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await executor.setDemand([root.sourceURI], undefined);
    await executor.settle();
    assert(
      server.writerLookupCount > preparedOnce,
      "an expired linger stops the piece; re-demand re-prepares",
    );
  } finally {
    Deno.env.delete(LINGER_ENV);
    await executor?.stop();
    await observerClient?.close();
    await seedRuntime.dispose();
    await seedStorage.close();
    await server.close();
  }
});
