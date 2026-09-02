import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import {
  memoryAclPrincipalsFor,
  serverExecutionEnabledFromEnv,
} from "@/lib/server-execution-flag.ts";

// The toolshed process's ONE flag resolution (server-execution v2 Phase 7,
// flip-ready): unset means the FIRST-PARTY DEFAULT — the value of
// `SERVER_EXECUTION_DEFAULT_ENABLED`, whichever it is — and an explicit
// "false" is the OFF arm, an explicit "true" the ON arm. Pinned against
// the constant, not a literal, so the tests state the contract rather
// than the current default — except the ONE absolute pin below.

const envOf = (values: Record<string, string | undefined>) => (name: string) =>
  values[name];

describe("the landing posture (server-execution v2 Phase 7, landed dark by owner ruling 2026-08-16)", () => {
  it("the first-party default IS OFF — the flip to ON is its own separate one-line PR (docs/plans/server-execution-v2.md Phase 7 task 1) and must update this pin, the CI lane roles, and EXPERIMENTAL_OPTIONS.md together", () => {
    // Every other flip pin in the tree is deliberately RELATIVE to the
    // constant (so the flip PR is one line plus this pin); this is the
    // one ABSOLUTE pin, so a silent flip in EITHER direction cannot hide
    // behind green relative pins — flipped silently ON, the REQUIRED
    // default CI lanes would carry the ON posture (the P7 independent
    // review's blocker: two two-browser gates red under ON); flipped
    // silently OFF after the flip PR, the "ON arm" default lanes would
    // run OFF with every test still green.
    expect(SERVER_EXECUTION_DEFAULT_ENABLED).toBe(false);
  });
});

describe("serverExecutionEnabledFromEnv", () => {
  it("resolves an UNSET flag to the first-party default", () => {
    expect(serverExecutionEnabledFromEnv(envOf({}))).toBe(
      SERVER_EXECUTION_DEFAULT_ENABLED,
    );
  });

  it("honors an explicit value either way (both arms stay selectable — CI's explicit-`true` lanes run the ON posture on an ON-built binary)", () => {
    expect(
      serverExecutionEnabledFromEnv(
        envOf({ EXPERIMENTAL_SERVER_EXECUTION: "false" }),
      ),
    ).toBe(false);
    expect(
      serverExecutionEnabledFromEnv(
        envOf({ EXPERIMENTAL_SERVER_EXECUTION: "true" }),
      ),
    ).toBe(true);
  });

  it("garbage reads as unset (the canonical mapping's warn-and-ignore), so it resolves to the default", () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      expect(
        serverExecutionEnabledFromEnv(
          envOf({ EXPERIMENTAL_SERVER_EXECUTION: "yes" }),
        ),
      ).toBe(SERVER_EXECUTION_DEFAULT_ENABLED);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("memoryAclPrincipalsFor", () => {
  // OW31 (RULED 2026-08-18/19): the process identity is a DELEGATING principal
  // under the flag (session-level acting-as-owner READ binding; ACL-only
  // service reads), NEVER an OWNER-class service DID by default — the
  // operator's configured list is verbatim on BOTH arms, retiring the Phase-7
  // implicit-OWNER blanket.

  const me = "did:key:z6MkToolshedProcess";
  const operator = "did:key:z6MkOperator";

  it("OFF the flag: the configured list byte-identical, and an EMPTY delegating list (the binding is unreachable)", () => {
    expect(
      memoryAclPrincipalsFor({
        configured: [operator],
        processIdentityDid: me,
        serverExecution: false,
      }),
    ).toEqual({ serviceDids: [operator], delegatingDids: [] });
    expect(
      memoryAclPrincipalsFor({
        configured: [],
        processIdentityDid: me,
        serverExecution: false,
      }),
    ).toEqual({ serviceDids: [], delegatingDids: [] });
  });

  it("ON: the process identity is DELEGATING and — the absolute pin — NOT an OWNER-class service DID unless the operator configured it", () => {
    expect(
      memoryAclPrincipalsFor({
        configured: [operator],
        processIdentityDid: me,
        serverExecution: true,
      }),
    ).toEqual({ serviceDids: [operator], delegatingDids: [me] });
    // The absolute pin (OW31's guard against creep): under ON the
    // process identity is not an OWNER-class service DID by default.
    expect(
      memoryAclPrincipalsFor({
        configured: [operator],
        processIdentityDid: me,
        serverExecution: true,
      }).serviceDids,
    ).not.toContain(me);
  });

  it("operator-configured OWNER-class listing of the process identity is kept VERBATIM (scope report flag F1: explicit configuration wins; the route logs the combination)", () => {
    expect(
      memoryAclPrincipalsFor({
        configured: [me, operator],
        processIdentityDid: me,
        serverExecution: true,
      }),
    ).toEqual({ serviceDids: [me, operator], delegatingDids: [me] });
  });
});
