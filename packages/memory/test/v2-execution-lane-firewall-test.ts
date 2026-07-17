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
  SCOPE_NAMING_LINK_CONFORMANCE,
  scopeNamingLinkForPath,
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
