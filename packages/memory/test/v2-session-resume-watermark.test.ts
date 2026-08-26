import { assertEquals } from "@std/assert";
import { SessionRegistry } from "../v2/session-registry.ts";

// The sent-vs-held reconciliation on resume. `session.entities` records
// what the server SENT, not what the client HOLDS, and it is committed
// when a frame is built. A socket that dies mid-flight loses frames the
// server counts as delivered — `rollbackUndeliveredSync` only repairs a
// locally-throwing send — so the cache keeps claiming documents the
// client never received, and the next diff elides exactly those. A
// schema document elided that way is unobtainable: a watch.add answers
// from the same cache, and no later frame re-stages it.
//
// The repair input is already on the wire: a resuming client reports the
// highest server seq it actually received.
Deno.test("a resume behind the last synced seq forces a full re-evaluation", () => {
  const registry = new SessionRegistry();
  const space = "did:key:z6Mk-resume-watermark";

  const opened = registry.open(space, { sessionId: "s:1" }, 0);
  assertEquals(registry.get(space, "s:1")?.forceFullResync, false);

  // The server syncs this session out to seq 150.
  const stored = registry.get(space, "s:1")!;
  stored.lastSyncedSeq = 150;
  stored.seenSeq = 150;

  // The client comes back saying it only ever received through 100:
  // frames 101..150 were sent and lost. The cache still claims them.
  registry.open(
    space,
    { sessionId: "s:1", sessionToken: opened.sessionToken, seenSeq: 100 },
    150,
  );
  assertEquals(registry.get(space, "s:1")?.forceFullResync, true);
});

Deno.test("a resume that is caught up does not force a re-evaluation", () => {
  const registry = new SessionRegistry();
  const space = "did:key:z6Mk-resume-watermark-caught-up";

  const opened = registry.open(space, { sessionId: "s:2" }, 0);
  const stored = registry.get(space, "s:2")!;
  stored.lastSyncedSeq = 150;
  stored.seenSeq = 150;

  // The client reports exactly what the server sent it: nothing lost,
  // so the incremental path stands and no closure is re-shipped.
  registry.open(
    space,
    { sessionId: "s:2", sessionToken: opened.sessionToken, seenSeq: 150 },
    150,
  );
  assertEquals(registry.get(space, "s:2")?.forceFullResync, false);
});
