import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import {
  memoryServiceDidsFor,
  serverExecutionEnabledFromEnv,
} from "@/lib/server-execution-flag.ts";

// The toolshed process's ONE flag resolution (server-execution v2 Phase 7,
// the flip): unset means the FIRST-PARTY DEFAULT — the value of
// `SERVER_EXECUTION_DEFAULT_ENABLED`, whichever it is — and an explicit
// "false" is the OFF arm (the rollback lever), an explicit "true" the ON
// arm. Pinned against the constant, not a literal, so the test states the
// contract rather than the current default.

const envOf = (values: Record<string, string | undefined>) => (name: string) =>
  values[name];

describe("serverExecutionEnabledFromEnv", () => {
  it("resolves an UNSET flag to the first-party default", () => {
    expect(serverExecutionEnabledFromEnv(envOf({}))).toBe(
      SERVER_EXECUTION_DEFAULT_ENABLED,
    );
  });

  it("honors an explicit value either way (the OFF arm stays selectable)", () => {
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
