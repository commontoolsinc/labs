import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { type ClientCommit, toDocumentPath } from "@commonfabric/memory/v2";
import {
  buildSchedulerActionObservation,
  type BuildSchedulerActionObservationOptions,
  type SchedulerActionObservation,
} from "../src/scheduler/persistent-observation.ts";
import {
  runtimeWriteEmptyComputationScopeSummary,
  transformerCertificateScopeSummaryInput,
} from "../src/scheduler/run.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
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

/** Certificate-shaped link (normalized cell link — `toMemorySpaceAddress`
 * renders its path below `["value"]`). */
function link(
  id: string,
  overrides: Partial<NormalizedFullLink> = {},
): NormalizedFullLink {
  return {
    space: SPACE,
    id: id as NormalizedFullLink["id"],
    path: [],
    scope: "space",
    ...overrides,
  } as NormalizedFullLink;
}

function baseObservation(
  overrides: Partial<BuildSchedulerActionObservationOptions> = {},
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
      // Fingerprints omitted: CompleteActionScopeSummaryInput excludes them —
      // the builder stamps both from the observation's own fingerprints.
      completeActionScopeSummary: {
        version: 1,
        complete: true,
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
      // is assembled — but this run also dynamically writes `of:extra`. The
      // builder derives `actualChangedWrites` from the transaction log (a
      // bare `actualChangedWrites` override is silently dropped — FB16), so
      // the extra write must enter through `transactionLog.writes`.
      transactionLog: {
        reads: [address("of:input")],
        shallowReads: [],
        writes: [output, extra],
      },
    });
    // Guard against the FB16 silent-drop class: the constructed observation
    // really carries the out-of-envelope write in `actualChangedWrites`.
    expect(observation.actualChangedWrites).toEqual([output, extra]);
    const summary = runtimeWriteEmptyComputationScopeSummary(observation);
    expect(summary).toBeDefined();
    const observed: SchedulerActionObservation = {
      ...observation,
      completeActionScopeSummary: summary,
    };
    // The commit OPERATIONS stay entirely inside the declared surface, so the
    // rejection below can come only from the OBSERVATION-address arm
    // (`actualChangedWrites` bound checking) — the arm this test names. A
    // regression that drops `actualChangedWrites` from the checked write set
    // turns this red instead of being masked by the operations arm.
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
    // write `of:extra` dynamically UNDER A LIVE CLAIM (FB17: with no claim
    // this test exercised only unclaimed candidate suppression). The claimed
    // route must take the claimed arm — claim assertion attached, `unserved`
    // disposition, and the claim released exactly once on settlement — and
    // the post-release reruns fall back client-primary with a single deduped
    // diagnostic (the W2.7 `reportedUnservable` dedupe).
    const output = address("of:output");
    const extra = address("of:extra");
    const withSummary = () => {
      const base = baseObservation({
        // Through the transaction log so `actualChangedWrites` really carries
        // it (a bare `actualChangedWrites` override silently drops — FB16).
        transactionLog: {
          reads: [address("of:input")],
          shallowReads: [],
          writes: [output, extra],
        },
      });
      expect(base.actualChangedWrites).toEqual([output, extra]);
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

    const liveClaim = {
      branch: "",
      space: SPACE,
      contextKey: "space" as const,
      pieceId: "space:of:piece",
      actionId:
        "cf:module/computeMentionable-hash:computeMentionable:instance-1",
      actionKind: "computation" as const,
      implementationFingerprint: IMPL,
      runtimeFingerprint: RUNTIME_FP,
      leaseGeneration: 1,
      claimGeneration: 1,
      expiresAt: Date.now() + 60_000,
    };
    let claimHeld = true;
    const released: string[] = [];
    const diagnostics: ExecutorCandidateDiagnostic[] = [];
    const sourceAction = {};
    const router = createExecutorActionTransactionRouter({
      servedSpace: SPACE,
      branch: "",
      claimForAction: () => (claimHeld ? liveClaim : undefined),
      onCandidate: () => {
        throw new Error(
          "a write-outside-surface action must not become a candidate",
        );
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onUnserved: (claim, action, diagnosticCode) => {
        expect(claim).toBe(liveClaim);
        expect(action).toBe(sourceAction);
        released.push(diagnosticCode);
        claimHeld = false;
      },
    });

    // Claimed run: the claimed arm attaches the claim assertion and routes
    // the attempt `unserved` (the de-claim release), never local-shadow.
    const claimedCommit = commit();
    const first = await router({
      space: SPACE,
      commit: claimedCommit,
      sourceAction,
    });
    expect(first.disposition).toBe("unserved");
    expect(
      (first as { diagnosticCode?: string }).diagnosticCode,
    ).toBe("dynamic-write-outside-static-surface");
    const assertion = (claimedCommit.schedulerObservation as {
      executionClaimAssertion?: {
        contextKey?: string;
        leaseGeneration?: number;
        claimGeneration?: number;
      };
    }).executionClaimAssertion;
    expect(assertion).toEqual({
      contextKey: "space",
      leaseGeneration: 1,
      claimGeneration: 1,
    });
    // Settle the unserved attempt: exactly one claim release (the de-claim).
    (first as { onSettled?: () => void }).onSettled?.();
    expect(released).toEqual(["dynamic-write-outside-static-surface"]);

    // Post-release reruns fall back client-primary and report the verdict
    // exactly once across identical reruns (no verdict spam).
    const second = await router({
      space: SPACE,
      commit: commit(),
      sourceAction,
    });
    expect(second).toEqual({ disposition: "local", kind: "executor-shadow" });
    const third = await router({
      space: SPACE,
      commit: commit(),
      sourceAction,
    });
    expect(third).toEqual({ disposition: "local", kind: "executor-shadow" });
    expect(released).toEqual(["dynamic-write-outside-static-surface"]);
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

  it("folds same-space lane-instance-scoped (user/session) ignored reads (C2.10)", () => {
    // A claimed run at scoped rank resolves entity links through the acting
    // lane's SCOPED instances; the commit then carries whole-`["value"]`
    // confirmed reads of those scoped link documents. A space-only fold left
    // them uncovered — every such run rejected `unobserved-read` at the
    // engine's claimed-commit admission (the C2.10 placement-harness churn).
    const observation = baseObservation();
    const sessionRead = address("of:link-doc", {
      scope: "session",
      path: ["value"],
    });
    const userRead = address("of:user-doc", {
      scope: "user",
      path: ["value"],
    });
    const summary = runtimeWriteEmptyComputationScopeSummary(observation, [
      sessionRead,
      userRead,
    ]);
    expect(summary).toBeDefined();
    expect(covered(summary!.reads, sessionRead)).toBe(true);
    expect(covered(summary!.reads, userRead)).toBe(true);
    // The scoped folds get their cfc siblings too (certified-path parity).
    expect(
      covered(
        summary!.reads,
        address("of:link-doc", { scope: "session", path: ["cfc"] }),
      ),
    ).toBe(true);
    // Reads only — the folded reads must never widen the write envelope.
    expect(summary!.writes).toEqual([address("of:output")]);
  });

  it("keeps foreign-space and malformed-scope ignored reads uncovered (fail closed)", () => {
    const observation = baseObservation();
    const foreign = address("of:foreign-doc", { space: FOREIGN, path: [] });
    const malformed = address("of:scoped-doc", {
      // A scope KEY smuggled into the scope slot is not a CellScope — it must
      // stay excluded rather than teach the summary a shape the engine's
      // lane checks cannot resolve.
      scope: "session:abc" as IMemorySpaceAddress["scope"],
      path: [],
    });
    const summary = runtimeWriteEmptyComputationScopeSummary(observation, [
      foreign,
      malformed,
    ]);
    expect(summary).toBeDefined();
    expect(covered(summary!.reads, foreign)).toBe(false);
    expect(covered(summary!.reads, malformed)).toBe(false);
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

// The transformer-certificate summary source folds the same framework reads
// as every runtime source (C2.10: the certificate path was the residual gap).
// The harness-measured shape: a certified lift reads an entity link — the
// reactive log and the certificate carry only the narrow link position
// (["value","/","link@1"]) while link resolution records a scheduler-ignored
// whole-["value"] read of the link document (at the acting lane's scoped
// instance under a scoped claim) that the claimed commit then carries as a
// confirmed read. Without the fold, path-prefix coverage fails and every such
// claimed run rejects `unobserved-read` at the engine's claimed-commit
// admission.
describe("transformer-certificate summary reads (framework-read folding)", () => {
  const covered = (
    reads: readonly IMemorySpaceAddress[],
    target: IMemorySpaceAddress,
  ) =>
    reads.some((entry) =>
      entry.space === target.space && entry.id === target.id &&
      (entry.scope ?? "space") === (target.scope ?? "space") &&
      target.path.join(" ").startsWith(entry.path.join(" "))
    );

  const linkDocId = "of:link-doc" as IMemorySpaceAddress["id"];
  const certificate = () => ({
    complete: true as const,
    piece: link("of:piece"),
    // The certificate names only the LINK POSITION of the link document —
    // the narrow read the transformer can enumerate.
    reads: [
      link("of:input"),
      link(String(linkDocId), {
        scope: "session",
        path: ["/", "link@1"],
      }),
    ],
    writes: [link("of:output")],
    materializerWriteEnvelopes: [],
    directOutputs: [link("of:output")],
  });
  // The link-resolution framework read the commit actually carries: the
  // whole-value read of the link document at the acting session's instance.
  const wholeValueLinkRead = address(String(linkDocId), {
    scope: "session",
    path: ["value"],
  });

  it("folds the run's scheduler-ignored link-resolution reads beside the certificate", () => {
    const summary = transformerCertificateScopeSummaryInput(certificate(), [
      wholeValueLinkRead,
    ]);
    expect(covered(summary.reads, wholeValueLinkRead)).toBe(true);
    // The folded doc gets its cfc sibling too.
    expect(
      covered(
        summary.reads,
        address(String(linkDocId), { scope: "session", path: ["cfc"] }),
      ),
    ).toBe(true);
    // Reads only: the certificate's write envelope is never widened.
    expect(summary.writes).toEqual([address("of:output")]);
    expect(summary.directOutputs).toEqual([address("of:output")]);
  });

  it("without the fold the whole-value link read stays uncovered (the C2.10 defect shape)", () => {
    const summary = transformerCertificateScopeSummaryInput(certificate());
    // The narrow certificate read does NOT prefix-cover the broader
    // whole-["value"] commit read — exactly the unobserved-read reject the
    // placement harness measured; the fold above is what closes it.
    expect(covered(summary.reads, wholeValueLinkRead)).toBe(false);
  });

  it("keeps the certificate's own cfc sibling reads", () => {
    const summary = transformerCertificateScopeSummaryInput(certificate());
    expect(covered(summary.reads, address("of:input", { path: ["cfc"] })))
      .toBe(true);
    expect(covered(summary.reads, address("of:output", { path: ["cfc"] })))
      .toBe(true);
  });
});
