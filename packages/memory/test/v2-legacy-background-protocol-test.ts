import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { toFileUrl } from "@std/path";
import * as MemoryClient from "../v2/client.ts";
import { parseClientMessage, Server } from "../v2/server.ts";
import { encodeMemoryBoundary } from "../v2.ts";

const SPACE = "did:key:z6Mk-legacy-background-protocol-space";
const SERVICE = "did:key:z6Mk-legacy-background-protocol-service";
const WRITER = "did:key:z6Mk-legacy-background-protocol-writer";
const flags = {
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
} as const;

const authFactoryFor = (
  principal: string,
): MemoryClient.SessionOpenAuthFactory =>
(_space, _session, context) => ({
  invocation: {
    aud: context.audience,
    challenge: context.challenge.value,
  },
  authorization: { principal },
});

const createServer = (
  store: URL,
  enabled = true,
  nowMs: () => number = () => Date.now(),
): Server =>
  new Server(
    {
      store,
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: {
        audience: "did:key:z6Mk-legacy-background-protocol-server",
      },
      protocolFlags: {
        ...flags,
        serverPrimaryExecutionV1: enabled,
      },
      acl: { mode: "off", serviceDids: [SERVICE] },
      executionControl: {
        hostId: "host:legacy-background-protocol",
        nowMs,
        leaseTtlMs: 1_000,
        drainTimeoutMs: 100,
      },
    } as ConstructorParameters<typeof Server>[0],
  );

const connect = async (server: Server): Promise<MemoryClient.Client> =>
  await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: flags,
    executionCapabilities: { routing: true, builtinPassivity: true },
  } as MemoryClient.ConnectOptions);

Deno.test("only a configured service session controls background exclusion", async () => {
  const directory = await Deno.makeTempDir();
  let nowMs = 100;
  const server = createServer(toFileUrl(`${directory}/`), true, () => nowMs);
  const serviceClient = await connect(server);
  const writerClient = await connect(server);
  const service = await serviceClient.mount(
    SPACE,
    {},
    authFactoryFor(SERVICE),
  );
  const writer = await writerClient.mount(
    SPACE,
    {},
    authFactoryFor(WRITER),
  );
  try {
    await assertRejects(
      () => writer.acquireLegacyBackgroundExclusion(""),
      Error,
      "service principal",
    );

    const acquired = await service.acquireLegacyBackgroundExclusion("");
    assertExists(acquired);
    assertEquals(acquired.serverTime, 100);
    assertEquals(acquired.ready, true);
    assertEquals(acquired.exclusion.exclusionGeneration, 1);
    assertEquals(acquired.exclusion.servicePrincipal, SERVICE);
    assertEquals(await server.legacyBackgroundActive(SPACE, ""), true);

    nowMs = 200;
    const renewed = await service.renewLegacyBackgroundExclusion("", 1);
    assertExists(renewed);
    assertEquals(renewed.serverTime, 200);
    assertEquals(renewed.exclusion.expiresAt, 1_200);
    assertEquals(
      await service.releaseLegacyBackgroundExclusion("", 2),
      null,
    );
    const released = await service.releaseLegacyBackgroundExclusion("", 1);
    assertExists(released);
    assertEquals(released.expiresAt, 200);
    assertEquals(await server.legacyBackgroundActive(SPACE, ""), false);
  } finally {
    await writerClient.close();
    await serviceClient.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("background exclusion parser rejects caller-selected authority", () => {
  assertEquals(
    parseClientMessage(encodeMemoryBoundary({
      type: "session.execution.legacy-background.acquire",
      requestId: "request:acquire",
      space: SPACE,
      sessionId: "session:service",
      branch: "branch:one",
    })),
    {
      type: "session.execution.legacy-background.acquire",
      requestId: "request:acquire",
      space: SPACE,
      sessionId: "session:service",
      branch: "branch:one",
    },
  );
  for (
    const injected of [
      { holderId: "attacker" },
      { servicePrincipal: "did:key:attacker" },
      { exclusionGeneration: 1 },
    ]
  ) {
    assertEquals(
      parseClientMessage(encodeMemoryBoundary({
        type: "session.execution.legacy-background.acquire",
        requestId: "request:spoof",
        space: SPACE,
        sessionId: "session:service",
        branch: "",
        ...injected,
      })),
      null,
    );
  }
  assertEquals(
    parseClientMessage(encodeMemoryBoundary({
      type: "session.execution.legacy-background.renew",
      requestId: "request:renew",
      space: SPACE,
      sessionId: "session:service",
      branch: "",
      exclusionGeneration: 0,
    })),
    null,
  );
});

Deno.test("resumed service session renews its exact exclusion", async () => {
  const directory = await Deno.makeTempDir();
  let nowMs = 100;
  const server = createServer(toFileUrl(`${directory}/`), true, () => nowMs);
  const firstClient = await connect(server);
  const first = await firstClient.mount(
    SPACE,
    {},
    authFactoryFor(SERVICE),
  );
  let resumedClient: MemoryClient.Client | undefined;
  try {
    const acquired = await first.acquireLegacyBackgroundExclusion("");
    assertExists(acquired);
    assertExists(first.sessionToken);
    const resume = {
      sessionId: first.sessionId,
      sessionToken: first.sessionToken,
    };
    await firstClient.close();

    resumedClient = await connect(server);
    const resumed = await resumedClient.mount(
      SPACE,
      resume,
      authFactoryFor(SERVICE),
    );
    nowMs = 200;
    const renewed = await resumed.renewLegacyBackgroundExclusion("", 1);
    assertExists(renewed);
    assertEquals(renewed.exclusion.exclusionGeneration, 1);
    assertEquals(renewed.exclusion.expiresAt, 1_200);
  } finally {
    await resumedClient?.close();
    await firstClient.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("flag-off client preserves legacy background behavior", async () => {
  const directory = await Deno.makeTempDir();
  const server = createServer(toFileUrl(`${directory}/`), false);
  const client = await connect(server);
  const session = await client.mount(SPACE, {}, authFactoryFor(SERVICE));
  try {
    assertEquals(
      await session.acquireLegacyBackgroundExclusion(""),
      undefined,
    );
  } finally {
    await client.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});
