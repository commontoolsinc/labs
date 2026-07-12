import {
  assertEquals,
  assertRejects,
} from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const POLICY_SPACE = "did:key:z6Mk-server-execution-policy-space";

type ExecutionClientOptions = MemoryClient.ConnectOptions & {
  protocolFlags?: { serverPrimaryExecutionV1?: boolean };
  executionCapabilities?: {
    routing?: boolean;
    builtinPassivity?: boolean;
  };
};

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(branch: string, pieces: readonly string[]): Promise<
    boolean
  >;
};

type AuthenticatedExecutionDemand = {
  space: string;
  branch: string;
  sessionId: string;
  connectionId: string;
  principal: string;
  pieces: readonly string[];
};

type ExecutionServer = Server & {
  listExecutionDemands(
    space: string,
    branch: string,
  ): readonly AuthenticatedExecutionDemand[];
};

const createServer = (
  name: string,
  serverPrimaryExecutionV1: boolean,
): ExecutionServer =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://${name}`),
    protocolFlags: { serverPrimaryExecutionV1 },
  } as ConstructorParameters<typeof Server>[0]) as ExecutionServer;

const connectClient = async (
  server: Server,
  serverPrimaryExecutionV1: boolean,
): Promise<MemoryClient.Client> =>
  await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: { serverPrimaryExecutionV1 },
    executionCapabilities: {
      routing: true,
      builtinPassivity: true,
    },
  } as ExecutionClientOptions);

const mount = async (
  client: MemoryClient.Client,
  space = POLICY_SPACE,
): Promise<ExecutionSession> =>
  await client.mount(
    space,
    {},
    testSessionOpenAuthFactory,
  ) as ExecutionSession;

const setPolicy = async (
  session: MemoryClient.SpaceSession,
  enabled: boolean,
): Promise<void> => {
  await session.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: `of:${session.space}:execution-policy`,
      value: {
        value: { version: 1, serverPrimaryExecution: enabled },
      },
    }],
  });
};

Deno.test("enabled execution policy rejects a stale client but disabled policy does not", async () => {
  const server = createServer(
    "memory-v2-execution-policy-capability",
    true,
  );
  const capable = await connectClient(server, true);
  const owner = await mount(capable);
  try {
    await setPolicy(owner, true);

    const stale = await connectClient(server, false);
    try {
      await assertRejects(
        () => mount(stale),
        Error,
        "requires memory capability server-primary-execution-v1",
      );
    } finally {
      await stale.close();
    }

    await owner.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${owner.space}:execution-policy`,
        value: {
          value: { version: 1, serverPrimaryExecution: false },
        },
      }],
    });

    const legacy = await connectClient(server, false);
    try {
      const session = await mount(legacy);
      assertEquals(session.space, POLICY_SPACE);
    } finally {
      await legacy.close();
    }
  } finally {
    await capable.close();
    await server.close();
  }
});

Deno.test("flag off is a rollback even when execution policy remains enabled", async () => {
  const server = createServer("memory-v2-execution-policy-rollback", false);
  const legacy = await connectClient(server, false);
  try {
    const owner = await mount(legacy);
    await setPolicy(owner, true);

    const second = await connectClient(server, false);
    try {
      const session = await mount(second);
      assertEquals(session.space, POLICY_SPACE);
    } finally {
      await second.close();
    }
  } finally {
    await legacy.close();
    await server.close();
  }
});

Deno.test("execution demand is connection-owned and reference-counted", async () => {
  const server = createServer("memory-v2-execution-demand", true);
  const firstClient = await connectClient(server, true);
  const secondClient = await connectClient(server, true);
  const first = await mount(firstClient);
  const second = await mount(secondClient);
  try {
    assertEquals(await first.setExecutionDemand("feature", ["piece:one"]), true);
    assertEquals(
      await second.setExecutionDemand("feature", ["piece:one"]),
      true,
    );

    const both = server.listExecutionDemands(POLICY_SPACE, "feature");
    assertEquals(both.length, 2);
    assertEquals(both.map((entry) => entry.pieces), [
      ["piece:one"],
      ["piece:one"],
    ]);
    assertEquals(new Set(both.map((entry) => entry.connectionId)).size, 2);

    await firstClient.close();
    assertEquals(
      server.listExecutionDemands(POLICY_SPACE, "feature").length,
      1,
    );

    await secondClient.close();
    assertEquals(
      server.listExecutionDemands(POLICY_SPACE, "feature"),
      [],
    );
  } finally {
    await firstClient.close();
    await secondClient.close();
    await server.close();
  }
});

Deno.test("flag-off clients do not send execution demand messages", async () => {
  const server = createServer("memory-v2-execution-demand-off", false);
  const client = await connectClient(server, false);
  try {
    const session = await mount(client);
    assertEquals(
      await session.setExecutionDemand("", ["piece:off"]),
      false,
    );
    assertEquals(server.listExecutionDemands(POLICY_SPACE, ""), []);
  } finally {
    await client.close();
    await server.close();
  }
});
