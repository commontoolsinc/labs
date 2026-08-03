// P4 residual backoff (client-passivity §0 step 2): pure schedule shape —
// the first conflict retries immediately (the common single-loss race keeps
// its catch-up-gated retry), the 0ms-gap micro-burst class (36 straight
// conflicts measured on one map action post-step-1) backs off geometrically
// from the SECOND consecutive conflict, capped. Any successful commit
// clears the streak (watchReactiveActionCommit deletes the WeakMap entry).
import { assertEquals } from "@std/assert";
import { conflictStreakBackoffMs } from "../src/scheduler/run.ts";

Deno.test("conflict streak backoff: first conflict free, then geometric, capped", () => {
  assertEquals(conflictStreakBackoffMs(1), 0);
  assertEquals(conflictStreakBackoffMs(2), 25);
  assertEquals(conflictStreakBackoffMs(3), 50);
  assertEquals(conflictStreakBackoffMs(4), 100);
  assertEquals(conflictStreakBackoffMs(5), 200);
  assertEquals(conflictStreakBackoffMs(6), 400);
  assertEquals(conflictStreakBackoffMs(7), 400);
  assertEquals(conflictStreakBackoffMs(40), 400);
});
