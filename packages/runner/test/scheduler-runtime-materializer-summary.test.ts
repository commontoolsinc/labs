import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { type ClientCommit } from "@commonfabric/memory/v2";
import {
  buildSchedulerActionObservation,
  type BuildSchedulerActionObservationOptions,
  type SchedulerActionObservation,
} from "../src/scheduler/persistent-observation.ts";
import { runtimeMaterializerComputationScopeSummary } from "../src/scheduler/run.ts";
import {
  classifyStaticActionServability,
  dynamicActionTransactionUnservableReason,
} from "../src/scheduler/servability.ts";
import {
  createExecutorActionTransactionRouter,
  type ExecutorCandidateDiagnostic,
} from "../src/executor/action-transaction-router.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import type { ActionTransactionRouteInput } from "../src/storage/v2.ts";

// W2.16 (RC-3a) — runtime materializer summaries for AUTHORED (`cf:module`)
// dynamic writers that carry registered materializer write envelopes but no
// transformer certificate — computeIndex's shape (writes `allPieces[*].backlinks`
// and, through `mentioned` links, other documents' backlinks). The write bound
// is exactly those envelopes plus the single direct root output; a run writing
// outside them de-claims fail-closed. Builtins arrive via descriptors and are
// excluded here, exactly as the W2.14 write-empty heuristic excludes them.

const SPACE = "did:key:z6Mk-runtime-materializer" as const;
const FOREIGN = "did:key:z6Mk-foreign" as const;
const IMPL = "impl:cf:module/computeIndex-hash:computeIndex";
const RUNTIME_FP = "runner:scheduler:v3";

function address(
  id: string,
  overrides: Partial<IMemorySpaceAddress> = {},
): IMemorySpaceAddress {
  return {
    space: SPACE,
    scope: "space",
    id: id as IMemorySpaceAddress["id"],
    path: ["value"],
    ...overrides,
  };
}

function baseObservation(
  overrides:
    & Partial<SchedulerActionObservation>
    & {
      transactionLog?: BuildSchedulerActionObservationOptions["transactionLog"];
    } = {},
): SchedulerActionObservation {
  const output = address("of:index-output");
  return buildSchedulerActionObservation({
    ownerSpace: SPACE,
    branch: "",
    pieceId: "space:of:piece",
    processGeneration: 0,
    actionId: "cf:module/computeIndex-hash:computeIndex:instance-1",
    actionKind: "computation",
    implementationFingerprint: IMPL,
    runtimeFingerprint: RUNTIME_FP,
    observedAtSeq: 0,
    transactionKind: "action-run",
    transactionLog: {
      reads: [address("of:all-pieces")],
      shallowReads: [],
      writes: [
        output,
        // The per-piece backlinks the writer materializes (inside the envelopes).
        address("of:piece1", { path: ["value", "backlinks"] }),
        address("of:piece2", { path: ["value", "backlinks"] }),
      ],
    },
    currentKnownWrites: [output],
    // Registered envelopes: root prefixes over the pieces the writer touches
    // (as the materializer index renders them via toMemorySpaceAddress).
    materializerWriteEnvelopes: [address("of:piece1"), address("of:piece2")],
    ...overrides,
  });
}

describe("runtime materializer computation summaries (W2.16)", () => {
  it("assembles a claim-ready summary bounded by the envelopes plus the direct output", () => {
    const observation = baseObservation();
    const summary = runtimeMaterializerComputationScopeSummary(observation);
    expect(summary).toBeDefined();
    expect(summary!.implementationFingerprint).toBe(IMPL);
    expect(summary!.runtimeFingerprint).toBe(RUNTIME_FP);
    // Writes carry only the single direct output; the side writes ride in the
    // envelopes.
    expect(summary!.writes).toEqual([address("of:index-output")]);
    expect(summary!.directOutputs).toEqual([address("of:index-output")]);
    expect(summary!.materializerWriteEnvelopes).toEqual([
      address("of:piece1"),
      address("of:piece2"),
    ]);
    expect(summary!.piece).toEqual(address("of:piece"));

    expect(
      classifyStaticActionServability(
        { ...observation, completeActionScopeSummary: summary },
        SPACE,
      ),
    ).toEqual({ status: "claim-ready", actionKind: "computation" });
  });

  it("does not assemble for effects (unknown-effect-surface stays)", () => {
    const observation = baseObservation({ actionKind: "effect" });
    expect(runtimeMaterializerComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("does not assemble when a transformer certificate already exists", () => {
    const output = address("of:index-output");
    const observation = baseObservation({
      completeActionScopeSummary: {
        version: 1,
        complete: true,
        implementationFingerprint: IMPL,
        runtimeFingerprint: RUNTIME_FP,
        piece: address("of:piece"),
        reads: [address("of:all-pieces")],
        writes: [output],
        materializerWriteEnvelopes: [address("of:piece1")],
        directOutputs: [output],
      },
    });
    expect(runtimeMaterializerComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("does not assemble for an untrusted (non-impl) fingerprint", () => {
    const observation = baseObservation({
      implementationFingerprint: "action:telemetry:instance",
    });
    expect(runtimeMaterializerComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("does not assemble for a canonical builtin fingerprint (descriptors only)", () => {
    // A registered-envelope canonical builtin (map/filter/flatMap) is served
    // through its explicit materializer descriptor, never this authored path.
    for (const id of ["map", "filter", "flatMap"]) {
      const observation = baseObservation({
        implementationFingerprint: `impl:cf:builtin/${id}:v1`,
      });
      expect(runtimeMaterializerComputationScopeSummary(observation))
        .toBeUndefined();
    }
  });

  it("does not assemble without registered envelopes (that is the write-empty case)", () => {
    const observation = baseObservation({
      materializerWriteEnvelopes: [],
      transactionLog: {
        reads: [address("of:all-pieces")],
        shallowReads: [],
        writes: [address("of:index-output")],
      },
    });
    expect(runtimeMaterializerComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("does not assemble when a registered write is outside the envelopes and direct output", () => {
    // A declared side write that no envelope (nor the direct output) covers
    // means the envelopes do not honestly bound this writer: stay incomplete.
    // `declaredWrites` is slimmed out of the build options, so set it directly.
    const observation: SchedulerActionObservation = {
      ...baseObservation(),
      declaredWrites: [address("of:rogue")],
    };
    expect(runtimeMaterializerComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("does not assemble when a registered envelope leaves the space", () => {
    const observation = baseObservation({
      materializerWriteEnvelopes: [
        address("of:piece1"),
        address("of:foreign-piece", { space: FOREIGN }),
      ],
    });
    expect(runtimeMaterializerComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("does not assemble for more than one direct output", () => {
    const observation = baseObservation({
      currentKnownWrites: [
        address("of:index-output"),
        address("of:second-output"),
      ],
    });
    expect(runtimeMaterializerComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("does not assemble for a non-space (scoped) direct output", () => {
    const observation = baseObservation({
      currentKnownWrites: [address("of:index-output", { scope: "user" })],
    });
    expect(runtimeMaterializerComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("does not assemble for a non-space (scoped) piece id", () => {
    const observation = baseObservation({ pieceId: "user:of:piece" });
    expect(runtimeMaterializerComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("serves a write inside an envelope but is fail-closed for one outside", () => {
    const observation = baseObservation();
    const summary = runtimeMaterializerComputationScopeSummary(observation);
    const observed: SchedulerActionObservation = {
      ...observation,
      completeActionScopeSummary: summary,
    };
    // Backlinks written into a covered piece are served.
    const okInput: ActionTransactionRouteInput = {
      space: SPACE,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:index-output",
            scope: "space",
            value: { value: {} },
          },
          {
            op: "set",
            id: "of:piece1",
            scope: "space",
            value: { value: { backlinks: [] } },
          },
        ],
        schedulerObservation: observed,
      },
      sourceAction: {},
    };
    expect(
      dynamicActionTransactionUnservableReason(okInput, observed, {
        servedSpace: SPACE,
        branch: "",
      }),
    ).toBeUndefined();

    // A write into a piece outside the registered envelopes de-claims.
    const badObserved: SchedulerActionObservation = {
      ...baseObservation({
        transactionLog: {
          reads: [address("of:all-pieces")],
          shallowReads: [],
          writes: [
            address("of:index-output"),
            address("of:piece3", { path: ["value", "backlinks"] }),
          ],
        },
      }),
      completeActionScopeSummary: summary,
    };
    const badInput: ActionTransactionRouteInput = {
      space: SPACE,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:index-output",
            scope: "space",
            value: { value: {} },
          },
          {
            op: "set",
            id: "of:piece3",
            scope: "space",
            value: { value: { backlinks: [] } },
          },
        ],
        schedulerObservation: badObserved,
      },
      sourceAction: {},
    };
    expect(
      dynamicActionTransactionUnservableReason(badInput, badObserved, {
        servedSpace: SPACE,
        branch: "",
      }),
    ).toBe("dynamic-write-outside-static-surface");
  });

  it("de-claims once, without repeated verdict spam, when a claimed writer writes outside its envelopes", async () => {
    const withSummary = () => {
      const base = baseObservation({
        transactionLog: {
          reads: [address("of:all-pieces")],
          shallowReads: [],
          writes: [
            address("of:index-output"),
            address("of:piece3", { path: ["value", "backlinks"] }),
          ],
        },
      });
      const summary = runtimeMaterializerComputationScopeSummary(base);
      expect(summary).toBeDefined();
      return { ...base, completeActionScopeSummary: summary };
    };
    const commit = (): ClientCommit => ({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        {
          op: "set",
          id: "of:index-output",
          scope: "space",
          value: { value: {} },
        },
        {
          op: "set",
          id: "of:piece3",
          scope: "space",
          value: { value: { backlinks: [] } },
        },
      ],
      schedulerObservation: withSummary(),
    });

    const diagnostics: ExecutorCandidateDiagnostic[] = [];
    const sourceAction = {};
    const router = createExecutorActionTransactionRouter({
      servedSpace: SPACE,
      branch: "",
      claimForAction: () => undefined,
      onCandidate: () => {
        throw new Error(
          "a write-outside-envelope action must not become a candidate",
        );
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    const first = await router({
      space: SPACE,
      commit: commit(),
      sourceAction,
    });
    expect(first).toEqual({ disposition: "local", kind: "executor-shadow" });
    const second = await router({
      space: SPACE,
      commit: commit(),
      sourceAction,
    });
    expect(second).toEqual({ disposition: "local", kind: "executor-shadow" });

    expect(diagnostics.map((entry) => entry.diagnosticCode)).toEqual([
      "dynamic-write-outside-static-surface",
    ]);
  });
});

// The engine's claimed-commit admission requires every commit read covered by
// observation ∪ summary reads; framework-owned (scheduler-ignored) reads are
// absent from the reactive log, so the runtime summary must fold them in — the
// certified path covers them via its exhaustive certificate.
describe("runtime materializer summaries — framework-read folding", () => {
  const covered = (
    reads: readonly IMemorySpaceAddress[],
    target: IMemorySpaceAddress,
  ) =>
    reads.some((entry) =>
      entry.space === target.space && entry.id === target.id &&
      (entry.scope ?? "space") === (target.scope ?? "space") &&
      target.path.join(" ").startsWith(entry.path.join(" "))
    );

  it("folds same-space space-scoped ignored reads into the summary", () => {
    const observation = baseObservation();
    const frameworkRead = address("of:argument-doc", { path: [] });
    const summary = runtimeMaterializerComputationScopeSummary(observation, [
      frameworkRead,
    ]);
    expect(summary).toBeDefined();
    expect(covered(summary!.reads, frameworkRead)).toBe(true);
    // The folded read must not widen the write envelope.
    expect(summary!.writes).toEqual([address("of:index-output")]);
  });

  it("keeps foreign-space and scoped ignored reads uncovered (fail closed)", () => {
    const observation = baseObservation();
    const foreign = address("of:foreign-doc", { space: FOREIGN, path: [] });
    const scoped = address("of:scoped-doc", {
      scope: "session:abc" as IMemorySpaceAddress["scope"],
      path: [],
    });
    const summary = runtimeMaterializerComputationScopeSummary(observation, [
      foreign,
      scoped,
    ]);
    expect(summary).toBeDefined();
    expect(covered(summary!.reads, foreign)).toBe(false);
    expect(covered(summary!.reads, scoped)).toBe(false);
  });

  it("adds cfc sibling reads for the direct output and every envelope (certified-path parity)", () => {
    const observation = baseObservation();
    const summary = runtimeMaterializerComputationScopeSummary(observation);
    expect(summary).toBeDefined();
    expect(
      covered(summary!.reads, address("of:index-output", { path: ["cfc"] })),
    )
      .toBe(true);
    expect(covered(summary!.reads, address("of:piece1", { path: ["cfc"] })))
      .toBe(true);
    expect(covered(summary!.reads, address("of:piece2", { path: ["cfc"] })))
      .toBe(true);
  });
});

// Item 2 — envelope refresh ordering. The materializer envelope set changes with
// data (computeIndex touches more piece documents as the list grows). The
// summary attached to a run must reflect THAT run's registration, so the run's
// commit is judged against the run's own refreshed envelopes — never a stale
// snapshot. Pinned at the unit level: the observation carrying the grown
// envelope produces a summary whose envelope covers the newly-touched piece
// before the engine-side check would reject it.
describe("runtime materializer summaries — envelope refresh ordering (W2.16 item 2)", () => {
  const covers = (
    envelopes: readonly IMemorySpaceAddress[],
    target: IMemorySpaceAddress,
  ) =>
    envelopes.some((envelope) =>
      envelope.space === target.space && envelope.id === target.id &&
      (envelope.scope ?? "space") === (target.scope ?? "space") &&
      envelope.path.length <= target.path.length &&
      envelope.path.every((segment, index) => segment === target.path[index])
    );

  it("judges each run against its own refreshed envelope set", () => {
    const newPieceWrite = address("of:piece2", {
      path: ["value", "backlinks"],
    });

    // Before the list grows: only piece1 is a registered envelope.
    const beforeGrowth = baseObservation({
      materializerWriteEnvelopes: [address("of:piece1")],
      transactionLog: {
        reads: [address("of:all-pieces")],
        shallowReads: [],
        writes: [
          address("of:index-output"),
          address("of:piece1", { path: ["value", "backlinks"] }),
        ],
      },
    });
    const summaryBefore = runtimeMaterializerComputationScopeSummary(
      beforeGrowth,
    );
    expect(summaryBefore).toBeDefined();
    // The pre-growth summary does NOT cover the not-yet-registered piece2.
    expect(covers(summaryBefore!.materializerWriteEnvelopes, newPieceWrite))
      .toBe(false);

    // After the list grows the node re-registers with piece2 in its envelopes;
    // the run that writes piece2's backlinks carries THAT refreshed summary.
    const afterGrowth = baseObservation({
      materializerWriteEnvelopes: [address("of:piece1"), address("of:piece2")],
      transactionLog: {
        reads: [address("of:all-pieces")],
        shallowReads: [],
        writes: [address("of:index-output"), newPieceWrite],
      },
    });
    const summaryAfter = runtimeMaterializerComputationScopeSummary(
      afterGrowth,
    );
    expect(summaryAfter).toBeDefined();
    // The refreshed summary covers the new write before the firewall runs.
    expect(covers(summaryAfter!.materializerWriteEnvelopes, newPieceWrite))
      .toBe(true);

    // The refreshed summary admits the grown run at the firewall; the stale one
    // would have rejected it.
    const observedAfter: SchedulerActionObservation = {
      ...afterGrowth,
      completeActionScopeSummary: summaryAfter,
    };
    const input: ActionTransactionRouteInput = {
      space: SPACE,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:index-output",
            scope: "space",
            value: { value: {} },
          },
          {
            op: "set",
            id: "of:piece2",
            scope: "space",
            value: { value: { backlinks: [] } },
          },
        ],
        schedulerObservation: observedAfter,
      },
      sourceAction: {},
    };
    expect(
      dynamicActionTransactionUnservableReason(input, observedAfter, {
        servedSpace: SPACE,
        branch: "",
      }),
    ).toBeUndefined();

    const staleObservedAfter: SchedulerActionObservation = {
      ...afterGrowth,
      completeActionScopeSummary: summaryBefore,
    };
    expect(
      dynamicActionTransactionUnservableReason(input, staleObservedAfter, {
        servedSpace: SPACE,
        branch: "",
      }),
    ).toBe("dynamic-write-outside-static-surface");
  });
});
