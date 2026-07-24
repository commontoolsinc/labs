import { assertEquals } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import { Server } from "../v2/server.ts";

const SPACE = "did:key:z6Mk-execution-demand-acl-space";
const OWNER = "did:key:z6Mk-execution-demand-owner";
const WRITER = "did:key:z6Mk-execution-demand-writer";
const AUDIENCE = "did:key:z6Mk-execution-demand-audience";

const authFactory =
  (principal: string): MemoryClient.SessionOpenAuthFactory =>
  (_space, _session, context) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal },
  });

const connect = async (server: Server, principal: string) => ({
  client: await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
    },
  }),
  auth: authFactory(principal),
});

Deno.test("self-deauthorization removes connection-owned execution demand", async () => {
  const server = new Server({
    store: new URL("memory://execution-demand-acl-cleanup"),
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: AUDIENCE },
    acl: { mode: "enforce", serviceDids: [OWNER] },
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
    },
  });
  const ownerConnection = await connect(server, OWNER);
  const owner = await ownerConnection.client.mount(
    SPACE,
    {},
    ownerConnection.auth,
  );
  let writerConnection: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await owner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${SPACE}`,
        value: {
          value: {
            [OWNER]: "OWNER",
            [WRITER]: "OWNER",
          },
        },
      }],
    });

    writerConnection = await connect(server, WRITER);
    const writer = await writerConnection.client.mount(
      SPACE,
      {},
      writerConnection.auth,
    );
    assertEquals(
      await writer.setExecutionDemand("feature", ["piece:one"]),
      true,
    );
    assertEquals(server.listExecutionDemands(SPACE, "feature").length, 1);

    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${SPACE}`,
        value: { value: { [OWNER]: "OWNER" } },
      }],
    });
    assertEquals(server.listExecutionDemands(SPACE, "feature"), []);
  } finally {
    await writerConnection?.client.close();
    await ownerConnection.client.close();
    await server.close();
  }
});
