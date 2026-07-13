import { assertEquals, assertRejects } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import { Server } from "../v2/server.ts";

const SPACE = "did:key:z6Mk-execution-policy-acl-space";
const OWNER = "did:key:z6Mk-execution-policy-owner";
const WRITER = "did:key:z6Mk-execution-policy-writer";
const READER = "did:key:z6Mk-execution-policy-reader";
const AUDIENCE = "did:key:z6Mk-execution-policy-audience";
const POLICY_ID = `of:${SPACE}:execution-policy`;

const authFactory =
  (principal: string): MemoryClient.SessionOpenAuthFactory =>
  (_space, _session, context) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal },
  });

const createServer = (
  name = "memory-v2-execution-policy-acl",
  aclMode: "off" | "observe" | "enforce" = "enforce",
) =>
  new Server({
    store: new URL(`memory://${name}`),
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: AUDIENCE },
    acl: { mode: aclMode, serviceDids: [OWNER] },
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
    },
  });

const connect = (
  server: Server,
  principal: string,
  capable: boolean,
) =>
  MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: {
      serverPrimaryExecutionV1: capable,
      serverPrimaryExecutionClaimRoutingV1: capable,
      serverPrimaryExecutionBuiltinPassivityV1: capable,
    },
  }).then((client) => ({ client, auth: authFactory(principal) }));

Deno.test("execution policy is strict, owner-managed, and cannot be enabled around a stale session", async () => {
  const server = createServer();
  const ownerConnection = await connect(server, OWNER, true);
  const owner = await ownerConnection.client.mount(
    SPACE,
    {},
    ownerConnection.auth,
  );
  let ownerLocalSeq = 1;
  try {
    await owner.transact({
      localSeq: ownerLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${SPACE}`,
        value: {
          value: {
            [OWNER]: "OWNER",
            [WRITER]: "WRITE",
            [READER]: "READ",
          },
        },
      }],
    });

    const writerConnection = await connect(server, WRITER, true);
    const writer = await writerConnection.client.mount(
      SPACE,
      {},
      writerConnection.auth,
    );
    try {
      await assertRejects(
        () =>
          writer.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: POLICY_ID,
              value: {
                value: { version: 1, serverPrimaryExecution: true },
              },
            }],
          }),
        Error,
        "lacks OWNER",
      );
      assertEquals(await server.readDocument(SPACE, POLICY_ID), null);
    } finally {
      await writerConnection.client.close();
    }

    for (
      const operations of [
        [{
          op: "set" as const,
          id: POLICY_ID,
          value: {
            value: {
              version: 1,
              serverPrimaryExecution: true,
              actor: OWNER,
            },
          },
        }],
        [{
          op: "patch" as const,
          id: POLICY_ID,
          patches: [{ op: "replace" as const, path: "/value", value: {} }],
        }],
        [{
          op: "set" as const,
          id: POLICY_ID,
          scope: "user" as const,
          value: {
            value: { version: 1, serverPrimaryExecution: true },
          },
        }],
        [{
          op: "set" as const,
          id: POLICY_ID,
          value: {
            value: { version: 1, serverPrimaryExecution: true },
          },
        }, {
          op: "set" as const,
          id: "of:must-not-land",
          value: { value: true },
        }],
      ]
    ) {
      await assertRejects(
        () =>
          owner.transact({
            localSeq: ownerLocalSeq++,
            reads: { confirmed: [], pending: [] },
            operations,
          }),
        Error,
        "execution policy",
      );
      assertEquals(await server.readDocument(SPACE, POLICY_ID), null);
      assertEquals(await server.readDocument(SPACE, "of:must-not-land"), null);
    }

    await assertRejects(
      () =>
        owner.transact({
          localSeq: ownerLocalSeq++,
          branch: "feature",
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: POLICY_ID,
            value: {
              value: { version: 1, serverPrimaryExecution: true },
            },
          }],
        }),
      Error,
      "default branch",
    );

    const staleConnection = await connect(server, READER, false);
    await staleConnection.client.mount(SPACE, {}, staleConnection.auth);
    try {
      await assertRejects(
        () =>
          owner.transact({
            localSeq: ownerLocalSeq++,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: POLICY_ID,
              value: {
                value: { version: 1, serverPrimaryExecution: true },
              },
            }],
          }),
        Error,
        "incompatible session",
      );
    } finally {
      await staleConnection.client.close();
    }

    await owner.transact({
      localSeq: ownerLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: POLICY_ID,
        value: { value: { version: 1, serverPrimaryExecution: true } },
      }],
    });
    assertEquals(await server.readDocument(SPACE, POLICY_ID), {
      value: { version: 1, serverPrimaryExecution: true },
    });

    await assertRejects(
      () =>
        server.writeDocument(SPACE, POLICY_ID, {
          version: 1,
          serverPrimaryExecution: false,
        }),
      Error,
      "direct writes may not mutate",
    );

    await owner.transact({
      localSeq: ownerLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "delete", id: POLICY_ID }],
    });
    assertEquals(await server.readDocument(SPACE, POLICY_ID), null);
  } finally {
    await ownerConnection.client.close();
    await server.close();
  }
});

Deno.test("execution policy remains OWNER-only outside ACL enforcement", async () => {
  for (const aclMode of ["off", "observe"] as const) {
    const server = createServer(
      `memory-v2-execution-policy-acl-${aclMode}`,
      aclMode,
    );
    const ownerConnection = await connect(server, OWNER, true);
    const owner = await ownerConnection.client.mount(
      SPACE,
      {},
      ownerConnection.auth,
    );
    await owner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${SPACE}`,
        value: {
          value: {
            [OWNER]: "OWNER",
            [WRITER]: "WRITE",
          },
        },
      }],
    });
    const writerConnection = await connect(server, WRITER, true);
    const writer = await writerConnection.client.mount(
      SPACE,
      {},
      writerConnection.auth,
    );
    try {
      await assertRejects(
        () =>
          writer.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: POLICY_ID,
              value: {
                value: { version: 1, serverPrimaryExecution: true },
              },
            }],
          }),
        Error,
        "lacks OWNER",
      );
      assertEquals(await server.readDocument(SPACE, POLICY_ID), null);

      // In off/observe modes an ordinary writer can currently replace the ACL
      // document. That must not let it manufacture the independent authority
      // required to turn on server-primary execution.
      await writer.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${SPACE}`,
          value: { value: { [WRITER]: "OWNER" } },
        }],
      });
      await assertRejects(
        () =>
          writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: POLICY_ID,
              value: {
                value: { version: 1, serverPrimaryExecution: true },
              },
            }],
          }),
        Error,
        "lacks OWNER",
      );
      assertEquals(await server.readDocument(SPACE, POLICY_ID), null);
    } finally {
      await writerConnection.client.close();
      await ownerConnection.client.close();
      await server.close();
    }
  }
});

Deno.test("self-deauthorization removes connection-owned execution demand", async () => {
  const server = createServer("memory-v2-execution-policy-demand-cleanup");
  const ownerConnection = await connect(server, OWNER, true);
  const owner = await ownerConnection.client.mount(
    SPACE,
    {},
    ownerConnection.auth,
  );
  let writerConnection:
    | Awaited<ReturnType<typeof connect>>
    | undefined;
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

    writerConnection = await connect(server, WRITER, true);
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
