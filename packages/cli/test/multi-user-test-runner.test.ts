/**
 * The multi-user orchestrator's `{ label }` / `{ await }` handshake.
 *
 * A marker is a durable write in the shared space, so crossing one means the
 * announcing participant's earlier writes have reached this replica. That is
 * what lets an assertion be read once.
 *
 * What these tests hold in place is that contract as an author meets it: a
 * marker carries state across, a marker announced from a replica that predates
 * another participant's announcement still arrives, a false assertion is
 * reported for what it read rather than for running out of time, and a marker
 * nobody announces is still a deadlock. The propagation gap itself is too
 * small to observe in a fixture this size — the barrier's discriminating
 * coverage is the pattern-test corpus, where removing it fails seven
 * assertions across `topics`, `lobby`, and `cfc-group-chat-demo`.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/multi-user-markers");

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

describe(
  "multi-user-test-runner",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("delivers what was written before the marker", async () => {
      const { passed, failed, results } = await runTests(
        fixture("marker-barrier.test.tsx"),
        { root: FIXTURES },
      );
      expect(failed).toBe(0);
      expect(passed).toBe(1);
      expect(results[0].results[0].name).toBe("bob/assertion_1");
    });

    it("carries markers announced crosswise", async () => {
      // Each participant announces before crossing the other's marker, from
      // a replica that predates the other's announcement. One marker document
      // per announcer keeps that order conflict-free.
      const { passed, failed } = await runTests(
        fixture("crosswise-markers.test.tsx"),
        { root: FIXTURES },
      );
      expect(failed).toBe(0);
      expect(passed).toBe(2);
    });

    it("reports a false assertion with the operands it read", async () => {
      const { passed, failed, results } = await runTests(
        fixture("false-assertion.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(0);
      expect(failed).toBe(1);
      // The assertion is answered from settled state, so the failure names
      // the value that was there rather than reporting elapsed time.
      expect(results[0].results[0].error).toContain(`"from alice"`);
    });

    it("reports a false assertion that recorded no operands", async () => {
      const { passed, failed, results } = await runTests(
        fixture("false-computed.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(0);
      expect(failed).toBe(1);
      expect(results[0].results[0].error).toContain("Expected true, got false");
    });

    it("reports a marker nobody announces as a deadlock", async () => {
      const { failed, results } = await runTests(
        fixture("unannounced-marker.test.tsx"),
        { root: FIXTURES },
      );
      expect(failed).toBeGreaterThan(0);
      expect(results[0].error).toContain("Deadlock");
      expect(results[0].error).toContain(`bob awaits "never-announced"`);
    });
  },
);
