import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { getLogger } from "@commonfabric/utils/logger";

import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

// A connection handles its frames one at a time, so what a frame costs
// splits in two: how long it waited behind the frames already in flight,
// and how long it took once it started. The server records the halves
// under separate keys, `/api/health/stats` reports them as its
// `timingStats.memory` block, and both
// `docs/development/debugging/profiling.md` and
// `skills/perf-investigation/SKILL.md` name them as the way to tell
// head-of-line blocking from expensive work.
//
// That makes the KEY NAMES load-bearing documentation with no other gate
// behind them: nothing else in the repository fails when a rename leaves
// those two documents pointing at rows that no longer exist. These tests
// are that gate, so they assert the names and the split — never a
// duration, which is a property of the machine.

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

/** Statistics accumulate per logger for the process's life, so a count is
 * only readable as a delta against what earlier tests left behind. */
const frameCounts = (): { queue: number; handle: number } => {
  const timing = getLogger("memory");
  return {
    queue: timing.getTimeStats("memory", "frame", "queue")?.count ?? 0,
    handle: timing.getTimeStats("memory", "frame", "handle")?.count ?? 0,
  };
};

const flushCounts = (): { queue: number; refresh: number } => {
  const timing = getLogger("memory");
  return {
    queue: timing.getTimeStats("memory", "flush", "queue")?.count ?? 0,
    refresh: timing.getTimeStats("memory", "flush", "refresh")?.count ?? 0,
  };
};

describe("v2 server frame timing", () => {
  it("records a waiting half and a working half for each frame received", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://frame-timing-records"),
    });
    try {
      const before = frameCounts();
      const connection = server.connect(() => {});
      await connection.receive(encodeMemoryBoundary(HELLO));

      const after = frameCounts();
      expect(after.queue - before.queue).toBe(1);
      expect(after.handle - before.handle).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("records one of each half per frame when frames arrive faster than they are handled", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://frame-timing-queues"),
    });
    try {
      const connection = server.connect(() => {});
      await connection.receive(encodeMemoryBoundary(HELLO));

      const before = frameCounts();
      // Handed over without awaiting the first, which is how a socket
      // delivers: the second frame waits in the ordered chain. Both halves
      // are counted per FRAME, so an instrument that measured the chain's
      // turn instead of the frame would come up short here and pass above.
      const frame = encodeMemoryBoundary({
        type: "session.watch.set",
        requestId: "watch",
        space: "did:key:z6Mk-frame-timing-queues",
        sessionId: "never-opened",
        watches: [],
      });
      await Promise.all([
        connection.receive(frame),
        connection.receive(frame),
        connection.receive(frame),
      ]);

      const after = frameCounts();
      expect(after.queue - before.queue).toBe(3);
      expect(after.handle - before.handle).toBe(3);
    } finally {
      await server.close();
    }
  });
  it("times a flush as one pass over every dirty space, not once per frame", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://frame-timing-flush"),
      subscriptionRefreshDelayMs: "manual",
    });
    try {
      const before = flushCounts();
      // Two spaces dirtied before a single flush. The pass fans out to
      // both, so a pair of counts that tracked SENDS would read two here.
      // Reading one is the property the walkthrough and the skill both
      // lean on: `memory/flush/refresh` is a batch cost, and dividing it
      // to recover what one frame cost is unsound.
      await server.writeDocument(
        "did:key:z6Mk-frame-timing-flush-a",
        "of:doc:a",
        { flushed: true },
      );
      await server.writeDocument(
        "did:key:z6Mk-frame-timing-flush-b",
        "of:doc:b",
        { flushed: true },
      );
      await server.flushSessions();

      const after = flushCounts();
      expect(after.queue - before.queue).toBe(1);
      expect(after.refresh - before.refresh).toBe(1);
    } finally {
      await server.close();
    }
  });
});
