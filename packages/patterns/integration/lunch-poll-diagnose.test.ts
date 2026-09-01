/**
 * The lunch-poll scaling probe still drives the poll it measures.
 *
 * `tools/lunch-poll-diagnose.ts` is the scaling diagnostic for the lunch
 * poll, and nothing else runs it. Every step it drives is gated in the
 * pattern — joining needs a resolved profile, adding an option needs the
 * host, casting a vote needs a roster entry and a resolved clock — and a gate
 * that refuses writes nothing and reports nothing. A probe driving a contract
 * the pattern has moved on from therefore still finishes and still prints its
 * JSON, reporting a matrix of zeros that reads like a measurement of an idle
 * poll. This runs the smallest case the probe has and asks what it measured.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { runCase } from "../tools/lunch-poll-diagnose.ts";

describe("lunch-poll-diagnose", () => {
  it("measures a poll two voters joined, filled, and voted in", async () => {
    const result = await runCase({
      optionCount: 1,
      userCount: 2,
      voteRounds: 1,
    });

    // Both sessions see the same poll, and it is the poll the case asked
    // for: two voters on the roster, the host's one option, and a vote from
    // each of them.
    expect(result.convergence.converged).toBe(true);
    expect(result.convergence.userCounts).toEqual([2, 2]);
    expect(result.convergence.optionCounts).toEqual([1, 1]);
    expect(result.convergence.voteCounts).toEqual([2, 2]);

    // The samples the probe exists to collect, taken at each phase.
    expect(result.phases.map((phase) => phase.phase)).toEqual([
      "baseline-open",
      "all-users-join",
      "host-adds-options",
      "concurrent-vote-round-1",
    ]);
    for (const phase of result.phases) {
      expect(phase.aggregate.maxNodes).toBeGreaterThan(0);
      expect(phase.sessions.map((session) => session.label)).toEqual([
        "user-1",
        "user-2",
      ]);
    }
  });
});
