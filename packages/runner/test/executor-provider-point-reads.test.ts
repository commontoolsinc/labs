// F2 acceptance (feed-adversarial-review FA5/FA6): steady-state accepted-commit
// waves — every revision names a doc the Worker replica already holds and no
// held doc's link topology changes — must integrate through exact point reads
// (docs.read) with ZERO graph queries. Cold paths (initial pull, closure
// growth, deletion, leave-the-closure compaction) legitimately traverse.
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/api";
import type { MemorySpace, MIME, URI } from "@commonfabric/memory/interface";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import {
  createHostProviderChannel,
  HostStorageManager,
} from "../src/storage/v2-host-provider.ts";

class CountingServer extends Server {
  graphQueryCount = 0;

  override async graphQuery(
    message: Parameters<Server["graphQuery"]>[0],
  ): ReturnType<Server["graphQuery"]> {
    this.graphQueryCount++;
    return await super.graphQuery(message);
  }

  /** F1 traversal attribution for the point-read operation. Absent bucket
   * reads as zero calls so the fixtures can assert deltas from a cold start. */
  docsReadCalls(): number {
    return this.feedStats.traversalByOperation["docs.read"]?.calls ?? 0;
  }

  docsReadManagerReads(): number {
    return this.feedStats.traversalByOperation["docs.read"]?.managerReads ?? 0;
  }
}

const linkTo = (id: string, space: MemorySpace) => ({
  "/": { "link@1": { id, path: [], space } },
});

async function setUpLinkedClosure() {
  const principal = await Identity.fromPassphrase(
    `executor point reads ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const server = new CountingServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-point-reads-test",
    },
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
    authorization: { principal: principal.did() },
  });
  const writerClient = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
  });
  const writer = await writerClient.mount(space, {}, authorizeSessionOpen);
  const channel = createHostProviderChannel({
    server,
    space,
    authorizeSessionOpen,
  });
  const storage = HostStorageManager.connect({
    port: channel.port,
    principal: principal.did(),
    space,
  });

  const root = "of:executor-point-reads:root" as URI;
  const target = "of:executor-point-reads:target" as URI;
  let localSeq = 0;
  const writerTransact = (
    operations: { op: "set" | "delete"; id: string; value?: unknown }[],
  ) =>
    writer.transact({
      localSeq: ++localSeq,
      reads: { confirmed: [], pending: [] },
      operations: operations.map((operation) =>
        operation.op === "set"
          ? {
            op: "set" as const,
            id: operation.id,
            value: operation.value as { value: FabricValue },
          }
          : { op: "delete" as const, id: operation.id }
      ),
    });

  await writerTransact([
    {
      op: "set",
      id: root,
      value: { value: { child: linkTo(target, space) } },
    },
    { op: "set", id: target, value: { value: { version: 1 } } },
  ]);

  const provider = storage.open(space);
  const rootSchema = {
    type: "object",
    properties: {
      child: {
        type: "object",
        properties: { version: { type: "number" } },
      },
      extra: {
        type: "object",
        properties: { version: { type: "number" } },
      },
    },
  } as const;
  assertEquals(
    (await provider.sync(root, { path: [], schema: rootSchema })).error,
    undefined,
  );
  const targetAddress = {
    id: target,
    type: "application/json" as MIME,
    path: [],
  };
  assertEquals(provider.replica.get(targetAddress)?.is, {
    value: { version: 1 },
  });

  return {
    server,
    writerClient,
    channel,
    storage,
    provider,
    writerTransact,
    space,
    root,
    target,
    targetAddress,
    async close() {
      await storage.close();
      await channel.dispose();
      await writerClient.close();
      await server.close();
    },
  };
}

Deno.test("executor provider integrates steady-state waves via point reads with zero graph queries", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, target, targetAddress } =
    fixture;
  try {
    // The registration pull is the cold path and must have traversed.
    assert(server.graphQueryCount > 0, "initial sync should run graph queries");

    const graphQueriesBefore = server.graphQueryCount;
    const docsReadCallsBefore = server.docsReadCalls();
    const managerReadsBefore = server.docsReadManagerReads();

    // A value-only update to a held doc: the steady-state wave.
    await writerTransact([
      { op: "set", id: target, value: { value: { version: 2 } } },
    ]);
    await storage.acceptedCommitsSettled();

    assertEquals(provider.replica.get(targetAddress)?.is, {
      value: { version: 2 },
    });
    assertEquals(
      server.graphQueryCount - graphQueriesBefore,
      0,
      "a steady-state wave must not trigger graph queries",
    );
    assertEquals(
      server.docsReadCalls() - docsReadCallsBefore,
      1,
      "one point-read batch should cover the wave",
    );
    assert(
      server.docsReadManagerReads() - managerReadsBefore <= 1,
      "at most one point read per notice revision",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("executor provider coalesces a steady burst into batched point reads", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, target, targetAddress } =
    fixture;
  try {
    const graphQueriesBefore = server.graphQueryCount;
    const burst = 12;
    for (let version = 2; version <= burst + 1; version++) {
      await writerTransact([
        { op: "set", id: target, value: { value: { version } } },
      ]);
    }
    await storage.acceptedCommitsSettled();
    assertEquals(provider.replica.get(targetAddress)?.is, {
      value: { version: burst + 1 },
    });
    assertEquals(
      server.graphQueryCount - graphQueriesBefore,
      0,
      "a steady burst must not trigger graph queries",
    );
    assert(
      server.docsReadManagerReads() <= burst,
      "point reads are bounded by the burst's revisions",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("executor provider closure growth still traverses and delivers the new doc", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, space, root } = fixture;
  const grown = "of:executor-point-reads:grown" as URI;
  try {
    const graphQueriesBefore = server.graphQueryCount;
    await writerTransact([
      {
        op: "set",
        id: root,
        value: {
          value: {
            child: linkTo(fixture.target, space),
            extra: linkTo(grown, space),
          },
        },
      },
      { op: "set", id: grown, value: { value: { version: 1 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(
      provider.replica.get({
        id: grown,
        type: "application/json" as MIME,
      })?.is,
      { value: { version: 1 } },
      "the never-held link target must be pulled into the replica",
    );
    assert(
      server.graphQueryCount - graphQueriesBefore > 0,
      "closure growth is a cold path and must traverse",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("executor provider leave-the-closure: unlinked docs stop producing reads or deliveries", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, root, target } = fixture;
  try {
    // Drop the link. The shrink policy: a link-topology change routes the
    // owning watch through the cold graph refresh, whose before/after diff
    // carries the remove (F3 will add server-side membership deltas).
    await writerTransact([
      { op: "set", id: root, value: { value: { child: null } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(
      provider.replica.get(fixture.targetAddress),
      undefined,
      "the unlinked doc must be removed from the replica",
    );

    const graphQueriesBefore = server.graphQueryCount;
    const docsReadCallsBefore = server.docsReadCalls();
    await writerTransact([
      { op: "set", id: target, value: { value: { version: 99 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(
      provider.replica.get(fixture.targetAddress),
      undefined,
      "a doc outside the closure must not be re-delivered",
    );
    assertEquals(
      server.graphQueryCount - graphQueriesBefore,
      0,
      "a revision naming no held doc must not trigger graph queries",
    );
    assertEquals(
      server.docsReadCalls() - docsReadCallsBefore,
      0,
      "no unwatched point reads (W2.8 conflict-exhaustion class)",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("executor provider leaf deletion is a steady tombstone: delivered without traversal", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, target } = fixture;
  try {
    // The target has no outbound links, so deleting it changes no topology:
    // the wave stays steady and the tombstone flows as a deleted upsert.
    const graphQueriesBefore = server.graphQueryCount;
    await writerTransact([{ op: "delete", id: target }]);
    await storage.acceptedCommitsSettled();
    assertEquals(
      provider.replica.get(fixture.targetAddress),
      undefined,
      "a deleted doc must leave the replica",
    );
    assertEquals(
      server.graphQueryCount - graphQueriesBefore,
      0,
      "a linkless deletion keeps the closure and must not traverse",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("executor provider deletion of a linking doc takes the cold path and drops its subtree", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, space, root } = fixture;
  try {
    // Deleting the root erases its outbound link set (topology shrink): only
    // a traversal can re-baseline the closure and emit the removes.
    const graphQueriesBefore = server.graphQueryCount;
    await writerTransact([{ op: "delete", id: root }]);
    await storage.acceptedCommitsSettled();
    assertEquals(
      provider.replica.get({
        id: root,
        type: "application/json" as MIME,
      }),
      undefined,
      "the deleted root must leave the replica",
    );
    assertEquals(
      provider.replica.get(fixture.targetAddress),
      undefined,
      "the unreachable link target must be removed",
    );
    assert(
      server.graphQueryCount - graphQueriesBefore > 0,
      "deleting a linking doc shrinks the closure and must traverse",
    );
    void space;
  } finally {
    await fixture.close();
  }
});

Deno.test("executor provider steady wave delivers when the global watermark already covers it", async () => {
  const fixture = await setUpLinkedClosure();
  const { server, storage, provider, writerTransact, target, targetAddress } =
    fixture;
  try {
    // Advance the global watermark past the upcoming commit with an unrelated
    // read so the wave's dataSeq is already <= appliedSeq when it integrates.
    await writerTransact([
      { op: "set", id: target, value: { value: { version: 2 } } },
    ]);
    const unrelated = "of:executor-point-reads:unrelated" as URI;
    await writerTransact([
      { op: "set", id: unrelated, value: { value: { later: true } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(provider.replica.get(targetAddress)?.is, {
      value: { version: 2 },
    });
    const graphQueriesBefore = server.graphQueryCount;
    await writerTransact([
      { op: "set", id: target, value: { value: { version: 3 } } },
    ]);
    await storage.acceptedCommitsSettled();
    assertEquals(provider.replica.get(targetAddress)?.is, {
      value: { version: 3 },
    });
    assertEquals(server.graphQueryCount - graphQueriesBefore, 0);
  } finally {
    await fixture.close();
  }
});
