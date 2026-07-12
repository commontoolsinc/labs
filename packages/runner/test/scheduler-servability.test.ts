import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  classifyStaticActionServability,
  type StaticActionServabilityCandidate,
} from "../src/scheduler.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";

const servedSpace = "did:key:served" as const;
const foreignSpace = "did:key:foreign" as const;

function address(
  id: string,
  overrides: Partial<IMemorySpaceAddress> = {},
): IMemorySpaceAddress {
  return {
    space: servedSpace,
    scope: "space",
    id: id as IMemorySpaceAddress["id"],
    path: ["value"],
    ...overrides,
  };
}

function candidate(
  overrides: Partial<StaticActionServabilityCandidate> = {},
): StaticActionServabilityCandidate {
  const output = address("of:output");
  return {
    actionKind: "computation",
    ownerSpace: servedSpace,
    pieceId: "space:of:piece",
    implementationFingerprint: "impl:computation-v1",
    runtimeFingerprint: "runner:scheduler:v3",
    completeActionScopeSummary: {
      version: 1,
      complete: true,
      implementationFingerprint: "impl:computation-v1",
      runtimeFingerprint: "runner:scheduler:v3",
      piece: address("of:piece"),
      reads: [address("of:input")],
      writes: [output],
      materializerWriteEnvelopes: [],
      directOutputs: [output],
    },
    ...overrides,
  };
}

function withSummary(
  overrides: Record<string, unknown>,
): StaticActionServabilityCandidate {
  const base = candidate();
  return {
    ...base,
    completeActionScopeSummary: {
      ...base.completeActionScopeSummary as Record<string, unknown>,
      ...overrides,
    },
  };
}

describe("static action servability", () => {
  it("marks a complete same-space computation claim-ready", () => {
    expect(classifyStaticActionServability(candidate(), servedSpace)).toEqual({
      status: "claim-ready",
      actionKind: "computation",
    });
  });

  it("separates complete effects that require the W1.4 broker", () => {
    expect(classifyStaticActionServability(
      candidate({ actionKind: "effect" }),
      servedSpace,
    )).toEqual({
      status: "broker-required",
      actionKind: "effect",
    });
  });

  it("fails closed for incomplete and unknown effect surfaces", () => {
    expect(classifyStaticActionServability(
      candidate({ completeActionScopeSummary: undefined }),
      servedSpace,
    )).toEqual({
      status: "unservable",
      reason: "incomplete-static-surface",
    });
    expect(classifyStaticActionServability(
      candidate({
        actionKind: "effect",
        completeActionScopeSummary: undefined,
      }),
      servedSpace,
    )).toEqual({
      status: "unservable",
      reason: "unknown-effect-surface",
    });
  });

  it("rejects malformed and untrusted summaries", () => {
    expect(classifyStaticActionServability(null, servedSpace)).toEqual({
      status: "unservable",
      reason: "malformed-candidate",
    });
    expect(classifyStaticActionServability(
      withSummary({ complete: false }),
      servedSpace,
    )).toEqual({
      status: "unservable",
      reason: "malformed-static-surface",
    });
    expect(classifyStaticActionServability(
      candidate({
        implementationFingerprint: "action:fallback",
        completeActionScopeSummary: {
          ...candidate().completeActionScopeSummary as Record<string, unknown>,
          implementationFingerprint: "action:fallback",
        },
      }),
      servedSpace,
    )).toEqual({
      status: "unservable",
      reason: "untrusted-implementation",
    });
  });

  it("rejects malformed direct output surfaces", () => {
    expect(classifyStaticActionServability(
      withSummary({ directOutputs: [] }),
      servedSpace,
    )).toEqual({
      status: "unservable",
      reason: "malformed-output-surface",
    });
    expect(classifyStaticActionServability(
      withSummary({
        directOutputs: [address("of:output", {
          path: ["value", "nested"],
        })],
      }),
      servedSpace,
    )).toEqual({
      status: "unservable",
      reason: "malformed-output-surface",
    });
  });

  it("rejects user and session scoped surfaces", () => {
    const cases: Array<{
      candidate: StaticActionServabilityCandidate;
      reason: string;
    }> = [
      {
        candidate: withSummary({
          piece: address("of:piece", { scope: "user" }),
        }),
        reason: "non-space-piece-scope",
      },
      {
        candidate: withSummary({
          reads: [address("of:input", { scope: "session" })],
        }),
        reason: "non-space-read-scope",
      },
      {
        candidate: withSummary({
          writes: [address("of:output", { scope: "user" })],
        }),
        reason: "non-space-write-scope",
      },
    ];

    for (const testCase of cases) {
      expect(classifyStaticActionServability(
        testCase.candidate,
        servedSpace,
      )).toEqual({
        status: "unservable",
        reason: testCase.reason,
      });
    }
  });

  it("distinguishes foreign piece, read, and write surfaces", () => {
    const cases: Array<{
      candidate: StaticActionServabilityCandidate;
      reason: string;
    }> = [
      {
        candidate: candidate({ ownerSpace: foreignSpace }),
        reason: "foreign-owner-space",
      },
      {
        candidate: withSummary({
          piece: address("of:piece", { space: foreignSpace }),
        }),
        reason: "foreign-piece-space",
      },
      {
        candidate: withSummary({
          reads: [address("of:input", { space: foreignSpace })],
        }),
        reason: "foreign-read-space",
      },
      {
        candidate: withSummary({
          materializerWriteEnvelopes: [
            address("of:side-write", { space: foreignSpace }),
          ],
        }),
        reason: "foreign-write-space",
      },
    ];

    for (const testCase of cases) {
      expect(classifyStaticActionServability(
        testCase.candidate,
        servedSpace,
      )).toEqual({
        status: "unservable",
        reason: testCase.reason,
      });
    }
  });

  it("keeps handlers, UI writes, sources, and unknown actions client-primary", () => {
    const cases = [
      ["event-handler", "event-handler"],
      ["ui-binding", "ui-binding-transaction"],
      ["source", "source-transaction"],
      ["passthrough", "unknown-action-kind"],
    ] as const;

    for (const [actionKind, reason] of cases) {
      expect(classifyStaticActionServability(
        { actionKind },
        servedSpace,
      )).toEqual({ status: "unservable", reason });
    }
  });
});
