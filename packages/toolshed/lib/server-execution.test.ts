import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  DEFAULT_MAX_OUTSTANDING_EFFECTS,
  serverExecutionPolicyFromEnv,
} from "@/lib/server-execution.ts";

// The Phase-6 env knobs (serving-loop.md §5) are the production
// multi-tenancy bound: a runaway fan-out must degrade only its own space,
// so the outstanding-effect cap is ON by default and only the LITERAL `0`
// opts out. The property worth pinning is that a typo cannot disable it:
// garbage must fall back to the default (loudly), never read as the
// opt-out (the Phase-6 independent review's F4 — the pre-fix parser
// mapped "abc"/"-1" to `undefined` = unbounded, indistinguishable from
// the explicit `0`).

const envOf = (values: Record<string, string | undefined>) => (name: string) =>
  values[name];

describe("serverExecutionPolicyFromEnv", () => {
  it("defaults the outstanding cap ON when the knob is unset or empty", () => {
    const warnings: string[] = [];
    expect(serverExecutionPolicyFromEnv(envOf({}), (m) => warnings.push(m)))
      .toEqual({ maxOutstandingEffects: DEFAULT_MAX_OUTSTANDING_EFFECTS });
    expect(
      serverExecutionPolicyFromEnv(
        envOf({ SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS: "" }),
        (m) => warnings.push(m),
      ),
    ).toEqual({ maxOutstandingEffects: DEFAULT_MAX_OUTSTANDING_EFFECTS });
    expect(warnings).toEqual([]);
  });

  it("honors an explicit positive cap and the literal 0 opt-out (unbounded)", () => {
    const warnings: string[] = [];
    expect(
      serverExecutionPolicyFromEnv(
        envOf({ SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS: "8" }),
        (m) => warnings.push(m),
      ),
    ).toEqual({ maxOutstandingEffects: 8 });
    // The operator's deliberate opt-out: the key is ABSENT from the
    // policy (the outbox reads absent as unbounded).
    expect(
      serverExecutionPolicyFromEnv(
        envOf({ SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS: "0" }),
        (m) => warnings.push(m),
      ),
    ).toEqual({});
    expect(warnings).toEqual([]);
  });

  it("FAILS CLOSED on garbage/negative/fractional cap values: default cap, loud warning — never the unbounded opt-out", () => {
    for (const raw of ["abc", "-1", "1.5", "16abc", "0x10", " 4"]) {
      const warnings: string[] = [];
      const policy = serverExecutionPolicyFromEnv(
        envOf({ SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS: raw }),
        (m) => warnings.push(m),
      );
      expect(policy).toEqual({
        maxOutstandingEffects: DEFAULT_MAX_OUTSTANDING_EFFECTS,
      });
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS");
      expect(warnings[0]).toContain(JSON.stringify(raw));
    }
  });

  it("threads the T_flush and egress-rate knobs; garbage there reads as unset (built-in default) with a warning", () => {
    const warnings: string[] = [];
    expect(
      serverExecutionPolicyFromEnv(
        envOf({
          SERVER_EXECUTION_FLUSH_DEADLINE_MS: "250",
          SERVER_EXECUTION_EGRESS_RATE_PER_S: "5",
          SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS: "0",
        }),
        (m) => warnings.push(m),
      ),
    ).toEqual({ flushDeadlineMs: 250, egressRatePerSecond: 5 });
    expect(warnings).toEqual([]);
    expect(
      serverExecutionPolicyFromEnv(
        envOf({
          SERVER_EXECUTION_FLUSH_DEADLINE_MS: "fast",
          SERVER_EXECUTION_EGRESS_RATE_PER_S: "0",
        }),
        (m) => warnings.push(m),
      ),
    ).toEqual({ maxOutstandingEffects: DEFAULT_MAX_OUTSTANDING_EFFECTS });
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain("SERVER_EXECUTION_FLUSH_DEADLINE_MS");
    expect(warnings[1]).toContain("SERVER_EXECUTION_EGRESS_RATE_PER_S");
  });
});
