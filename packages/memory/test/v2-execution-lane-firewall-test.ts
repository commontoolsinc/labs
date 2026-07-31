import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import type {
  ClientCommit,
  ExecutionClaim,
  ExecutionLease,
  Operation,
} from "../v2.ts";
import * as Engine from "../v2/engine.ts";
import type {
  SchedulerActionObservation,
  SchedulerExecutionContextKey,
  SchedulerObservationAddress,
} from "../v2/engine.ts";
import {
  auxiliaryScopeNamingLinkForTarget,
  SCOPE_NAMING_LINK_CONFORMANCE,
  scopeNamingLinkForPath,
  SESSION_SCOPE_NAMING_LINK_CONFORMANCE,
} from "../v2/scope-naming-link.ts";

const SPACE = "did:key:z6Mk-lane-firewall-space";
// Colon-bearing DIDs: canonical user context keys percent-encode the
// principal, so lane scope keys never carry the DID raw.
const PRINCIPAL = "did:key:z6Mk-lane-firewall-alice";
const OTHER_PRINCIPAL = "did:key:z6Mk-lane-firewall-bob";
const PIECE_ID = "space:of:lane-firewall-piece";
const ACTION_ID = "action:lane-firewall";
const IMPLEMENTATION_FINGERPRINT = "impl:lane-firewall";
const RUNTIME_FINGERPRINT = "runtime:lane-firewall";

const USER_CONTEXT_KEY = Engine.userExecutionContextKey(
  PRINCIPAL,
) as SchedulerExecutionContextKey;
const OTHER_USER_CONTEXT_KEY = Engine.userExecutionContextKey(
  OTHER_PRINCIPAL,
) as SchedulerExecutionContextKey;

const openTempEngine = async (): Promise<{
  directory: string;
  engine: Engine.Engine;
}> => {
  const directory = await Deno.makeTempDir();
  const store = toFileUrl(`${directory}/space.sqlite`);
  return { directory, engine: await Engine.open({ url: store }) };
};

const acquire = (
  engine: Engine.Engine,
  nowMs: number,
  onBehalfOf = PRINCIPAL,
): ExecutionLease => {
  const lease = Engine.acquireExecutionLease(engine, {
    space: SPACE,
    branch: "",
    hostId: "host:lane-firewall",
    onBehalfOf,
    nowMs,
    ttlMs: 60_000,
    authorizeWrite: () => true,
  });
  assertExists(lease);
  return lease;
};

const claimFor = (
  lease: ExecutionLease,
  contextKey: SchedulerExecutionContextKey,
): ExecutionClaim => ({
  branch: "",
  space: SPACE,
  contextKey,
  pieceId: PIECE_ID,
  actionId: ACTION_ID,
  actionKind: "computation",
  implementationFingerprint: IMPLEMENTATION_FINGERPRINT,
  runtimeFingerprint: RUNTIME_FINGERPRINT,
  leaseGeneration: lease.leaseGeneration,
  claimGeneration: 1,
  expiresAt: lease.expiresAt,
});

const address = (
  scope: "space" | "user" | "session",
  id: string,
  path: readonly string[] = ["value"],
): SchedulerObservationAddress => ({
  space: SPACE,
  scope,
  id,
  path: [...path],
});

const observationFor = (
  claim: ExecutionClaim,
  surfaces: {
    reads?: readonly SchedulerObservationAddress[];
    writes?: readonly SchedulerObservationAddress[];
  },
): SchedulerActionObservation => ({
  version: 2,
  ownerSpace: SPACE,
  branch: "",
  pieceId: PIECE_ID,
  processGeneration: 1,
  actionId: ACTION_ID,
  actionKind: "computation",
  implementationFingerprint: IMPLEMENTATION_FINGERPRINT,
  runtimeFingerprint: RUNTIME_FINGERPRINT,
  executionClaimAssertion: {
    contextKey: claim.contextKey,
    leaseGeneration: claim.leaseGeneration,
    claimGeneration: claim.claimGeneration,
  },
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads: [...(surfaces.reads ?? [])],
  shallowReads: [],
  actualChangedWrites: [...(surfaces.writes ?? [])],
  currentKnownWrites: [...(surfaces.writes ?? [])],
  materializerWriteEnvelopes: [],
  completeActionScopeSummary: {
    version: 1,
    complete: true,
    implementationFingerprint: IMPLEMENTATION_FINGERPRINT,
    runtimeFingerprint: RUNTIME_FINGERPRINT,
    piece: {
      space: SPACE,
      scope: "space",
      id: PIECE_ID.slice("space:".length),
      path: [],
    },
    reads: [...(surfaces.reads ?? [])],
    writes: [...(surfaces.writes ?? [])],
    materializerWriteEnvelopes: [],
    directOutputs: [...(surfaces.writes ?? [])],
  },
  status: "success",
});

const applyClaimed = (
  engine: Engine.Engine,
  lease: ExecutionLease,
  claim: ExecutionClaim,
  options: {
    principal?: string;
    scopeSessionId?: string;
    operations: Operation[];
    surfaces: {
      reads?: readonly SchedulerObservationAddress[];
      writes?: readonly SchedulerObservationAddress[];
    };
    nowMs: number;
    localSeq?: number;
  },
) => {
  const commit: ClientCommit = {
    localSeq: options.localSeq ?? 1,
    reads: { confirmed: [], pending: [] },
    operations: options.operations,
    schedulerObservation: observationFor(claim, options.surfaces),
  };
  return Engine.applyCommit(engine, {
    sessionId: "executor-session",
    scopeSessionId: options.scopeSessionId ?? "executor-session",
    space: SPACE,
    principal: options.principal ?? PRINCIPAL,
    commit,
    executionClaims: new Map([[options.localSeq ?? 1, claim]]),
    executionLeaseFence: { lease, nowMs: options.nowMs, authorize: () => true },
  });
};

const assertFirewallReject = (
  run: () => unknown,
  diagnosticCode: string,
): void => {
  const error = assertThrows(run, Error) as Error & {
    diagnosticCode?: string;
  };
  assertEquals(error.name, "ExecutionActionFirewallError", error.message);
  assertEquals(error.diagnosticCode, diagnosticCode, error.message);
};

const USER_INPUT = address("user", "of:lane-input");
const USER_OUTPUT = address("user", "of:lane-output");
const BROAD_LINK_WRITE = address("space", "of:lane-broad", ["value", "value"]);

const userInstanceOperation: Operation = {
  op: "set",
  id: USER_OUTPUT.id,
  scope: "user",
  value: { value: 7 },
};

const broadLinkOperation = (link: unknown): Operation => ({
  op: "set",
  id: BROAD_LINK_WRITE.id,
  value: { value: { value: link } },
});

Deno.test("user-lane surfaces scoped to the lane principal pass the firewall", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    const applied = applyClaimed(engine, lease, claim, {
      operations: [userInstanceOperation],
      surfaces: { reads: [USER_INPUT], writes: [USER_OUTPUT] },
      nowMs: nowMs + 1,
    });
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    assertEquals(result.executionContextKey, USER_CONTEXT_KEY);
    assertEquals(
      Engine.read(engine, {
        id: USER_OUTPUT.id,
        scope: "user",
        principal: PRINCIPAL,
      }),
      { value: 7 },
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("user-lane scope resolution follows the lane, never the sponsor", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    // Since C1.4 the acting context derives from the asserted claim's lane:
    // a commit sponsored by alice under bob's lane resolves declared user
    // scopes to BOB's instances. Another principal's instance is not
    // addressable from a lane — declared scopes carry no principal, and the
    // host resolves them — so `non-lane-scope` for user surfaces survives
    // only through session scopes (next test).
    const claim = claimFor(lease, OTHER_USER_CONTEXT_KEY);
    const applied = applyClaimed(engine, lease, claim, {
      operations: [userInstanceOperation],
      surfaces: { reads: [USER_INPUT], writes: [USER_OUTPUT] },
      nowMs: nowMs + 1,
    });
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    assertEquals(result.executionContextKey, OTHER_USER_CONTEXT_KEY);
    assertEquals(
      Engine.read(engine, {
        id: USER_OUTPUT.id,
        scope: "user",
        principal: OTHER_PRINCIPAL,
      }),
      { value: 7 },
    );
    // The sponsoring principal's instance is untouched.
    assertEquals(
      Engine.read(engine, {
        id: USER_OUTPUT.id,
        scope: "user",
        principal: PRINCIPAL,
      }),
      null,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("user-lane session-scoped surfaces reject non-lane-scope", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    const sessionOutput = address("session", "of:lane-session-output");
    assertFirewallReject(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [{
            op: "set",
            id: sessionOutput.id,
            scope: "session",
            value: { value: 1 },
          }],
          surfaces: { writes: [sessionOutput] },
          nowMs: nowMs + 1,
        }),
      "non-lane-scope",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("user-lane broad value writes reject broad-lane-value-write", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    const before = Engine.serverSeq(engine);
    assertFirewallReject(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [
            userInstanceOperation,
            broadLinkOperation("a plain broad value"),
          ],
          surfaces: {
            writes: [USER_OUTPUT, BROAD_LINK_WRITE],
          },
          nowMs: nowMs + 1,
        }),
      "broad-lane-value-write",
    );
    assertEquals(Engine.serverSeq(engine), before);
    assertEquals(Engine.read(engine, { id: BROAD_LINK_WRITE.id }), null);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("user-lane broad deletes reject broad-lane-value-write", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    assertFirewallReject(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [
            userInstanceOperation,
            { op: "delete", id: BROAD_LINK_WRITE.id },
          ],
          surfaces: { writes: [USER_OUTPUT, BROAD_LINK_WRITE] },
          nowMs: nowMs + 1,
        }),
      "broad-lane-value-write",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("user-lane conforming scope-naming links commit as emitted", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    const applied = applyClaimed(engine, lease, claim, {
      operations: [
        userInstanceOperation,
        broadLinkOperation(SCOPE_NAMING_LINK_CONFORMANCE.link),
      ],
      surfaces: { writes: [USER_OUTPUT, BROAD_LINK_WRITE] },
      nowMs: nowMs + 1,
    });
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    assertEquals(result.executionContextKey, USER_CONTEXT_KEY);
    assertEquals(
      Engine.read(engine, { id: BROAD_LINK_WRITE.id }),
      { value: { value: SCOPE_NAMING_LINK_CONFORMANCE.link } },
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The AUXILIARY result-instance leg of the §4 pair. `scoped-cell-instances.md`
// ("Computation Rules") applies the widening rule to auxiliary result cells
// too: the computation allocates the cell at the effective output scope and
// "broader output locations then store links to that scoped instance with the
// same causal id". That link is CROSS-document, so the self-redirect shape
// cannot express it — the runner's selectors (ifElse/when/unless/
// inspectConfLabel) emit exactly this on every output-producing run under a
// scoped condition.
//
// The admission is bounded by the action's own trusted certificate, which is
// bound to the implementation fingerprint and authored from the pattern: a
// certificate-drawn id cannot vary with lane-private data.
// ---------------------------------------------------------------------------

// The minted result instance, declared in the certificate at `space` (the
// descriptor is static; the effective scope is discovered per transaction)
// and actually written at the lane's scope.
const MINTED_SPACE = address("space", "of:lane-minted-result");
const MINTED_USER = address("user", "of:lane-minted-result");

const mintedValueOperation: Operation = {
  op: "set",
  id: MINTED_SPACE.id,
  scope: "user",
  value: { value: "selected-branch" },
};

Deno.test("user-lane auxiliary result-instance links commit as emitted", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    const link = auxiliaryScopeNamingLinkForTarget({
      id: MINTED_SPACE.id,
      space: SPACE,
    });
    const applied = applyClaimed(engine, lease, claim, {
      operations: [broadLinkOperation(link), mintedValueOperation],
      surfaces: {
        // The certificate declares BOTH documents broadly; the run writes the
        // mint at the lane instance. The executor router's
        // `widenLaneOutputEnvelopes` is what adds the lane twin, modeled here
        // by carrying both.
        writes: [BROAD_LINK_WRITE, MINTED_SPACE, MINTED_USER],
      },
      nowMs: nowMs + 1,
    });
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    assertEquals(result.executionContextKey, USER_CONTEXT_KEY);
    assertEquals(
      Engine.read(engine, { id: BROAD_LINK_WRITE.id }),
      { value: { value: link } },
    );
    // The value landed at the lane's instance only — the broad instance holds
    // the link, never the value.
    assertEquals(
      Engine.read(engine, {
        id: MINTED_SPACE.id,
        scope: "user",
        principal: PRINCIPAL,
      }),
      { value: "selected-branch" },
    );
    assertEquals(
      Engine.read(engine, {
        id: MINTED_SPACE.id,
        scope: "user",
        principal: OTHER_PRINCIPAL,
      }),
      null,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("auxiliary links are byte-identical across two lanes", async () => {
  // The §4 soundness argument: the id comes from the certificate and the
  // scope is a NAME, so Alice's lane and Bob's lane write the same bytes at
  // the same broad address. Nothing about the acting principal is observable
  // in the broad document.
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const link = auxiliaryScopeNamingLinkForTarget({
      id: MINTED_SPACE.id,
      space: SPACE,
    });
    const surfaces = {
      writes: [BROAD_LINK_WRITE, MINTED_SPACE, MINTED_USER],
    };
    for (
      const [index, contextKey] of [
        USER_CONTEXT_KEY,
        OTHER_USER_CONTEXT_KEY,
      ].entries()
    ) {
      const applied = applyClaimed(engine, lease, claimFor(lease, contextKey), {
        operations: [broadLinkOperation(link), mintedValueOperation],
        surfaces,
        nowMs: nowMs + 1 + index,
        localSeq: index + 1,
      });
      assertExists(applied.schedulerObservationResults);
      assert(applied.schedulerObservationResults[0].status === "kept");
      assertEquals(
        Engine.read(engine, { id: BROAD_LINK_WRITE.id }),
        { value: { value: link } },
      );
    }
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("user-lane auxiliary links naming an UNDECLARED document reject", async () => {
  // The bound. A link naming a document the certificate does not declare
  // could encode lane-private data in the choice of target.
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    const before = Engine.serverSeq(engine);
    assertFirewallReject(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [
            broadLinkOperation(
              auxiliaryScopeNamingLinkForTarget({
                id: "of:a-document-nobody-declared",
                space: SPACE,
              }),
            ),
            userInstanceOperation,
          ],
          surfaces: { writes: [USER_OUTPUT, BROAD_LINK_WRITE] },
          nowMs: nowMs + 1,
        }),
      "malformed-scope-naming-link",
    );
    assertEquals(Engine.serverSeq(engine), before);
    assertEquals(Engine.read(engine, { id: BROAD_LINK_WRITE.id }), null);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("user-lane auxiliary links naming a foreign space reject", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    assertFirewallReject(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [
            broadLinkOperation(
              auxiliaryScopeNamingLinkForTarget({
                id: MINTED_SPACE.id,
                space: "did:key:z6Mk-lane-firewall-elsewhere",
              }),
            ),
            mintedValueOperation,
          ],
          surfaces: {
            writes: [BROAD_LINK_WRITE, MINTED_SPACE, MINTED_USER],
          },
          nowMs: nowMs + 1,
        }),
      "malformed-scope-naming-link",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("user-lane schema-bearing scope-naming links reject", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    const schemaBearing = {
      "/": {
        "link@1": {
          path: ["value"],
          scope: "user",
          overwrite: "redirect",
          schema: { type: "string", default: "covert per-lane payload" },
        },
      },
    };
    assertFirewallReject(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [
            userInstanceOperation,
            broadLinkOperation(schemaBearing),
          ],
          surfaces: { writes: [USER_OUTPUT, BROAD_LINK_WRITE] },
          nowMs: nowMs + 1,
        }),
      "malformed-scope-naming-link",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("user-lane unknown-key scope-naming links reject", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    const unknownKey = {
      "/": {
        "link@1": {
          path: ["value"],
          scope: "user",
          overwrite: "redirect",
          cfcLabelView: "smuggled",
        },
      },
    };
    assertFirewallReject(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [
            userInstanceOperation,
            broadLinkOperation(unknownKey),
          ],
          surfaces: { writes: [USER_OUTPUT, BROAD_LINK_WRITE] },
          nowMs: nowMs + 1,
        }),
      "malformed-scope-naming-link",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("user-lane broad patches accept conforming replaces and reject merge kinds", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    // Seed the broad document so a later patch has a base to replace into.
    Engine.applyCommit(engine, {
      sessionId: "client-session",
      space: SPACE,
      principal: PRINCIPAL,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: BROAD_LINK_WRITE.id,
          value: { value: { value: null } },
        }],
      },
    });
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    const applied = applyClaimed(engine, lease, claim, {
      operations: [
        userInstanceOperation,
        {
          op: "patch",
          id: BROAD_LINK_WRITE.id,
          patches: [{
            op: "replace",
            path: "/value/value",
            value: SCOPE_NAMING_LINK_CONFORMANCE.link,
          }],
        },
      ],
      surfaces: { writes: [USER_OUTPUT, BROAD_LINK_WRITE] },
      nowMs: nowMs + 1,
    });
    assertExists(applied.schedulerObservationResults);
    assert(applied.schedulerObservationResults[0].status === "kept");
    assertEquals(
      Engine.read(engine, { id: BROAD_LINK_WRITE.id }),
      { value: { value: SCOPE_NAMING_LINK_CONFORMANCE.link } },
    );

    // Positional and merge patch kinds cannot prove the self-redirect
    // property at commit time; they stay broad value writes.
    assertFirewallReject(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [
            userInstanceOperation,
            {
              op: "patch",
              id: BROAD_LINK_WRITE.id,
              patches: [{
                op: "append",
                path: "/value/list",
                values: [scopeNamingLinkForPath(["list", "0"])],
              }],
            },
          ],
          surfaces: { writes: [USER_OUTPUT, BROAD_LINK_WRITE] },
          nowMs: nowMs + 2,
          localSeq: 2,
        }),
      "broad-lane-value-write",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("space-lane rejections stay byte-identical", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, "space");
    const error = assertThrows(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [userInstanceOperation],
          surfaces: { writes: [USER_OUTPUT] },
          nowMs: nowMs + 1,
        }),
      Error,
    ) as Error & { diagnosticCode?: string };
    assertEquals(error.name, "ExecutionActionFirewallError");
    assertEquals(error.diagnosticCode, "non-space-scope");
    assert(
      error.message.includes("does not resolve to the space scope"),
      error.message,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("broad scope-naming links are byte-identical across two lanes", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    // Lane A commits the broad scope-naming link plus its own instance.
    const leaseA = acquire(engine, nowMs, PRINCIPAL);
    const claimA = claimFor(leaseA, USER_CONTEXT_KEY);
    applyClaimed(engine, leaseA, claimA, {
      operations: [
        userInstanceOperation,
        broadLinkOperation(SCOPE_NAMING_LINK_CONFORMANCE.link),
      ],
      surfaces: { writes: [USER_OUTPUT, BROAD_LINK_WRITE] },
      nowMs: nowMs + 1,
    });
    const afterA = Engine.read(engine, { id: BROAD_LINK_WRITE.id });

    // Lane B (a different principal, after lane A's lease expires) emits the
    // byte-identical link at the identical broad address: a convergent
    // identical writer, not a competing one.
    const laterMs = leaseA.expiresAt + 1;
    const leaseB = acquire(engine, laterMs, OTHER_PRINCIPAL);
    const claimB = claimFor(leaseB, OTHER_USER_CONTEXT_KEY);
    const applied = applyClaimed(engine, leaseB, claimB, {
      principal: OTHER_PRINCIPAL,
      operations: [
        {
          op: "set",
          id: USER_OUTPUT.id,
          scope: "user",
          value: { value: 9 },
        },
        broadLinkOperation(SCOPE_NAMING_LINK_CONFORMANCE.link),
      ],
      surfaces: { writes: [USER_OUTPUT, BROAD_LINK_WRITE] },
      nowMs: laterMs + 1,
    });
    assertExists(applied.schedulerObservationResults);
    assert(applied.schedulerObservationResults[0].status === "kept");
    const afterB = Engine.read(engine, { id: BROAD_LINK_WRITE.id });
    assertEquals(afterA, {
      value: { value: SCOPE_NAMING_LINK_CONFORMANCE.link },
    });
    assertEquals(afterB, afterA);
    // The two principals' scoped instances stay isolated.
    assertEquals(
      Engine.read(engine, {
        id: USER_OUTPUT.id,
        scope: "user",
        principal: PRINCIPAL,
      }),
      { value: 7 },
    );
    assertEquals(
      Engine.read(engine, {
        id: USER_OUTPUT.id,
        scope: "user",
        principal: OTHER_PRINCIPAL,
      }),
      { value: 9 },
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// C1.10 (owed fixture): the shared-child convergence case (OQ7 / §4). Two
// lanes sharing a broad parent that links to a nested CHILD instance emit the
// byte-identical scope-naming link at that child address, because the link
// value is derived purely from the cell path and NEVER encodes the acting
// principal or session id. Concurrent lanes are therefore convergent identical
// writers on the shared child, not competing ones. This pins the
// DID-independence for a nested child position; the sibling test above pins
// the fixed top-level conformance link.
const SHARED_CHILD_ID = "of:lane-shared-child";
const CHILD_LINK_WRITE = address("space", SHARED_CHILD_ID, ["value", "child"]);
const childLinkOperation = (link: unknown): Operation => ({
  op: "set",
  id: SHARED_CHILD_ID,
  value: { value: { child: link } },
});

Deno.test("a shared child instance takes the byte-identical scope-naming link across two lanes, independent of principal", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    // The link two DIFFERENT principals' lanes emit for the same child path is
    // byte-identical by construction: the builder is pure over the path and
    // carries no DID/session material (the OQ7 soundness argument).
    const aliceLink = scopeNamingLinkForPath(["child"]);
    const bobLink = scopeNamingLinkForPath(["child"]);
    assertEquals(bobLink, aliceLink);
    const serialized = JSON.stringify(aliceLink);
    assert(!serialized.includes(PRINCIPAL));
    assert(!serialized.includes(OTHER_PRINCIPAL));

    // Lane A (alice) writes the shared-child link plus its own scoped instance.
    const leaseA = acquire(engine, nowMs, PRINCIPAL);
    const claimA = claimFor(leaseA, USER_CONTEXT_KEY);
    applyClaimed(engine, leaseA, claimA, {
      operations: [userInstanceOperation, childLinkOperation(aliceLink)],
      surfaces: { writes: [USER_OUTPUT, CHILD_LINK_WRITE] },
      nowMs: nowMs + 1,
    });
    const afterA = Engine.read(engine, { id: SHARED_CHILD_ID });

    // Lane B (bob) emits the byte-identical link at the identical child
    // address: a convergent write onto the shared child, not a competing one.
    const laterMs = leaseA.expiresAt + 1;
    const leaseB = acquire(engine, laterMs, OTHER_PRINCIPAL);
    const claimB = claimFor(leaseB, OTHER_USER_CONTEXT_KEY);
    const applied = applyClaimed(engine, leaseB, claimB, {
      principal: OTHER_PRINCIPAL,
      operations: [
        { op: "set", id: USER_OUTPUT.id, scope: "user", value: { value: 9 } },
        childLinkOperation(bobLink),
      ],
      surfaces: { writes: [USER_OUTPUT, CHILD_LINK_WRITE] },
      nowMs: laterMs + 1,
    });
    assert(applied.schedulerObservationResults?.[0].status === "kept");
    const afterB = Engine.read(engine, { id: SHARED_CHILD_ID });

    assertEquals(afterA, { value: { child: aliceLink } });
    assertEquals(afterB, afterA);
    // The two principals' scoped child instances stay isolated.
    assertEquals(
      Engine.read(engine, {
        id: USER_OUTPUT.id,
        scope: "user",
        principal: PRINCIPAL,
      }),
      { value: 7 },
    );
    assertEquals(
      Engine.read(engine, {
        id: USER_OUTPUT.id,
        scope: "user",
        principal: OTHER_PRINCIPAL,
      }),
      { value: 9 },
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// --- C2.2 engine-accept side (CA2): the broad scope-naming-link backstop is
// lane-scope-parameterized — a session lane's admissible link scopes are its
// non-space chain {user, session}; a user lane's only {user}. These are the
// engine-side halves of the shared conformance fixtures in
// scope-naming-link.ts (the runner emit side pins the same JSON).

const SESSION_CONTEXT_KEY = Engine.sessionExecutionContextKey(
  PRINCIPAL,
  "s1",
) as SchedulerExecutionContextKey;
const SESSION_OUTPUT = address("session", "of:lane-session-output");
const sessionInstanceOperation: Operation = {
  op: "set",
  id: SESSION_OUTPUT.id,
  scope: "session",
  value: { value: 7 },
};

Deno.test("session-lane conforming scope-naming links commit as emitted (session and chain-user scopes)", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, SESSION_CONTEXT_KEY);
    const applied = applyClaimed(engine, lease, claim, {
      scopeSessionId: "s1",
      operations: [
        sessionInstanceOperation,
        broadLinkOperation(SESSION_SCOPE_NAMING_LINK_CONFORMANCE.link),
      ],
      surfaces: { writes: [SESSION_OUTPUT, BROAD_LINK_WRITE] },
      nowMs: nowMs + 1,
    });
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    assertEquals(result.executionContextKey, SESSION_CONTEXT_KEY);
    assertEquals(
      Engine.read(engine, { id: BROAD_LINK_WRITE.id }),
      { value: { value: SESSION_SCOPE_NAMING_LINK_CONFORMANCE.link } },
    );

    // Chain naming: the session lane may also write the byte-identical
    // user-scope link (its chain includes user) — same value every user lane
    // writes, so concurrent lanes stay convergent identical writers.
    const chained = applyClaimed(engine, lease, claim, {
      scopeSessionId: "s1",
      operations: [
        sessionInstanceOperation,
        broadLinkOperation(SCOPE_NAMING_LINK_CONFORMANCE.link),
      ],
      surfaces: { writes: [SESSION_OUTPUT, BROAD_LINK_WRITE] },
      nowMs: nowMs + 2,
      localSeq: 2,
    });
    assertExists(chained.schedulerObservationResults);
    assert(chained.schedulerObservationResults[0].status === "kept");
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("user-lane writing a session-scope naming link rejects (chain excludes session)", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    assertFirewallReject(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [
            userInstanceOperation,
            broadLinkOperation(SESSION_SCOPE_NAMING_LINK_CONFORMANCE.link),
          ],
          surfaces: { writes: [USER_OUTPUT, BROAD_LINK_WRITE] },
          nowMs: nowMs + 1,
        }),
      "malformed-scope-naming-link",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("session-lane schema-bearing scope-naming links reject", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, SESSION_CONTEXT_KEY);
    const schemaBearing = {
      "/": {
        "link@1": {
          path: ["value"],
          scope: "session",
          overwrite: "redirect",
          schema: { type: "string", default: "covert per-lane payload" },
        },
      },
    };
    assertFirewallReject(
      () =>
        applyClaimed(engine, lease, claim, {
          scopeSessionId: "s1",
          operations: [
            sessionInstanceOperation,
            broadLinkOperation(schemaBearing),
          ],
          surfaces: { writes: [SESSION_OUTPUT, BROAD_LINK_WRITE] },
          nowMs: nowMs + 1,
        }),
      "malformed-scope-naming-link",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// SLICE 2a — the firewall's precondition is the ACTING LANE, not a claim.
//
// Before this slice `assertExecutionActionTransaction` was reachable only
// through `acceptedObservation.provenance !== undefined`, and provenance is
// minted only when a live `ExecutionClaim` exists. So every check in this file
// — lane scope admission, the write envelopes, `broad-lane-value-write`, the
// cross-principal leak guards — rode on the one mechanism the arc is deleting
// (`claim-deletion-scope.md` §2a: "no claim => no provenance => no firewall").
//
// The commits below carry NO claim and NO lease fence: they are the shape a
// served run has once claim arbitration is gone. What identifies them is the
// lane the run ACTED AS — the wire's `actingContext`, which the host validates
// against the live lane grant before any scope key resolves (server.ts
// `#actingReadScopeContext`, slice 1) — plus the observation's own trusted
// scope summary, which `trustedSchedulerScopeSummary` validates against the
// observation and no claim.
//
// The claimed commits above keep every byte of their behavior: a claim's
// observation always asserts its lane, so the acting lane the firewall now
// resolves is the same context key it read off the claim before.

/** The observation an unclaimed served run emits: identical to the claimed
 * one minus the claim assertion, which is the whole point. */
const unclaimedObservation = (
  surfaces: {
    reads?: readonly SchedulerObservationAddress[];
    writes?: readonly SchedulerObservationAddress[];
  },
): SchedulerActionObservation => {
  const { executionClaimAssertion: _assertion, ...unclaimed } = observationFor(
    {
      branch: "",
      space: SPACE,
      contextKey: "space",
      pieceId: PIECE_ID,
      actionId: ACTION_ID,
      actionKind: "computation",
      implementationFingerprint: IMPLEMENTATION_FINGERPRINT,
      runtimeFingerprint: RUNTIME_FINGERPRINT,
      leaseGeneration: 1,
      claimGeneration: 1,
      expiresAt: 0,
    },
    surfaces,
  );
  return unclaimed;
};

/** A served run's commit with no claim — the post-deletion shape.
 * `actingContext` is the ONLY thing naming its lane. A `lease` may be supplied
 * to exercise the in-transaction lease fence (slice 2b): the host builds one
 * for every bound executor session, claim or no claim. */
const applyActingLane = (
  engine: Engine.Engine,
  options: {
    actingContext?: SchedulerExecutionContextKey;
    operations: Operation[];
    surfaces?: {
      reads?: readonly SchedulerObservationAddress[];
      writes?: readonly SchedulerObservationAddress[];
    };
    observation?: SchedulerActionObservation;
    scopeSessionId?: string;
    localSeq?: number;
    lease?: ExecutionLease;
    nowMs?: number;
    fence?: Partial<Engine.ExecutionLeaseFence>;
    executionClaims?: ReadonlyMap<number, ExecutionClaim>;
  },
) => {
  const localSeq = options.localSeq ?? 1;
  const commit: ClientCommit = {
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: options.operations,
    schedulerObservation: options.observation ??
      unclaimedObservation(options.surfaces ?? {}),
  };
  return Engine.applyCommit(engine, {
    sessionId: "executor-session",
    scopeSessionId: options.scopeSessionId ?? "executor-session",
    space: SPACE,
    principal: PRINCIPAL,
    commit,
    ...(options.actingContext !== undefined
      ? { actingContext: options.actingContext }
      : {}),
    ...(options.executionClaims !== undefined
      ? { executionClaims: options.executionClaims }
      : {}),
    ...(options.lease !== undefined
      ? {
        executionLeaseFence: {
          lease: options.lease,
          nowMs: options.nowMs ?? 0,
          authorize: () => true,
          ...options.fence,
        },
      }
      : {}),
  });
};

const assertFenceCause = (run: () => unknown, cause: string): void => {
  const error = assertThrows(run, Engine.ExecutionLeaseFenceError);
  assertEquals(error.fenceCause, cause, error.message);
};

/** The context key an authority consult named, plus whether it carried a
 * claim. Typed loosely so the pin reads the same shape before and after the
 * `laneAuthority` signature change. */
const laneConsultShape = (
  query: unknown,
): { contextKey: unknown; claimed: boolean } => ({
  contextKey: (query as { contextKey?: unknown }).contextKey,
  claimed: (query as { claim?: unknown }).claim !== undefined,
});

Deno.test("an UNCLAIMED commit acting as a user lane reaches the firewall — broad value writes still reject broad-lane-value-write", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const before = Engine.serverSeq(engine);
    assertFirewallReject(
      () =>
        applyActingLane(engine, {
          actingContext: USER_CONTEXT_KEY,
          operations: [
            userInstanceOperation,
            broadLinkOperation("a plain broad value"),
          ],
          surfaces: { writes: [USER_OUTPUT, BROAD_LINK_WRITE] },
        }),
      "broad-lane-value-write",
    );
    assertEquals(Engine.serverSeq(engine), before);
    assertEquals(Engine.read(engine, { id: BROAD_LINK_WRITE.id }), null);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("an UNCLAIMED commit acting as a user lane rejects a session-scoped write non-lane-scope", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const sessionOutput = address("session", "of:lane-session-output");
    assertFirewallReject(
      () =>
        applyActingLane(engine, {
          actingContext: USER_CONTEXT_KEY,
          operations: [{
            op: "set",
            id: sessionOutput.id,
            scope: "session",
            value: { value: 1 },
          }],
          surfaces: { writes: [sessionOutput] },
        }),
      "non-lane-scope",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("an UNCLAIMED acting lane without a trusted scope summary rejects incomplete-static-scope", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    // The summary requirement lives INSIDE the firewall, never in its
    // precondition: making "has a trusted summary" the gate would let a
    // summary-less lane commit skip every check below it.
    const {
      completeActionScopeSummary: _summary,
      ...withoutSummary
    } = unclaimedObservation({ writes: [USER_OUTPUT] });
    assertFirewallReject(
      () =>
        applyActingLane(engine, {
          actingContext: USER_CONTEXT_KEY,
          operations: [userInstanceOperation],
          observation: withoutSummary as SchedulerActionObservation,
        }),
      "incomplete-static-scope",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("an UNCLAIMED observation-only commit acting as a user lane reaches the firewall", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const sessionOutput = address("session", "of:lane-session-observed");
    assertFirewallReject(
      () =>
        applyActingLane(engine, {
          actingContext: USER_CONTEXT_KEY,
          operations: [],
          surfaces: { writes: [sessionOutput] },
        }),
      "non-lane-scope",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("an UNCLAIMED conforming commit acting as a user lane commits at the LANE's instance", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const applied = applyActingLane(engine, {
      actingContext: USER_CONTEXT_KEY,
      operations: [
        userInstanceOperation,
        broadLinkOperation(SCOPE_NAMING_LINK_CONFORMANCE.link),
      ],
      surfaces: { writes: [USER_OUTPUT, BROAD_LINK_WRITE] },
    });
    assertExists(applied.schedulerObservationResults);
    assertEquals(
      Engine.read(engine, { id: BROAD_LINK_WRITE.id }),
      { value: { value: SCOPE_NAMING_LINK_CONFORMANCE.link } },
    );
    // Scope resolution follows the acting lane, not the sponsor session.
    assertEquals(
      Engine.read(engine, {
        id: USER_OUTPUT.id,
        scope: "user",
        principal: PRINCIPAL,
      }),
      { value: 7 },
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a commit that names NO lane stays outside the firewall (ordinary clients are unchanged)", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    // Byte-identical to the rejected case above except that nothing names a
    // lane. An ordinary client sends no acting context and asserts no claim,
    // so widening the precondition must not pull the whole client population
    // into a firewall built for served lane runs.
    const applied = applyActingLane(engine, {
      operations: [
        userInstanceOperation,
        broadLinkOperation("a plain broad value"),
      ],
      surfaces: { writes: [USER_OUTPUT, BROAD_LINK_WRITE] },
    });
    assertExists(applied.schedulerObservationResults);
    assertEquals(
      Engine.read(engine, { id: BROAD_LINK_WRITE.id }),
      { value: { value: "a plain broad value" } },
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// SLICE 2b rows 3 & 4 — the two AUTHORITY checks that decide who may write
// are carried by the acting lane, not by a claim
// (`claim-deletion-scope.md` §2b, rows 3 and 4).
//
// Both live in the in-transaction lease fence and both survive claim deletion:
// they decide WHO MAY WRITE, which is write bounding, not arbitration.
//
//   `lane-write-authority`  — re-resolves WRITE for the ACTING principal at
//                             transaction time, so a mid-run ACL revocation
//                             fences the in-flight commit instead of landing
//                             rows under her scope.
//   `lane-generation-stale` — the lane's grant must still be live; a drained
//                             or superseded lane may not commit.
//
// Before this slice both were reached ONLY from `for (const claim of
// options.claims)`, so an unclaimed served lane run — the shape every served
// run has once claims are gone — wrote with NEITHER check. The claimed set
// keeps every byte: the acting lane of a claimed commit IS the claim's lane
// (`claim-observation-mismatch` fences any disagreement upstream), so the
// per-claim consults still run, still first, still against the same lane, and
// the acting-lane consult dedupes against them rather than double-charging.

const LANE_DRAINED = { laneAuthority: () => false } as const;

Deno.test("an UNCLAIMED commit acting as a user lane fences lane-generation-stale when its lane grant is gone", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const before = Engine.serverSeq(engine);
    assertFenceCause(
      () =>
        applyActingLane(engine, {
          actingContext: USER_CONTEXT_KEY,
          operations: [],
          surfaces: { writes: [USER_OUTPUT] },
          lease,
          nowMs: nowMs + 1,
          fence: LANE_DRAINED,
        }),
      "lane-generation-stale",
    );
    assertEquals(Engine.serverSeq(engine), before);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("the acting-lane grant consult names the CONTEXT KEY and carries no claim", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const consulted: { contextKey: unknown; claimed: boolean }[] = [];
    applyActingLane(engine, {
      actingContext: USER_CONTEXT_KEY,
      operations: [],
      surfaces: { writes: [USER_OUTPUT] },
      lease,
      nowMs: nowMs + 1,
      fence: {
        laneAuthority: (query) => {
          consulted.push(laneConsultShape(query));
          return true;
        },
      },
    });
    // The grant registry is keyed by (space, branch, contextKey), so the lane
    // the run acted as is a sufficient lookup — that is the whole of row 4.
    assertEquals(consulted, [{ contextKey: USER_CONTEXT_KEY, claimed: false }]);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("an UNCLAIMED commit acting as a user lane fences lane-write-authority when the lane principal lost WRITE", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const before = Engine.serverSeq(engine);
    const consulted: string[] = [];
    assertFenceCause(
      () =>
        applyActingLane(engine, {
          actingContext: USER_CONTEXT_KEY,
          operations: [],
          surfaces: { writes: [USER_OUTPUT] },
          lease,
          nowMs: nowMs + 1,
          fence: {
            authorizeActingPrincipal: (_engine, principal) => {
              consulted.push(principal);
              return false;
            },
          },
        }),
      "lane-write-authority",
    );
    // The DECODED lane principal, never the sponsor — identical to the claimed
    // path's resolution, because it reads the same canonical context key.
    assertEquals(consulted, [PRINCIPAL]);
    assertEquals(Engine.serverSeq(engine), before);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("an UNCLAIMED commit acting as a SESSION lane decodes its principal from the canonical session key", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const consulted: string[] = [];
    // CA7: without the session decode the WRITE re-check fails OPEN for
    // session lanes — the acting-lane carrier must keep that leg.
    assertFenceCause(
      () =>
        applyActingLane(engine, {
          actingContext: SESSION_CONTEXT_KEY,
          scopeSessionId: "s1",
          operations: [],
          surfaces: { writes: [SESSION_OUTPUT] },
          lease,
          nowMs: nowMs + 1,
          fence: {
            authorizeActingPrincipal: (_engine, principal) => {
              consulted.push(principal);
              return false;
            },
          },
        }),
      "lane-write-authority",
    );
    assertEquals(consulted, [PRINCIPAL]);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a CLAIMED commit's authority consults are unchanged in number and lane", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    const lanes: { contextKey: unknown; claimed: boolean }[] = [];
    const writes: string[] = [];
    const commit: ClientCommit = {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: observationFor(claim, { writes: [USER_OUTPUT] }),
    };
    Engine.applyCommit(engine, {
      sessionId: "executor-session",
      scopeSessionId: "executor-session",
      space: SPACE,
      principal: PRINCIPAL,
      commit,
      actingContext: USER_CONTEXT_KEY,
      executionClaims: new Map([[1, claim]]),
      executionLeaseFence: {
        lease,
        nowMs: nowMs + 1,
        authorize: () => true,
        laneAuthority: (query) => {
          lanes.push(laneConsultShape(query));
          return true;
        },
        authorizeActingPrincipal: (_engine, principal) => {
          writes.push(principal);
          return true;
        },
      },
    });
    // TWO consults, both claim-carrying: the lane-admission consult
    // (`admitExecutionCommitLanes`) and the fence's per-claim consult. Both
    // keep their ISSUANCE-generation pin (`claimed: true`) — strictly stronger
    // than the acting lane's liveness lookup — and the acting-lane consult
    // dedupes against them because it names the same lane. Widening authority
    // coverage must not add a third charge to the claimed set.
    assertEquals(lanes, [
      { contextKey: USER_CONTEXT_KEY, claimed: true },
      { contextKey: USER_CONTEXT_KEY, claimed: true },
    ]);
    assertEquals(writes, [PRINCIPAL]);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('an acting lane of "space" consults NEITHER lane authority', async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const consulted: unknown[] = [];
    const applied = applyActingLane(engine, {
      actingContext: "space" as SchedulerExecutionContextKey,
      operations: [],
      surfaces: { writes: [address("space", "of:lane-space-observed")] },
      lease,
      nowMs: nowMs + 1,
      fence: {
        laneAuthority: (query) => {
          consulted.push(query);
          return false;
        },
        authorizeActingPrincipal: (_engine, principal) => {
          consulted.push(principal);
          return false;
        },
      },
    });
    // Space-rank runs are not lane-scoped: neither check has a lane to
    // resolve, and both stay byte-identical to the pre-lane fence.
    assertEquals(consulted, []);
    assertExists(applied.schedulerObservationResults);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a commit naming NO lane consults NEITHER lane authority (ordinary clients are unchanged)", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const consulted: unknown[] = [];
    const applied = applyActingLane(engine, {
      operations: [],
      surfaces: { writes: [USER_OUTPUT] },
      lease,
      nowMs: nowMs + 1,
      fence: {
        laneAuthority: (query) => {
          consulted.push(query);
          return false;
        },
        authorizeActingPrincipal: (_engine, principal) => {
          consulted.push(principal);
          return false;
        },
      },
    });
    assertEquals(consulted, []);
    assertExists(applied.schedulerObservationResults);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("an exact observation replay stays idempotent after the ACTING lane is drained", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const apply = (laneLive: boolean) =>
      applyActingLane(engine, {
        actingContext: USER_CONTEXT_KEY,
        operations: [],
        surfaces: { writes: [USER_OUTPUT] },
        lease,
        nowMs: nowMs + 1,
        fence: { laneAuthority: () => laneLive },
      });
    const first = apply(true);
    assert(first.schedulerObservationResults?.[0].status === "kept");
    // Replay detection runs BEFORE the fence, so a lost-response replay of an
    // already-settled observation still returns its stored result rather than
    // fencing on the now-drained lane. The acting-lane consult must not move
    // ahead of that ordering.
    const replay = apply(false);
    assert(Engine.isAppliedCommitReplay(replay));
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The observation BATCH path — the firewall must reach it too.
//
// Slice 2a re-parameterized the firewall on the acting lane, and the batch
// fan-out (`applySchedulerObservationBatchCommit`) does not forward one, so a
// batched item reached the firewall's precondition with `actingLane ===
// undefined` and skipped every check. Batched items are the same served
// action runs as the single-observation path and must be bounded identically.

Deno.test("a CLAIMED BATCH item acting as a user lane reaches the firewall", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    const sessionOutput = address("session", "of:lane-batch-session-output");
    const commit: ClientCommit = {
      localSeq: 10,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservationBatch: [{
        localSeq: 11,
        reads: { confirmed: [], pending: [] },
        schedulerObservation: observationFor(claim, {
          writes: [sessionOutput],
        }),
      }],
    };
    assertFirewallReject(
      () =>
        Engine.applyCommit(engine, {
          sessionId: "executor-session",
          scopeSessionId: "executor-session",
          space: SPACE,
          principal: PRINCIPAL,
          commit,
          executionClaims: new Map([[11, claim]]),
          executionLeaseFence: {
            lease,
            nowMs: nowMs + 1,
            authorize: () => true,
          },
        }),
      "non-lane-scope",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("an UNCLAIMED BATCH item acting as a user lane reaches both the firewall and the lane authorities", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const sessionOutput = address("session", "of:lane-batch-unclaimed");
    const batchCommit = (
      writes: readonly SchedulerObservationAddress[],
    ): ClientCommit => ({
      localSeq: 20,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservationBatch: [{
        localSeq: 21,
        reads: { confirmed: [], pending: [] },
        schedulerObservation: unclaimedObservation({ writes }),
      }],
    });
    const applyBatch = (
      writes: readonly SchedulerObservationAddress[],
      fence?: Partial<Engine.ExecutionLeaseFence>,
    ) =>
      Engine.applyCommit(engine, {
        sessionId: "executor-session",
        scopeSessionId: "executor-session",
        space: SPACE,
        principal: PRINCIPAL,
        commit: batchCommit(writes),
        actingContext: USER_CONTEXT_KEY,
        executionLeaseFence: {
          lease,
          nowMs: nowMs + 1,
          authorize: () => true,
          ...fence,
        },
      });
    assertFirewallReject(() => applyBatch([sessionOutput]), "non-lane-scope");
    assertFenceCause(
      () => applyBatch([USER_OUTPUT], LANE_DRAINED),
      "lane-generation-stale",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// §2b ROW 8 — THE LEASE, PROMOTED. The subsumption proof.
//
// Row 8: "today [the lease] authorises claims; under blanket ownership it IS
// the authority, space-wide. `lease-stale` / `leaseOwnerMatches` /
// `leaseGeneration` survive; `claim-arity`, `claim-expired`,
// `claim-lease-generation`, `claim-not-live` go."
//
// The promotion slice deleted nothing; the pins below established, one fence
// at a time, what rejects the SAME commit once the lease is asked instead of
// the claim. THE DELETION SLICE HAS NOW RUN and the outcome was 3 of 4:
//
// | fence | outcome | carrier |
// | --- | --- | --- |
// | `claim-arity` | DELETED | `lease-unbounded-commit` |
// | `claim-expired` | DELETED | `lease-stale` (claim expiry <= lease expiry) |
// | `claim-lease-generation` | DELETED | `leaseOwnerMatches` inside `lease-stale` |
// | `claim-not-live` | **KEPT — no carrier** | see its section below |
//
// `claim-not-live` was measured, not argued: with both its sites removed an
// unprivileged client forging an `executionClaimAssertion` wrote into ANOTHER
// principal's user instance. §2b row 8's list was wrong about it in the
// fail-open direction, the same way §2a's precondition, row 5's gate, rows
// 3-4's swap and row 8's own straight swap were.
//
// The pins that named a deleted fence are RETITLED and RE-EXPECTED, never
// removed (`cf09a186b`), so the widening each deletion takes is visible here
// rather than inferred.
//
// THE ONE FENCE WITH NO CARRIER, and it is a fail-open. `claim-arity` is the
// only thing that makes a lease-bound session's SEMANTIC transaction be an
// action run at all. `lane-principal-mismatch`, `sponsor-authority` and
// `lease-stale` authorise the WRITER and bound nothing; the firewall bounds
// only what reaches it, and `firewalledActionRun` is false for a commit that
// carries no action-run observation. Delete `claim-arity` with nothing added
// and a lease-bound executor may commit ARBITRARY UNOBSERVED OPERATIONS with
// no firewall at all. `lease-unbounded-commit` is that missing carrier: the
// lease admits a semantic transaction only as a bounded reactive action run.
//
// The other three were already carried before this slice, by checks the lease
// makes about ITSELF, and the pins below say which.

/** A lease-bound executor's commit with NO scheduler observation at all — the
 * shape whose only refusal today is `claim-arity`. */
const applyUnobserved = (
  engine: Engine.Engine,
  options: {
    lease: ExecutionLease;
    nowMs: number;
    operations: Operation[];
    executionClaims?: ReadonlyMap<number, ExecutionClaim>;
    actingContext?: SchedulerExecutionContextKey;
  },
) =>
  Engine.applyCommit(engine, {
    sessionId: "executor-session",
    scopeSessionId: "executor-session",
    space: SPACE,
    principal: PRINCIPAL,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: options.operations,
    },
    ...(options.actingContext !== undefined
      ? { actingContext: options.actingContext }
      : {}),
    ...(options.executionClaims !== undefined
      ? { executionClaims: options.executionClaims }
      : {}),
    executionLeaseFence: {
      lease: options.lease,
      nowMs: options.nowMs,
      authorize: () => true,
    },
  });

const spaceOperation: Operation = {
  op: "set",
  id: "of:lease-promotion-unobserved",
  value: { value: 1 },
};

// --- claim-arity ------------------------------------------------------------

Deno.test("claim-arity subsumption: an unobserved semantic commit under the lease is refused BY THE LEASE", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const before = Engine.serverSeq(engine);
    // What `claim-arity` rejects today: operations under a lease with no live
    // claim. What rejects it once the lease is the authority: the lease's own
    // admission of a semantic transaction. Nothing else in the fence looks at
    // the commit's SHAPE, so without this the deletion slice is a fail-open.
    assertFenceCause(
      () =>
        applyUnobserved(engine, {
          lease,
          nowMs: nowMs + 1,
          operations: [spaceOperation],
        }),
      "lease-unbounded-commit",
    );
    assertEquals(Engine.serverSeq(engine), before);
    assertEquals(Engine.read(engine, { id: spaceOperation.id }), null);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("claim-arity subsumption: an event-handler observation is not a bounded action run and the lease refuses it", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    // `firewalledActionRun` excludes event-handler and non-action-run kinds,
    // so the firewall never bounds them — exactly the population `claim-arity`
    // refuses today (the host declines to mint a claim for either kind,
    // server.ts `#executionClaimsForCommit`).
    const handlerObservation: SchedulerActionObservation = {
      ...unclaimedObservation({ writes: [USER_OUTPUT] }),
      actionKind: "event-handler",
    };
    assertFenceCause(
      () =>
        applyActingLane(engine, {
          actingContext: USER_CONTEXT_KEY,
          operations: [userInstanceOperation],
          observation: handlerObservation,
          lease,
          nowMs: nowMs + 1,
        }),
      "lease-unbounded-commit",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("claim-arity subsumption: a claim for another localSeq no longer buys arity for an unobserved commit", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    // `claims.length === 1` counts the MAP, not the commit. A claim keyed at a
    // localSeq the commit does not carry satisfies `claim-arity` while naming
    // no observation at all — writes with neither a claim nor a firewall. The
    // host cannot build that map (it keys claims off the commit's own
    // observations), but the lease-level check does not need to trust it.
    assertFenceCause(
      () =>
        applyUnobserved(engine, {
          lease,
          nowMs: nowMs + 1,
          operations: [spaceOperation],
          executionClaims: new Map([[99, claimFor(lease, USER_CONTEXT_KEY)]]),
        }),
      "lease-unbounded-commit",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// RE-EXPECTED by the deletion slice (retitled, never deleted — `cf09a186b`).
// This pinned §2a's delta as still-refused, by `claim-arity`, the last fence
// standing between it and the store. `claim-arity` is now gone and the delta
// COMMITS — that is the whole point of the slice, and the assertion below is
// what makes the widening visible rather than inferred.
//
// What did NOT widen is asserted first and it is the load-bearing half: the
// firewall's bound is unchanged and still taken BEFORE any lease/claim fence,
// so an unclaimed scoped-lane run may write only inside its own lane.
Deno.test("claim-arity DELETED: THE DELTA lands — an unclaimed scoped-lane action run commits, still firewall-bounded", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    // The bound is real and it is taken FIRST: the same commit with an
    // inadmissible write rejects at the firewall, before any lease fence.
    assertFirewallReject(
      () =>
        applyActingLane(engine, {
          actingContext: USER_CONTEXT_KEY,
          operations: [sessionInstanceOperation],
          surfaces: { writes: [SESSION_OUTPUT] },
          lease,
          nowMs: nowMs + 1,
        }),
      "non-lane-scope",
    );
    // And the admissible twin — identical in every respect except that its
    // write is inside the lane it acted as — now lands with no claim at all.
    const applied = applyActingLane(engine, {
      actingContext: USER_CONTEXT_KEY,
      operations: [userInstanceOperation],
      surfaces: { writes: [USER_OUTPUT] },
      lease,
      nowMs: nowMs + 1,
    });
    assert(applied.schedulerObservationResults?.[0].status === "kept");
    assertEquals(
      Engine.read(engine, {
        id: USER_OUTPUT.id,
        scope: "user",
        principal: PRINCIPAL,
      }),
      { value: 7 },
    );
    // The inadmissible twin still landed NOTHING at the session instance.
    assertEquals(
      Engine.read(engine, {
        id: SESSION_OUTPUT.id,
        scope: "session",
        principal: PRINCIPAL,
        sessionId: "executor-session",
      }),
      null,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("claim-arity subsumption: an OBSERVATION-ONLY commit is not a semantic transaction and neither fence applies", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    // `semanticTransaction` is `commit.operations.length > 0`; the lease-level
    // check binds the identical population, so the observation-only path stays
    // byte-identical — it is admitted with no claim today and still is.
    const applied = applyActingLane(engine, {
      actingContext: USER_CONTEXT_KEY,
      operations: [],
      surfaces: { writes: [USER_OUTPUT] },
      lease,
      nowMs: nowMs + 1,
    });
    assert(applied.schedulerObservationResults?.[0].status === "kept");
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("claim-arity subsumption: a commit with NO lease fence is untouched (ordinary clients are unchanged)", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    // The lease-level check is the LEASE's, so it binds only lease-bound
    // sessions. An ordinary client writing without any observation — the whole
    // client population — never reaches it.
    const applied = Engine.applyCommit(engine, {
      sessionId: "client-session",
      scopeSessionId: "client-session",
      space: SPACE,
      principal: PRINCIPAL,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [spaceOperation],
      },
    });
    assertEquals(applied.revisions.length, 1);
    assertEquals(Engine.read(engine, { id: spaceOperation.id }), { value: 1 });
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// --- claim-expired ----------------------------------------------------------

Deno.test("claim-expired subsumption: the LEASE's own fuse fires first, because a claim never outlives its lease", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    // The host mints `expiresAt: Math.min(claimNow + ttlMs, lease.expiresAt)`
    // (server.ts:6305), so claim expiry <= lease expiry ALWAYS. At the claim's
    // longest possible life the two coincide, and `lease-stale` — which is
    // checked before the claim loop — is the cause. Every commit
    // `claim-expired` can reject at that bound is therefore already rejected
    // by the lease's own liveness check, sampled from the same clock.
    assertEquals(claim.expiresAt, lease.expiresAt);
    assertFenceCause(
      () =>
        applyClaimed(engine, lease, claim, {
          operations: [userInstanceOperation],
          surfaces: { writes: [USER_OUTPUT] },
          nowMs: lease.expiresAt,
        }),
      "lease-stale",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// RE-EXPECTED by the deletion slice (retitled, never deleted — `cf09a186b`).
// The promotion pinned this window as the one refusal `claim-expired` made
// that no carrier makes; the deletion TAKES it, and this is where that shows.
// The committer is still the sole authority (`lease-stale` passes, asserted
// by its sibling pin above) and its writes are still firewall-bounded, so the
// dropped refusal is work the server did and then threw away — the arc's
// operational target.
Deno.test("claim-expired DELETED: THE WIDENING taken — a short-TTL claim expiring inside a live lease no longer refuses", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    // With claimTtlMs shorter than the lease's remaining life the claim dies
    // first. That window used to refuse `claim-expired`; now it commits.
    const shortLived: ExecutionClaim = {
      ...claimFor(lease, USER_CONTEXT_KEY),
      expiresAt: nowMs + 10,
    };
    assert(shortLived.expiresAt < lease.expiresAt);
    const widened = applyClaimed(engine, lease, shortLived, {
      operations: [userInstanceOperation],
      surfaces: { writes: [USER_OUTPUT] },
      nowMs: nowMs + 11,
    });
    assert(widened.schedulerObservationResults?.[0].status === "kept");
    // The lease itself was always untouched by the claim's death: the
    // identical commit at the identical clock, with the claim's own fuse
    // removed, commits — as it did before the deletion.
    const applied = applyClaimed(
      engine,
      lease,
      claimFor(
        lease,
        USER_CONTEXT_KEY,
      ),
      {
        operations: [userInstanceOperation],
        surfaces: { writes: [USER_OUTPUT] },
        nowMs: nowMs + 11,
        localSeq: 2,
      },
    );
    assert(applied.schedulerObservationResults?.[0].status === "kept");
    // AND THE BOUND THAT REMAINS, so the widening cannot be read as "the claim
    // clock stopped mattering, therefore nothing does": past the LEASE's own
    // fuse the same expired-claim commit is still refused, by the carrier.
    assertFenceCause(
      () =>
        applyClaimed(engine, lease, shortLived, {
          operations: [userInstanceOperation],
          surfaces: { writes: [USER_OUTPUT] },
          nowMs: lease.expiresAt,
          localSeq: 3,
        }),
      "lease-stale",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// --- claim-lease-generation -------------------------------------------------

Deno.test("claim-lease-generation subsumption: leaseOwnerMatches pins the generation against the durable row, before any claim is read", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const stale = acquire(engine, nowMs);
    const claim = claimFor(stale, USER_CONTEXT_KEY);
    Engine.revokeExecutionLease(engine, { lease: stale, nowMs: nowMs + 1 });
    const current = acquire(engine, nowMs + 2);
    assertEquals(current.leaseGeneration, stale.leaseGeneration + 1);
    // `claim-lease-generation` compares `claim.leaseGeneration` against the
    // durable row. The claim's generation IS the lease's — the host resolves a
    // claim only when `live.leaseGeneration === binding.lease.leaseGeneration`
    // (server.ts:4609-4614) — so the same comparison is available directly
    // from the lease, and `lease-stale`'s `leaseOwnerMatches` already makes it
    // (generation + hostId + onBehalfOf) before the claim loop runs.
    assertFenceCause(
      () =>
        applyClaimed(engine, stale, claim, {
          operations: [userInstanceOperation],
          surfaces: { writes: [USER_OUTPUT] },
          nowMs: nowMs + 3,
        }),
      "lease-stale",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("claim-lease-generation subsumption: its space/branch half is ALREADY dead — claim-observation-mismatch makes the identical comparison first", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    // Measured, not assumed: this pin was written expecting
    // `claim-lease-generation` and the engine says otherwise.
    // `acceptedSchedulerObservation` (`engine.ts:9833`) compares
    // `claim.branch !== options.branch || claim.space !== options.space` — the
    // BYTE-IDENTICAL comparison — and it runs before the lease fence, so this
    // half of `claim-lease-generation` is unreachable. Only its
    // `leaseGeneration` leg is live, and the pin above carries that one.
    //
    // On the host path neither can differ anyway: the claim is looked up by a
    // key built from the commit's own (space, branch) (server.ts:4598-4608).
    const foreign: ExecutionClaim = {
      ...claimFor(lease, USER_CONTEXT_KEY),
      space: "did:key:z6Mk-lane-firewall-other-space",
    };
    assertFenceCause(
      () =>
        applyClaimed(engine, lease, foreign, {
          operations: [userInstanceOperation],
          surfaces: { writes: [USER_OUTPUT] },
          nowMs: nowMs + 1,
        }),
      "claim-observation-mismatch",
    );
    // The lease-level pair check, on the same commit, with the lease moved to
    // another space: a cause that survives claim deletion untouched.
    assertFenceCause(
      () =>
        applyClaimed(
          engine,
          {
            ...lease,
            space: "did:key:z6Mk-lane-firewall-other-space",
          },
          claimFor(lease, USER_CONTEXT_KEY),
          {
            operations: [userInstanceOperation],
            surfaces: { writes: [USER_OUTPUT] },
            nowMs: nowMs + 1,
          },
        ),
      "lane-principal-mismatch",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

// --- claim-not-live ---------------------------------------------------------

/** THE PROBE THE DELETION SLICE OWED, and it is why `claim-not-live` is STILL
 * HERE while the other three fences are gone.
 *
 * An ORDINARY client — no lease fence, no acting context, no live claim —
 * forges an `executionClaimAssertion` naming ANOTHER principal's user lane and
 * writes into that lane's instance. `commitLaneAssertions` reads the assertion
 * straight off the wire observation, so the forged key is what resolves the
 * commit's lane AND its scope identity. `claim-not-live` is what refuses it.
 *
 * MEASURED, not argued. With both `claim-not-live` sites removed this exact
 * commit APPLIED, at `scopeKey: "user:did%3Akey%3Az6Mk-lane-firewall-bob"` —
 * alice writing into bob's user instance with no authority of any kind. That
 * is cross-principal leak prevention, which the arc's survival test puts in
 * the SURVIVES column, not arbitration.
 *
 * The acting-lane grant consult cannot carry this case: it lives inside the
 * lease fence and this commit carries no lease. `claim-not-live` therefore has
 * no carrier for the unbound-client population and the deletion is BLOCKED on
 * building one — a lane assertion must be authorised as a lane assertion,
 * independent of whether a claim happens to exist. */
Deno.test("claim-not-live: a forged claim assertion cannot name another principal's lane", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    const forged: ExecutionClaim = {
      branch: "",
      space: SPACE,
      contextKey: OTHER_USER_CONTEXT_KEY,
      pieceId: PIECE_ID,
      actionId: ACTION_ID,
      actionKind: "computation",
      implementationFingerprint: IMPLEMENTATION_FINGERPRINT,
      runtimeFingerprint: RUNTIME_FINGERPRINT,
      leaseGeneration: 1,
      claimGeneration: 1,
      expiresAt: 0,
    };
    assertFenceCause(
      () =>
        Engine.applyCommit(engine, {
          sessionId: "client-session",
          scopeSessionId: "client-session",
          space: SPACE,
          principal: PRINCIPAL,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [userInstanceOperation],
            schedulerObservation: observationFor(forged, {
              writes: [USER_OUTPUT],
            }),
          },
        }),
      "claim-not-live",
    );
    // Nothing landed at EITHER principal's instance.
    assertEquals(
      Engine.read(engine, {
        id: USER_OUTPUT.id,
        scope: "user",
        principal: OTHER_PRINCIPAL,
      }),
      null,
    );
    assertEquals(
      Engine.read(engine, {
        id: USER_OUTPUT.id,
        scope: "user",
        principal: PRINCIPAL,
      }),
      null,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("claim-not-live subsumption: the acting lane's own grant consult refuses the same drained lane", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    // TODAY: the commit asserts a claim the host resolved as not live.
    assertFenceCause(
      () =>
        applyActingLane(engine, {
          actingContext: USER_CONTEXT_KEY,
          operations: [],
          observation: observationFor(claim, { writes: [USER_OUTPUT] }),
          lease,
          nowMs: nowMs + 1,
        }),
      "claim-not-live",
    );
    // PROMOTED: the same lane, asserted by nothing, with its grant gone —
    // `lane-generation-stale` from the lease fence's own lane consult. The
    // claim's liveness was only ever a proxy for the GRANT's.
    assertFenceCause(
      () =>
        applyActingLane(engine, {
          actingContext: USER_CONTEXT_KEY,
          operations: [],
          surfaces: { writes: [USER_OUTPUT] },
          lease,
          nowMs: nowMs + 1,
          fence: LANE_DRAINED,
          localSeq: 2,
        }),
      "lane-generation-stale",
    );
    // And with the grant live it commits — the widening is exactly the
    // claim-shaped half, nothing more.
    const applied = applyActingLane(engine, {
      actingContext: USER_CONTEXT_KEY,
      operations: [],
      surfaces: { writes: [USER_OUTPUT] },
      lease,
      nowMs: nowMs + 1,
      localSeq: 3,
    });
    assert(applied.schedulerObservationResults?.[0].status === "kept");
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("claim-not-live subsumption: RESIDUAL — the promoted consult fences LATER than the claim it replaces", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    const claim = claimFor(lease, USER_CONTEXT_KEY);
    const sessionOutput = address("session", "of:lease-promotion-residual");
    // `claim-not-live` fires inside `admitExecutionCommitLanes`, which runs
    // BEFORE preconditions, read validation and the write firewall — C1.4's
    // "a forged or fenced lane learns nothing about scoped state". So a
    // not-live claim outranks an inadmissible write:
    assertFenceCause(
      () =>
        applyActingLane(engine, {
          actingContext: USER_CONTEXT_KEY,
          operations: [],
          observation: observationFor(claim, { writes: [sessionOutput] }),
          lease,
          nowMs: nowMs + 1,
        }),
      "claim-not-live",
    );
    // The promoted consult lives at the END of the lease fence
    // (`assertActingLaneAuthority`), so the SAME drained lane reaches the
    // firewall first. Not a write fail-open — nothing applies either way — but
    // it IS a position the deletion slice must restore, and this pin is what
    // makes the change visible when it does.
    assertFirewallReject(
      () =>
        applyActingLane(engine, {
          actingContext: USER_CONTEXT_KEY,
          operations: [],
          surfaces: { writes: [sessionOutput] },
          lease,
          nowMs: nowMs + 1,
          fence: LANE_DRAINED,
          localSeq: 2,
        }),
      "non-lane-scope",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("claim-not-live subsumption: BLOCKER — an unserved-attempt marker still requires a live claim", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const lease = acquire(engine, nowMs);
    // The SECOND `claim-not-live` site (`acceptedSchedulerObservation`), which
    // §1d's table does not list: an `executionUnservedAttempt` marker with no
    // live claim is refused outright. Under blanket ownership EVERY unserved
    // marker is unclaimed, so this fence has no carrier and no replacement —
    // it must be resolved before `claim-not-live` is deleted.
    //
    // STILL OPEN after the deletion slice, and now with the shape of the fix
    // named: simply dropping the throw is NOT the fix. `untrustedObservation`
    // strips `executionUnservedAttempt` and the unclaimed return reports no
    // `unservedDiagnosticCode`, so the marker would vanish and the attempt
    // would be recorded as an ordinary SERVED observation — clearing the
    // action's dirtiness for a run that never served. The carrier has to
    // PRESERVE the marker on the unclaimed path, not just stop refusing it.
    const marker: SchedulerActionObservation = {
      ...unclaimedObservation({ writes: [USER_OUTPUT] }),
      executionUnservedAttempt: { diagnosticCode: "unknown-effect-surface" },
    } as SchedulerActionObservation;
    assertFenceCause(
      () =>
        applyActingLane(engine, {
          actingContext: USER_CONTEXT_KEY,
          operations: [],
          observation: marker,
          lease,
          nowMs: nowMs + 1,
        }),
      "claim-not-live",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});
