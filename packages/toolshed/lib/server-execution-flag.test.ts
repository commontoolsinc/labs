import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import {
  memoryServiceDidsFor,
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

// Under the flag the process identity is a memory service principal (the
// serving loop's loopback plane reads foreign co-hosted spaces as it —
// protocol.md §2b's free-read row); OFF the flag the operator's configured
// list is used verbatim.
describe("memoryServiceDidsFor", () => {
  const me = "did:key:z6MkToolshedProcess";
  const operator = "did:key:z6MkOperator";

  it("OFF the flag: the configured list, byte-identical (never the process identity)", () => {
    expect(
      memoryServiceDidsFor({
        configured: [operator],
        processIdentityDid: me,
        serverExecution: false,
      }),
    ).toEqual([operator]);
    expect(
      memoryServiceDidsFor({
        configured: [],
        processIdentityDid: me,
        serverExecution: false,
      }),
    ).toEqual([]);
  });

  it("ON: the process identity joins the configured list exactly once", () => {
    expect(
      memoryServiceDidsFor({
        configured: [operator],
        processIdentityDid: me,
        serverExecution: true,
      }),
    ).toEqual([operator, me]);
    // Already configured by the operator: no duplicate.
    expect(
      memoryServiceDidsFor({
        configured: [me, operator],
        processIdentityDid: me,
        serverExecution: true,
      }),
    ).toEqual([me, operator]);
  });
});
