import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { type ClientCommit, toDocumentPath } from "@commonfabric/memory/v2";
import {
  buildSchedulerActionObservation,
  type SchedulerActionObservation,
} from "../src/scheduler/persistent-observation.ts";
import { runtimeWriteEmptyComputationScopeSummary } from "../src/scheduler/run.ts";
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

// W2.14 — runtime write-empty summaries (RC-3b). A computation with an `impl:`
// fingerprint, no transformer certificate, and a registered write surface that
// is empty beyond its single direct root output gets a runtime-assembled
// `completeActionScopeSummary` with no side writes. Soundness is fail-closed:
// the firewall rejects any run that writes outside that single direct output.

const SPACE = "did:key:z6Mk-write-empty" as const;
const FOREIGN = "did:key:z6Mk-foreign" as const;
const IMPL = "impl:cf:module/computeMentionable-hash:computeMentionable";
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
  overrides: Partial<SchedulerActionObservation> = {},
): SchedulerActionObservation {
  const output = address("of:output");
  return buildSchedulerActionObservation({
    ownerSpace: SPACE,
    branch: "",
    pieceId: "space:of:piece",
    processGeneration: 0,
    actionId: "cf:module/computeMentionable-hash:computeMentionable:instance-1",
    actionKind: "computation",
    implementationFingerprint: IMPL,
    runtimeFingerprint: RUNTIME_FP,
    observedAtSeq: 0,
    transactionKind: "action-run",
    transactionLog: {
      reads: [address("of:input")],
      shallowReads: [],
      writes: [output],
    },
    currentKnownWrites: [output],
    materializerWriteEnvelopes: [],
    ...overrides,
  });
}

describe("runtime write-empty computation summaries (W2.14)", () => {
  it("assembles a claim-ready summary for a write-empty impl computation", () => {
    const observation = baseObservation();
    const summary = runtimeWriteEmptyComputationScopeSummary(observation);
    expect(summary).toBeDefined();
    expect(summary!.implementationFingerprint).toBe(IMPL);
    expect(summary!.runtimeFingerprint).toBe(RUNTIME_FP);
    // No side writes: writes echo only the single direct root output.
    expect(summary!.writes).toEqual([address("of:output")]);
    expect(summary!.directOutputs).toEqual([address("of:output")]);
    expect(summary!.materializerWriteEnvelopes).toEqual([]);
    expect(summary!.piece).toEqual(address("of:piece"));

    const classified = classifyStaticActionServability(
      { ...observation, completeActionScopeSummary: summary },
      SPACE,
    );
    expect(classified).toEqual({
      status: "claim-ready",
      actionKind: "computation",
    });
  });

  it("does not assemble for effects (unknown-effect-surface stays)", () => {
    const observation = baseObservation({ actionKind: "effect" });
    expect(runtimeWriteEmptyComputationScopeSummary(observation))
      .toBeUndefined();
    expect(
      classifyStaticActionServability(observation, SPACE).status,
    ).toBe("unservable");
  });

  it("does not assemble when a transformer certificate already exists", () => {
    const output = address("of:output");
    const observation = baseObservation({
      completeActionScopeSummary: {
        version: 1,
        complete: true,
        implementationFingerprint: IMPL,
        runtimeFingerprint: RUNTIME_FP,
        piece: address("of:piece"),
        reads: [address("of:input")],
        writes: [output],
        materializerWriteEnvelopes: [],
        directOutputs: [output],
      },
    });
    expect(runtimeWriteEmptyComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("does not assemble for an untrusted (non-impl) fingerprint", () => {
    const observation = baseObservation({
      implementationFingerprint: "action:telemetry:instance",
    });
    expect(runtimeWriteEmptyComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("does not assemble for a canonical builtin fingerprint (descriptors only)", () => {
    // A write-empty canonical builtin (`impl:cf:builtin/<id>:v1`, e.g. a simple
    // `map`) must NOT be claimed by this blanket heuristic — builtins are only
    // ever served through explicit per-builtin descriptors (W2.15+). Otherwise
    // deferred builtins (map/filter/wish) would silently become claim-ready.
    for (const id of ["map", "filter", "flatMap", "wish", "ifElse"]) {
      const observation = baseObservation({
        implementationFingerprint: `impl:cf:builtin/${id}:v1`,
      });
      expect(runtimeWriteEmptyComputationScopeSummary(observation))
        .toBeUndefined();
    }
  });

  it("does not assemble when a side write is registered beyond the direct output", () => {
    const observation = baseObservation({
      currentKnownWrites: [address("of:output"), address("of:side")],
    });
    expect(runtimeWriteEmptyComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("does not assemble when a materializer envelope is registered", () => {
    const observation = baseObservation({
      materializerWriteEnvelopes: [address("of:envelope", { path: [] })],
    });
    expect(runtimeWriteEmptyComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("does not assemble for a non-space (scoped) direct output", () => {
    const observation = baseObservation({
      currentKnownWrites: [address("of:output", { scope: "user" })],
    });
    expect(runtimeWriteEmptyComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("does not assemble for a non-space (scoped) piece id", () => {
    const observation = baseObservation({ pieceId: "user:of:piece" });
    expect(runtimeWriteEmptyComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("is fail-closed: a dynamic write outside the direct output is rejected", () => {
    const output = address("of:output");
    const extra = address("of:extra");
    const observation = baseObservation({
      // Registered surface is still the single direct output, so the summary
      // is assembled — but this run also dynamically writes `of:extra`.
      actualChangedWrites: [output, extra],
    });
    const summary = runtimeWriteEmptyComputationScopeSummary(observation);
    expect(summary).toBeDefined();
    const observed: SchedulerActionObservation = {
      ...observation,
      completeActionScopeSummary: summary,
    };
    const input: ActionTransactionRouteInput = {
      space: SPACE,
      commit: {
        localSeq: 1,
        reads: {
          confirmed: [{
            id: "of:input",
            scope: "space",
            path: toDocumentPath(["value"]),
            seq: 2,
          }],
          pending: [],
        },
        operations: [
          { op: "set", id: "of:output", scope: "space", value: { value: 1 } },
          { op: "set", id: "of:extra", scope: "space", value: { value: 9 } },
        ],
        schedulerObservation: observed,
      },
      sourceAction: {},
    };
    expect(
      dynamicActionTransactionUnservableReason(input, observed, {
        servedSpace: SPACE,
        branch: "",
      }),
    ).toBe("dynamic-write-outside-static-surface");
  });

  it("stays fail-closed for a foreign-space direct output", () => {
    const observation = baseObservation({
      currentKnownWrites: [address("of:output", { space: FOREIGN })],
    });
    // A foreign owner space would already be filtered upstream; the runtime
    // assembler must never mint a summary whose direct output leaves the space.
    expect(runtimeWriteEmptyComputationScopeSummary(observation))
      .toBeUndefined();
  });

  it("de-claims once, without repeated verdict spam, when a claimed write-empty action writes", async () => {
    // Assemble the real runtime write-empty summary, then have this run also
    // write `of:extra` dynamically. The whole transaction must be rejected
    // fail-closed and reported exactly once across identical reruns (the W2.7
    // `reportedUnservable` dedupe), leaving the action client-primary.
    const output = address("of:output");
    const extra = address("of:extra");
    const withSummary = () => {
      const base = baseObservation({ actualChangedWrites: [output, extra] });
      const summary = runtimeWriteEmptyComputationScopeSummary(base);
      expect(summary).toBeDefined();
      return { ...base, completeActionScopeSummary: summary };
    };
    const commit = (): ClientCommit => ({
      localSeq: 1,
      reads: {
        confirmed: [{
          id: "of:input",
          scope: "space",
          path: toDocumentPath(["value"]),
          seq: 2,
        }],
        pending: [],
      },
      operations: [
        { op: "set", id: "of:output", scope: "space", value: { value: 1 } },
        { op: "set", id: "of:extra", scope: "space", value: { value: 9 } },
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
          "a write-outside-surface action must not become a candidate",
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
// observation ∪ summary reads. Framework-owned (scheduler-ignored) reads are
// deliberately absent from the reactive log, so the runtime summary must fold
// them in — the certified path covers them via its exhaustive certificate.
// Measured failure without this: every claimed run of a W2.14/W2.15a action
// rejected `unobserved-read` (flag-on default-app, 2026-07-15).
describe("claimed-commit admission reads (framework-read folding)", () => {
  const covered = (
    reads: readonly IMemorySpaceAddress[],
    target: IMemorySpaceAddress,
  ) =>
    reads.some((entry) =>
      entry.space === target.space && entry.id === target.id &&
      (entry.scope ?? "space") === (target.scope ?? "space") &&
      target.path.join(" ").startsWith(entry.path.join(" "))
    );

  it("folds same-space space-scoped ignored reads into the summary", () => {
    const observation = baseObservation();
    const frameworkRead = address("of:argument-doc", { path: [] });
    const summary = runtimeWriteEmptyComputationScopeSummary(observation, [
      frameworkRead,
    ]);
    expect(summary).toBeDefined();
    expect(covered(summary!.reads, frameworkRead)).toBe(true);
    // The folded read must not widen the write envelope.
    expect(summary!.writes).toEqual([address("of:output")]);
  });

  it("keeps foreign-space and scoped ignored reads uncovered (fail closed)", () => {
    const observation = baseObservation();
    const foreign = address("of:foreign-doc", { space: FOREIGN, path: [] });
    const scoped = address("of:scoped-doc", {
      scope: "session:abc" as IMemorySpaceAddress["scope"],
      path: [],
    });
    const summary = runtimeWriteEmptyComputationScopeSummary(observation, [
      foreign,
      scoped,
    ]);
    expect(summary).toBeDefined();
    expect(covered(summary!.reads, foreign)).toBe(false);
    expect(covered(summary!.reads, scoped)).toBe(false);
  });

  it("adds cfc sibling reads for every summary doc (certified-path parity)", () => {
    const observation = baseObservation();
    const summary = runtimeWriteEmptyComputationScopeSummary(observation);
    expect(summary).toBeDefined();
    expect(covered(summary!.reads, address("of:output", { path: ["cfc"] })))
      .toBe(true);
    expect(covered(summary!.reads, address("of:input", { path: ["cfc"] })))
      .toBe(true);
  });
});
