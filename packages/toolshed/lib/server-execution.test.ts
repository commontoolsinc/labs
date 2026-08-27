import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import type { Identity } from "@commonfabric/identity";
import {
  DEFAULT_MAX_OUTSTANDING_EFFECTS,
  ensureSpaceRootsFromEnv,
  serverExecutionPolicyFromEnv,
  startServerExecutionHost,
  stopServerExecutionHost,
} from "@/lib/server-execution.ts";
import {
  experimentalPosture,
  publishExperimentalPosture,
} from "@/lib/experimental-posture.ts";

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

// The OFF witness for the serving-loop bootstrap (OW45 arm-B
// server-ensure stage 1's explicit pin; the arc's OFF byte-identity
// bar): with the flag OFF — unset (the first-party default is OFF until
// the flip PR) or explicitly "false" — `startServerExecutionHost`
// returns undefined, so NO ExecutorHost exists, NO SpaceServer is ever
// built, and the server-side space-root ensure path added by stage 1
// (the SpaceServer activation owed-step) structurally does not exist
// OFF. The seat's only reachability chain is toolshed bootstrap →
// ExecutorHost → SpaceServer.activate, and it severs at its first link.
//
// The options are untouchable fakes on purpose: the flag check is the
// function's FIRST act, so the OFF arm must touch neither the server
// nor the identity — any use throws and fails the pin.
describe("startServerExecutionHost OFF witness", () => {
  const untouchable = <T extends object>(label: string): T =>
    new Proxy({} as T, {
      get(_target, property) {
        throw new Error(
          `${label}.${String(property)} touched on the OFF arm — the ` +
            "flag check must precede any use",
        );
      },
    });

  it("is inert with the flag unset (the first-party default: OFF until the flip PR)", () => {
    const host = startServerExecutionHost({
      server: untouchable<MemoryServer>("server"),
      identity: untouchable<Identity>("identity"),
      apiUrl: new URL("http://toolshed.test"),
      envGet: () => undefined,
    });
    expect(host).toBeUndefined();
  });

  it("is inert with the flag explicitly false", () => {
    const host = startServerExecutionHost({
      server: untouchable<MemoryServer>("server"),
      identity: untouchable<Identity>("identity"),
      apiUrl: new URL("http://toolshed.test"),
      envGet: (name) =>
        name === "EXPERIMENTAL_SERVER_EXECUTION" ? "false" : undefined,
    });
    expect(host).toBeUndefined();
  });

  // What `/api/meta` reports has to be the posture this deployment SERVES at,
  // not the generic webhook runtime's: a serving runtime forces flags of its
  // own, and a client adopting the base alone would run values the deployment
  // does not (docs/development/EXPERIMENTAL_OPTIONS.md).
  describe("the posture it publishes", () => {
    // Enough of a server for the host to register its observer on and let go
    // of again; an inert host touches nothing else.
    const observableServer = () =>
      ({ setServerExecutionObserver: () => {} }) as unknown as MemoryServer;
    const serviceIdentity = {
      did: () => "did:key:zServing",
    } as unknown as Identity;

    it("adds nothing while the serving loop is off", () => {
      publishExperimentalPosture({ modernCellRep: false });
      try {
        startServerExecutionHost({
          server: untouchable<MemoryServer>("server"),
          identity: untouchable<Identity>("identity"),
          apiUrl: new URL("http://toolshed.test"),
          envGet: () => undefined,
        });
        expect(experimentalPosture()).toEqual({ modernCellRep: false });
      } finally {
        publishExperimentalPosture(null);
      }
    });

    it("adds the serving runtimes' own flags over the base while it serves", async () => {
      publishExperimentalPosture({
        modernCellRep: true,
        serverExecution: false,
      });
      try {
        expect(
          startServerExecutionHost({
            server: observableServer(),
            identity: serviceIdentity,
            apiUrl: new URL("http://toolshed.test"),
            envGet: (name) =>
              name === "EXPERIMENTAL_SERVER_EXECUTION" ? "true" : undefined,
          }),
        ).toBeDefined();
        // The one the serving runtime factory forces, over a base that says
        // the opposite; everything else rides the base through untouched.
        expect(experimentalPosture()).toEqual({
          modernCellRep: true,
          serverExecution: true,
        });
      } finally {
        await stopServerExecutionHost();
        publishExperimentalPosture(null);
      }
    });

    it("drops them again once the serving loop stops", async () => {
      publishExperimentalPosture({ serverExecution: false });
      try {
        startServerExecutionHost({
          server: observableServer(),
          identity: serviceIdentity,
          apiUrl: new URL("http://toolshed.test"),
          envGet: (name) =>
            name === "EXPERIMENTAL_SERVER_EXECUTION" ? "true" : undefined,
        });
        await stopServerExecutionHost();
        expect(experimentalPosture()).toEqual({ serverExecution: false });
      } finally {
        await stopServerExecutionHost();
        publishExperimentalPosture(null);
      }
    });
  });
});

describe("ensureSpaceRootsFromEnv", () => {
  // The RULED test switch's env parsing (OW45 arm-B stage 1, RULED 2026-08-24):
  // unset and "true" are the production posture (ensure ON); only the literal
  // "false" switches the space-root ensure off; garbage FAILS TO PRODUCTION
  // (ON, with a warning) — a typo must never silently strip production spaces
  // of their roots.

  const envOf2 =
    (values: Record<string, string | undefined>) => (name: string) =>
      values[name];

  it("defaults ON, honors true, and only the literal false disables", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(ensureSpaceRootsFromEnv(envOf2({}), warn)).toBe(true);
    expect(
      ensureSpaceRootsFromEnv(
        envOf2({ SERVER_EXECUTION_ENSURE_SPACE_ROOTS: "true" }),
        warn,
      ),
    ).toBe(true);
    expect(
      ensureSpaceRootsFromEnv(
        envOf2({ SERVER_EXECUTION_ENSURE_SPACE_ROOTS: "false" }),
        warn,
      ),
    ).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("FAILS TO PRODUCTION on garbage: ensure stays ON, loudly", () => {
    for (const raw of ["off", "0", "FALSE", " false", "no"]) {
      const warnings: string[] = [];
      expect(
        ensureSpaceRootsFromEnv(
          envOf2({ SERVER_EXECUTION_ENSURE_SPACE_ROOTS: raw }),
          (m) => warnings.push(m),
        ),
      ).toBe(true);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("SERVER_EXECUTION_ENSURE_SPACE_ROOTS");
    }
  });
});
