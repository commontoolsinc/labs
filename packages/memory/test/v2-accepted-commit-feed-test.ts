import { assertEquals, assertRejects } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import { type AcceptedCommitEvent, Server } from "../v2/server.ts";
import { type ClientCommit, toDocumentPath } from "../v2.ts";
import {
  testSessionOpenAuth,
  testSessionOpenAuthFactory,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-memory-v2-accepted-commit-feed";

const commit = (
  localSeq: number,
  value: number,
  confirmedSeq?: number,
): ClientCommit => ({
  localSeq,
  reads: {
    confirmed: confirmedSeq === undefined
      ? []
      : [{ id: "of:doc:1", path: toDocumentPath([]), seq: confirmedSeq }],
    pending: [],
  },
  operations: [{
    op: "set",
    id: "of:doc:1",
    value: { value: { value } },
  }],
});

const schedulerObservation = (actionId: string) => ({
  version: 1,
  branch: "",
  pieceId: "of:accepted-feed:piece",
  processGeneration: 1,
  actionId,
  actionKind: "computation",
  implementationFingerprint: "impl:accepted-feed",
  runtimeFingerprint: "runtime:accepted-feed",
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads: [],
  shallowReads: [],
  actualChangedWrites: [],
  currentKnownWrites: [],
  declaredWrites: [],
  materializerWriteEnvelopes: [],
  status: "success",
});

Deno.test("memory v2 accepted-commit feed publishes canonical commits exactly once", async () => {
  const server = new Server({
    authorizeSessionOpen: () => "did:key:z6Mk-accepted-commit-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const client = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
  });
  const session = await client.mount(
    SPACE,
    {},
    testSessionOpenAuthFactory,
  );
  const events: AcceptedCommitEvent[] = [];
  const unsubscribe = server.subscribeAcceptedCommits(
    SPACE,
    (event) => {
      events.push(event);
    },
  );

  try {
    const applied = await session.transact(commit(1, 1));

    assertEquals(events, [{
      order: 1,
      deliverySeq: applied.seq,
      space: SPACE,
      originSessionId: session.sessionId,
      branch: applied.branch,
      dataSeq: applied.seq,
      revisions: applied.revisions.map((revision) => ({
        branch: revision.branch,
        id: revision.id,
        ...(revision.scope !== undefined ? { scope: revision.scope } : {}),
        seq: revision.seq,
        op: revision.op,
      })),
      schedulerUpdateIds: [],
    }]);

    unsubscribe();
    await session.transact(commit(2, 2));
    assertEquals(events.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("memory v2 accepted-commit feed contains listener failures and omits rejected commits", async () => {
  const server = new Server({
    authorizeSessionOpen: () => "did:key:z6Mk-accepted-commit-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const client = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
  });
  const session = await client.mount(
    SPACE,
    {},
    testSessionOpenAuthFactory,
  );
  let delivered = 0;
  server.subscribeAcceptedCommits(SPACE, () => {
    throw new Error("listener failure");
  });
  server.subscribeAcceptedCommits(SPACE, () => {
    delivered++;
  });

  try {
    await session.transact(commit(1, 1));
    assertEquals(delivered, 1);

    const rejection = await assertRejects(
      () => session.transact(commit(2, 2, 0)),
      Error,
    );
    assertEquals(rejection.name, "ConflictError");
    assertEquals(delivered, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("memory v2 accepted-commit feed isolates listener payload mutation", async () => {
  const server = new Server({
    authorizeSessionOpen: () => "did:key:z6Mk-accepted-commit-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const client = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
  });
  const session = await client.mount(
    SPACE,
    {},
    testSessionOpenAuthFactory,
  );
  let observed: AcceptedCommitEvent | undefined;
  server.subscribeAcceptedCommits(SPACE, (event) => {
    try {
      (event as { dataSeq: number }).dataSeq = 999;
    } catch {
      // Frozen host events reject mutation in strict mode.
    }
    try {
      (event.revisions[0] as { seq: number }).seq = 999;
    } catch {
      // Nested scalar metadata is frozen too.
    }
    try {
      (event.schedulerUpdateIds as number[]).push(999);
    } catch {
      // Arrays are immutable across listeners.
    }
  });
  server.subscribeAcceptedCommits(SPACE, (event) => {
    observed = event;
  });

  try {
    const applied = await session.transact(commit(1, 1));
    assertEquals(applied.seq, 1);
    assertEquals(applied.revisions.length, 1);
    assertEquals(observed?.dataSeq, 1);
    assertEquals(observed?.revisions[0]?.seq, 1);
    assertEquals(observed?.schedulerUpdateIds, []);
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("memory v2 accepted-commit feed omits data and observation replays", async () => {
  const server = new Server({
    authorizeSessionOpen: () => "did:key:z6Mk-accepted-commit-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const client = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
  });
  const session = await client.mount(
    SPACE,
    {},
    testSessionOpenAuthFactory,
  );
  const events: AcceptedCommitEvent[] = [];
  server.subscribeAcceptedCommits(SPACE, (event) => {
    events.push(event);
  });

  try {
    const dataCommit = commit(1, 1);
    const firstData = await session.transact(dataCommit);
    const replayedData = await session.transact(dataCommit);
    assertEquals(replayedData.seq, firstData.seq);

    const observationCommit: ClientCommit = {
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: schedulerObservation("action:replayed"),
    };
    const firstObservation = await session.transact(observationCommit);
    const replayedObservation = await session.transact(observationCommit);
    assertEquals(
      replayedObservation.schedulerObservationId,
      firstObservation.schedulerObservationId,
    );

    assertEquals(
      events.map((event) => ({
        order: event.order,
        dataSeq: event.dataSeq,
        observations: event.schedulerUpdateIds.length,
      })),
      [
        { order: 1, dataSeq: 1, observations: 0 },
        { order: 2, dataSeq: 1, observations: 1 },
      ],
    );
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("memory v2 accepted-commit feed includes successful direct host writes", async () => {
  const server = new Server({
    authorizeSessionOpen: () => "did:key:z6Mk-accepted-commit-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const events: AcceptedCommitEvent[] = [];
  server.subscribeAcceptedCommits(SPACE, (event) => {
    events.push(event);
  });

  try {
    const applied = await server.writeDocument(
      SPACE,
      "of:direct:1",
      { direct: true },
    );
    assertEquals(events, [{
      order: 1,
      deliverySeq: applied.seq,
      space: SPACE,
      branch: applied.branch,
      dataSeq: applied.seq,
      revisions: applied.revisions.map((revision) => ({
        branch: revision.branch,
        id: revision.id,
        ...(revision.scope !== undefined ? { scope: revision.scope } : {}),
        seq: revision.seq,
        op: revision.op,
      })),
      schedulerUpdateIds: [],
    }]);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 accepted-commit feed orders observation-only commits sharing a delivery slot", async () => {
  const server = new Server({
    authorizeSessionOpen: () => "did:key:z6Mk-accepted-commit-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const client = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
  });
  const session = await client.mount(
    SPACE,
    {},
    testSessionOpenAuthFactory,
  );
  const events: AcceptedCommitEvent[] = [];
  server.subscribeAcceptedCommits(SPACE, (event) => {
    events.push(event);
  });
  try {
    await session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: schedulerObservation("action:first"),
    });
    await session.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: schedulerObservation("action:second"),
    });

    assertEquals(
      events.map((event) => ({
        order: event.order,
        deliverySeq: event.deliverySeq,
        dataSeq: event.dataSeq,
      })),
      [
        { order: 1, deliverySeq: 1, dataSeq: 0 },
        { order: 2, deliverySeq: 1, dataSeq: 0 },
      ],
    );
  } finally {
    await client.close();
    await server.close();
  }
});
