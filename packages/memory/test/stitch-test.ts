import { assertEquals, assertObjectMatch } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import {
  type ClientCommit,
  type ClientMessage,
  type CommitOp,
  type ServerAccepted,
  type ServerMessage,
  type ServerSubscribed,
  type ServerUpdate,
  StitchHub,
} from "../stitch.ts";
import { createTemporaryDirectory } from "../util.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const op = (id: string, value: unknown): CommitOp => ({
  op: "set",
  id: id as CommitOp["id"],
  path: [],
  value: value as CommitOp["value"],
});

const DEFAULT_SELECTOR = { schema: true, path: [] } as const;

const sub = (...docIds: string[]) =>
  Object.fromEntries(docIds.map((id) => [id, DEFAULT_SELECTOR]));

type Session = {
  send(msg: ClientMessage): Promise<void>;
  recv(): Promise<ServerMessage>;
  close(): Promise<void>;
};

function openSession(hub: StitchHub, space = "did:key:test"): Session {
  const { readable, writable } = hub.createSession(space);
  const writer = writable.getWriter();
  const reader = readable.getReader();
  return {
    send: (msg) => writer.write(JSON.stringify(msg)),
    recv: async () => {
      const { value } = await reader.read();
      return JSON.parse(value!) as ServerMessage;
    },
    close: () => writer.close(),
  };
}

let seq = 0;
const commit = (
  ops: CommitOp[],
  readSet: string[] = [],
  serverSeq = 0,
): ClientCommit => ({
  type: "commit",
  clientSeq: ++seq,
  serverSeq,
  readSet: readSet as ClientCommit["readSet"],
  ops,
  signature: "sig",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StitchHub", () => {
  let store: URL;
  let hub: StitchHub;

  beforeEach(async () => {
    seq = 0;
    store = await createTemporaryDirectory();
    hub = new StitchHub(store);
  });

  afterEach(async () => {
    await Deno.remove(store.pathname, { recursive: true });
  });

  // -------------------------------------------------------------------------
  // subscribe
  // -------------------------------------------------------------------------

  describe("subscribe", () => {
    it("returns empty docs and current serverSeq for unknown docs", async () => {
      const a = openSession(hub);
      await a.send({ type: "subscribe", selector: sub("doc:x") });
      const msg = await a.recv() as ServerSubscribed;
      assertEquals(msg.type, "subscribed");
      assertEquals(msg.serverSeq, 0);
      assertEquals(msg.docs, {});
    });

    it("returns current value for a doc that already exists", async () => {
      const a = openSession(hub);
      // Commit a value first.
      await a.send(commit([op("doc:x", { count: 1 })]));
      await a.recv(); // accepted

      const b = openSession(hub);
      await b.send({ type: "subscribe", selector: sub("doc:x") });
      const msg = await b.recv() as ServerSubscribed;
      assertEquals(msg.type, "subscribed");
      assertEquals(msg.docs["doc:x"], { count: 1 });
    });

    it("serverSeq in subscribed response matches current canonical seq", async () => {
      const a = openSession(hub);
      await a.send(commit([op("doc:x", 1)]));
      const accepted = await a.recv() as ServerAccepted;

      const b = openSession(hub);
      await b.send({ type: "subscribe", selector: sub("doc:x") });
      const subscribed = await b.recv() as ServerSubscribed;
      assertEquals(subscribed.serverSeq, accepted.serverSeq);
    });
  });

  // -------------------------------------------------------------------------
  // commit acceptance and rejection
  // -------------------------------------------------------------------------

  describe("commit", () => {
    it("blind write is always accepted", async () => {
      const a = openSession(hub);
      await a.send(commit([op("doc:x", 42)]));
      const msg = await a.recv() as ServerAccepted;
      assertEquals(msg.type, "accepted");
      assertEquals(msg.serverSeq, 1);
    });

    it("server_seq increments with each accepted commit", async () => {
      const a = openSession(hub);
      await a.send(commit([op("doc:a", 1)]));
      const r1 = await a.recv() as ServerAccepted;
      await a.send(commit([op("doc:b", 2)]));
      const r2 = await a.recv() as ServerAccepted;
      assertEquals(r1.serverSeq, 1);
      assertEquals(r2.serverSeq, 2);
    });

    it("commit with stale readSet is rejected", async () => {
      const a = openSession(hub);
      const b = openSession(hub);

      // A subscribes to doc:x.
      await a.send({ type: "subscribe", selector: sub("doc:x") });
      await a.recv(); // subscribed (serverSeq 0)

      // B writes doc:x first.
      await b.send(commit([op("doc:x", "b-value")]));
      await b.recv(); // accepted at serverSeq 1

      // A also receives the update.
      await a.recv(); // update

      // A tries to commit based on serverSeq 0 with doc:x in its readSet.
      await a.send(commit([op("doc:y", "a-value")], ["doc:x"], 0));
      const msg = await a.recv();
      assertEquals(msg.type, "rejected");
    });

    it("commit with readSet not overlapping foreign write is accepted", async () => {
      const a = openSession(hub);
      const b = openSession(hub);

      // B writes doc:x.
      await b.send(commit([op("doc:x", 1)]));
      await b.recv(); // accepted

      // A commits based on serverSeq 0 reading doc:y (untouched).
      await a.send(commit([op("doc:z", 2)], ["doc:y"], 0));
      const msg = await a.recv();
      assertEquals(msg.type, "accepted");
    });
  });

  // -------------------------------------------------------------------------
  // subscription updates and broadcast
  // -------------------------------------------------------------------------

  describe("subscription updates", () => {
    it("subscribed client receives update when another client commits", async () => {
      const a = openSession(hub);
      const b = openSession(hub);

      await a.send({ type: "subscribe", selector: sub("doc:x") });
      await a.recv(); // subscribed

      await b.send(commit([op("doc:x", "hello")]));
      await b.recv(); // accepted

      const update = await a.recv() as ServerUpdate;
      assertEquals(update.type, "update");
      assertEquals(update.ops[0].id, "doc:x");
    });

    it("originating client receives accepted, not update", async () => {
      const a = openSession(hub);
      await a.send({ type: "subscribe", selector: sub("doc:x") });
      await a.recv(); // subscribed

      await a.send(commit([op("doc:x", "self-write")]));
      const msg = await a.recv();
      assertEquals(msg.type, "accepted");
    });

    it("unsubscribed client does not receive update", async () => {
      const a = openSession(hub);
      const b = openSession(hub);

      await a.send({ type: "subscribe", selector: sub("doc:x") });
      await a.recv(); // subscribed

      await a.send({ type: "unsubscribe", selector: sub("doc:x") });

      await b.send(commit([op("doc:x", "b-value")]));
      await b.recv(); // accepted

      // A's next message should be its own accepted, not an update from B.
      await a.send(commit([op("doc:z", 1)]));
      const msg = await a.recv();
      assertEquals(msg.type, "accepted");
    });

    it("wildcard subscriber receives updates for all docs", async () => {
      const a = openSession(hub);
      const b = openSession(hub);

      await a.send({ type: "subscribe", selector: { "*": DEFAULT_SELECTOR } });
      await a.recv(); // subscribed

      await b.send(commit([op("doc:anything", "value")]));
      await b.recv(); // accepted

      const update = await a.recv() as ServerUpdate;
      assertEquals(update.type, "update");
    });

    it("update includes the serverSeq assigned to the commit", async () => {
      const a = openSession(hub);
      const b = openSession(hub);

      await a.send({ type: "subscribe", selector: sub("doc:x") });
      await a.recv(); // subscribed

      await b.send(commit([op("doc:x", 99)]));
      const accepted = await b.recv() as ServerAccepted;
      const update = await a.recv() as ServerUpdate;

      assertEquals(update.serverSeq, accepted.serverSeq);
    });

    it("non-subscribed client does not receive update", async () => {
      const a = openSession(hub);
      const b = openSession(hub);

      // A subscribes to doc:y but B writes doc:x.
      await a.send({ type: "subscribe", selector: sub("doc:y") });
      await a.recv(); // subscribed

      await b.send(commit([op("doc:x", 1)]));
      await b.recv(); // accepted

      // A's next received message should be its own commit response.
      await a.send(commit([op("doc:z", 2)]));
      const msg = await a.recv();
      assertEquals(msg.type, "accepted");
    });
  });

  // -------------------------------------------------------------------------
  // floor advancement and GC (observed indirectly via continued correct behaviour)
  // -------------------------------------------------------------------------

  describe("floor advancement", () => {
    it("client echoing a higher serverSeq still receives further updates", async () => {
      const a = openSession(hub);
      const b = openSession(hub);

      await a.send({ type: "subscribe", selector: sub("doc:x") });
      await a.recv(); // subscribed (serverSeq 0)

      // First commit — A receives update.
      await b.send(commit([op("doc:x", 1)]));
      await b.recv();
      const update1 = await a.recv() as ServerUpdate;
      assertEquals(update1.serverSeq, 1);

      // A echoes serverSeq 1 in its next commit.
      await a.send(commit([op("doc:y", "a")], [], 1));
      await a.recv(); // accepted at serverSeq 2

      // Second commit to doc:x — A should still receive update.
      await b.send(commit([op("doc:x", 2)], [], 2));
      await b.recv();
      const update2 = await a.recv() as ServerUpdate;
      assertEquals(update2.type, "update");
      assertEquals(update2.serverSeq, 3);
    });

    it("client's own integrated commits do not cause staleness rejection", async () => {
      const a = openSession(hub);

      await a.send({ type: "subscribe", selector: sub("doc:x") });
      await a.recv(); // subscribed

      // A writes doc:x at serverSeq 1.
      await a.send(commit([op("doc:x", 1)]));
      const r1 = await a.recv() as ServerAccepted;

      // A writes doc:x again, echoing serverSeq 1 and reading doc:x.
      // Should not be rejected despite doc:x having been written since serverSeq 0.
      await a.send(commit([op("doc:x", 2)], ["doc:x"], r1.serverSeq));
      const r2 = await a.recv();
      assertEquals(r2.type, "accepted");
    });
  });
});
