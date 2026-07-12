import {
  assertEquals,
  assertRejects,
} from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import {
  type AcceptedCommitEvent,
  Server,
} from "../v2/server.ts";
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
    (event) => events.push(event),
  );

  try {
    const applied = await session.transact(commit(1, 1));

    assertEquals(events, [{
      space: SPACE,
      originSessionId: session.sessionId,
      commit: applied,
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
  server.subscribeAcceptedCommits(SPACE, () => delivered++);

  try {
    await session.transact(commit(1, 1));
    assertEquals(delivered, 1);

    await assertRejects(
      () => session.transact(commit(2, 2, 0)),
      Error,
      "Conflict",
    );
    assertEquals(delivered, 1);
  } finally {
    await client.close();
    await server.close();
  }
});
