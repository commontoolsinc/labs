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

/** A served run's commit with no claim and no lease fence — the post-deletion
 * shape. `actingContext` is the ONLY thing naming its lane. */
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
  });
};

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
