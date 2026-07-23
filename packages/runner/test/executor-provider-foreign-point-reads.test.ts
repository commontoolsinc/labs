// C3.4 — executor foreign point reads, runner side: the provider space
// guard relaxes for READS ONLY (a lease-bound channel's foreign
// `docs.read` becomes an authenticated point read served off the session
// path — never through `pinBranch`, so the home branch is never stamped
// onto a foreign read), the Worker's read-only per-(foreign space) mount
// keyed (space, id, scopeKey), fail-closed consumption, and the pinned
// intermediate posture: stamped data LANDS while the attempt still
// settles canonically unserved (`foreign-read-space`) until C3.6 relaxes
// the servability classifier (C3.5 relaxed the ENGINE's fourth reject
// site and landed the vector basis, 2026-07-18 — the router-level
// posture here is unchanged: the STATIC classifier still refuses).
//
// Fixture map (plan row C3.4; the memory-side file
// `packages/memory/test/v2-execution-cross-space-point-read-test.ts`
// owns the host wire flow, C3A4 liveness, epoch stamps, correlation,
// and link parity):
//  (a) in-process e2e through the CHANNEL: `readForeignDoc` under a
//      live space-lane claim lands the stamped document in the foreign
//      mount — entry keyed (space, id, scopeKey "space") carrying
//      {seq, branch, document, authorizationEpoch} in the READ space's
//      domains (the C3.5 vector-basis / C3.8 fence seam); ingestion is
//      monotonic (strictly-newer seq replaces; an equal-seq re-read
//      keeps the held entry); home replica reads through the same
//      channel stay byte-identical around the foreign read.
//  (d) fail-closed consumption: a denied read throws the typed
//      AuthorizationError LEADING with `foreign-read-access-denied`,
//      lands NOTHING in the mount, and issues exactly ONE wire frame
//      (bounded — no retry spin).
//  (e) decision #3 at the channel send side: a user/session-scoped
//      foreign address refuses with `foreign-read-scoped-address`
//      before any wire traffic (the serve side is the memory file's).
//  (g) provider-guard regression: foreign `transact` and `graph.query`
//      keep the byte-identical AuthorizationError; a foreign
//      `docs.read` on a LEASE-LESS channel keeps it too (the relax is
//      lease-bound-only); the foreign arm's frame validations reject
//      branch/atSeq selectors, actingContext, multi-doc batches, and
//      claim-less frames as ProtocolError with zero foreign frames; a
//      revoked claim rides the constant C1.3 fence shape end-to-end.
//  (posture) the action router: a claimed attempt whose observation
//      reads a foreign space still routes UNSERVED with
//      `foreign-read-space` (canonical claim assertion attached) while
//      `onForeignReadSurface` reports the deduped, path-rooted foreign
//      READ addresses the wake-refresh consumes; since C3.5 the router
//      ALSO attaches the Worker's `foreignReadStamps` assertion (from
//      `foreignReadStampsForAction`) beside the claim assertion — the
//      carriage C3.6's classifier relax inherits unchanged.
//
// Dated pointers: C3.6 relaxes the servability classifier behind the
// dial (the `dynamic-foreign-read-space` arm of the per-attempt firewall
// is C3.6's too — C3.5 deliberately left the whole runner classifier
// conservative); C3.8 re-validates stamped epochs at the apply fence;
// C3.10b owns link-loss pending reads.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type ResponseMessage,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import {
  type CrossSpaceMessage,
  parseCrossSpaceMessage,
} from "@commonfabric/memory/v2/cross-space";
import {
  createExecutorActionTransactionRouter,
  type ExecutorCandidateDiagnostic,
} from "../src/executor/action-transaction-router.ts";
import {
  createHostProviderChannel,
  HostStorageManager,
} from "../src/storage/v2-host-provider.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import type { ClientCommit, ExecutionClaim } from "@commonfabric/memory/v2";

const HOME = "did:key:z6Mk-xpr-foreign-home" as MemorySpace;
const READ_SPACE = "did:key:z6Mk-xpr-foreign-read" as MemorySpace;
const ADMIN = "did:key:z6Mk-xpr-foreign-admin";
const SPONSOR = "did:key:z6Mk-xpr-foreign-sponsor";
const OTHER = "did:key:z6Mk-xpr-foreign-other";
const AUDIENCE = "did:key:z6Mk-xpr-foreign-audience";

const PIECE_ROOT = "of:xpr-foreign:piece";
const SCHEDULER_PIECE_ID = `space:${PIECE_ROOT}`;
const ACTION_ID = "action:xpr-foreign-reader";
const HOME_DOC = "of:xpr-foreign:home";
const FOREIGN_DOC = "of:xpr-foreign:source";

const EXECUTION_FLAGS = {
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
  serverPrimaryExecutionContextLatticeClaimsV1: true,
};

const createServer = (name: string): Server =>
  new Server(
    {
      store: new URL(`memory://${name}`),
      authorizeSessionOpen: (message: { authorization?: unknown }) => {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: AUDIENCE },
      protocolFlags: EXECUTION_FLAGS,
      acl: { mode: "enforce", serviceDids: [ADMIN] },
    } as unknown as ConstructorParameters<typeof Server>[0],
  );

const connectClient = (server: Server): Promise<MemoryClient.Client> =>
  MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: EXECUTION_FLAGS,
  } as MemoryClient.ConnectOptions);

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(
    branch: string,
    pieces: readonly string[],
  ): Promise<boolean>;
};

const mountAs = async (
  client: MemoryClient.Client,
  space: string,
  principal: string,
): Promise<ExecutionSession> =>
  await client.mount(space, {}, (_space, _session, context) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal },
  })) as ExecutionSession;

/** Tap every frame crossing the in-process cross-space transport (the
 * loopback channel broadcasts to every onMessage handler). */
const tapCrossSpaceFrames = (server: Server): CrossSpaceMessage[] => {
  const frames: CrossSpaceMessage[] = [];
  server.crossSpaceRouter().transport.channelTo(HOME).onMessage((wire) => {
    const parsed = parseCrossSpaceMessage(wire);
    if (parsed.ok) frames.push(parsed.message);
  });
  return frames;
};

const foreignPointReadFrames = (
  frames: readonly CrossSpaceMessage[],
): readonly CrossSpaceMessage[] =>
  frames.filter((frame) => frame.type === "foreign-point-read");

interface ForeignHarness {
  server: Server;
  frames: CrossSpaceMessage[];
  storage: HostStorageManager;
  provider: ReturnType<HostStorageManager["open"]>;
  lease: NonNullable<Awaited<ReturnType<Server["acquireExecutionLease"]>>>;
  claimRef: Parameters<HostStorageManager["readForeignDoc"]>[1];
  claim: ExecutionClaim;
  other: ExecutionSession;
  otherSeq: { next: number };
  close(): Promise<void>;
}

/**
 * Enforcing-ACL two-space harness with the real lease-bound channel:
 * HOME (sponsor WRITE) runs the executor plane — demand, lease,
 * lease-bound provider channel, mounted Worker replica, live space-lane
 * claim; READ_SPACE (per-fixture ACL) holds a doc written by OTHER.
 */
const setupForeignHarness = async (
  name: string,
  options: {
    readAcl?: Record<string, "READ" | "WRITE" | "OWNER">;
  } = {},
): Promise<ForeignHarness> => {
  const server = createServer(name);
  const frames = tapCrossSpaceFrames(server);
  const adminClient = await connectClient(server);
  const adminHome = await mountAs(adminClient, HOME, ADMIN);
  const adminRead = await mountAs(adminClient, READ_SPACE, ADMIN);
  await adminHome.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: `of:${HOME}`,
      value: { value: { [ADMIN]: "OWNER", [SPONSOR]: "WRITE" } },
    }],
  });
  await adminRead.transact({
    localSeq: 2,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: `of:${READ_SPACE}`,
      value: {
        value: options.readAcl ?? {
          [ADMIN]: "OWNER",
          [SPONSOR]: "READ",
          [OTHER]: "WRITE",
        },
      },
    }],
  });
  const otherClient = await connectClient(server);
  const other = await mountAs(otherClient, READ_SPACE, OTHER);
  const otherSeq = { next: 1 };
  await other.transact({
    localSeq: otherSeq.next++,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id: FOREIGN_DOC, value: { value: 41 } }],
  });
  const sponsorClient = await connectClient(server);
  const sponsor = await mountAs(sponsorClient, HOME, SPONSOR);
  await sponsor.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id: HOME_DOC, value: { value: 7 } }],
  });
  await sponsor.setExecutionDemand("", [PIECE_ROOT]);
  const lease = await server.acquireExecutionLease(HOME, "");
  assert(lease !== null, "sponsor lease");
  const claim = await server.setExecutionClaim(lease, {
    branch: "",
    space: HOME,
    contextKey: "space",
    pieceId: SCHEDULER_PIECE_ID,
    actionId: ACTION_ID,
    actionKind: "computation",
    implementationFingerprint: "impl:xpr-foreign",
    runtimeFingerprint: "runtime:xpr-foreign",
  });
  const channel = createHostProviderChannel({
    server,
    space: HOME,
    executionLease: lease,
  });
  const storage = HostStorageManager.connect({
    port: channel.port,
    principal: HOME,
    space: HOME,
    protocolFlags: EXECUTION_FLAGS,
  });
  const provider = storage.open(HOME);
  // Mount the Worker replica session (the foreign leg requires it) and
  // pin the home-read baseline through the same channel.
  assertEquals(
    (await provider.sync(HOME_DOC, { path: [], schema: false })).error,
    undefined,
  );
  const claimRef = {
    contextKey: claim.contextKey,
    pieceId: SCHEDULER_PIECE_ID,
    actionId: ACTION_ID,
    actionKind: "computation" as const,
    implementationFingerprint: "impl:xpr-foreign",
    runtimeFingerprint: "runtime:xpr-foreign",
    leaseGeneration: claim.leaseGeneration,
    claimGeneration: claim.claimGeneration,
  };
  return {
    server,
    frames,
    storage,
    provider,
    lease,
    claimRef,
    claim,
    other,
    otherSeq,
    close: async () => {
      await storage.close();
      await channel.dispose();
      await sponsorClient.close();
      await otherClient.close();
      await adminClient.close();
      await server.close();
    },
  };
};

const homeDocAddress = {
  id: HOME_DOC,
  type: "application/json",
  path: [],
} as Parameters<
  ReturnType<HostStorageManager["open"]>["replica"]["get"]
>[0];

Deno.test("C3.4 (a): readForeignDoc lands the stamped document in the per-space foreign mount; ingestion is monotonic; home reads through the same channel stay byte-identical", async () => {
  const harness = await setupForeignHarness("xpr-foreign-mount");
  try {
    const homeBefore = harness.provider.replica.get(homeDocAddress)?.is;
    assertEquals(homeBefore, { value: 7 }, "home baseline through the channel");

    const first = await harness.storage.readForeignDoc(
      READ_SPACE,
      harness.claimRef,
      { id: FOREIGN_DOC },
    );
    assert(first.status === "served");
    assertEquals(first.space, READ_SPACE);
    assertEquals(
      (first.document as { value?: unknown } | null)?.value,
      41,
    );
    // Decision #4: the READ space's default branch — the home channel
    // branch was never stamped onto the foreign read (pinBranch is
    // structurally bypassed by the foreign arm).
    assertEquals(first.branch, "");
    assertEquals(first.authorizationEpoch.space, READ_SPACE);
    assertEquals(first.authorizationEpoch.principal, SPONSOR);

    // The mount: one (space, id, scopeKey "space") entry in the READ
    // space's replica structure — never a space-blind cache.
    assertEquals(harness.storage.foreignMountSpaces(), [READ_SPACE]);
    const held = harness.storage.foreignDocument(READ_SPACE, FOREIGN_DOC);
    assert(held !== undefined, "the served read landed in the mount");
    assertEquals(held, {
      space: READ_SPACE,
      id: FOREIGN_DOC,
      scopeKey: "space",
      seq: first.seq,
      branch: first.branch,
      document: first.document,
      authorizationEpoch: first.authorizationEpoch,
    });
    // The C3.5/C3.8 seam: the basis enumeration exposes exactly the
    // (space, seq) + epoch stamps the vector basis and apply fence read.
    assertEquals(harness.storage.foreignMountEntries(READ_SPACE), [held]);

    // Monotonic ingestion: a B commit then a re-read replaces the entry
    // at a strictly newer stamped seq.
    await harness.other.transact({
      localSeq: harness.otherSeq.next++,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: FOREIGN_DOC, value: { value: 43 } }],
    });
    const second = await harness.storage.readForeignDoc(
      READ_SPACE,
      harness.claimRef,
      { id: FOREIGN_DOC },
    );
    assert(second.status === "served");
    assert(second.seq > first.seq, "the B commit advanced the stamp");
    const replaced = harness.storage.foreignDocument(READ_SPACE, FOREIGN_DOC);
    assert(replaced !== undefined);
    assertEquals(replaced.seq, second.seq);
    assertEquals(
      (replaced.document as { value?: unknown } | null)?.value,
      43,
    );
    // An equal-seq re-read does NOT replace the held entry (the
    // strictly-newer discipline: a delayed response can never roll the
    // mount backwards).
    const third = await harness.storage.readForeignDoc(
      READ_SPACE,
      harness.claimRef,
      { id: FOREIGN_DOC },
    );
    assert(third.status === "served");
    assertEquals(third.seq, second.seq);
    assertStrictEquals(
      harness.storage.foreignDocument(READ_SPACE, FOREIGN_DOC),
      replaced,
      "equal-seq ingestion kept the held entry",
    );

    // Home reads through the same channel are byte-identical around the
    // foreign traffic — the guard relax touched only the foreign arm.
    assertEquals(
      (await harness.provider.sync(HOME_DOC, { path: [], schema: false }))
        .error,
      undefined,
    );
    assertEquals(harness.provider.replica.get(homeDocAddress)?.is, homeBefore);
  } finally {
    await harness.close();
  }
});

Deno.test("C3.4 (d): a denied foreign read is fail-closed at the Worker — typed error leading with the named code, nothing lands, exactly one wire frame (bounded)", async () => {
  const harness = await setupForeignHarness("xpr-foreign-denied", {
    // The sponsor (acting principal of the space lane) is NOT listed.
    readAcl: { [ADMIN]: "OWNER", [OTHER]: "WRITE" },
  });
  try {
    const framesBefore = foreignPointReadFrames(harness.frames).length;
    let thrown: Error | undefined;
    try {
      await harness.storage.readForeignDoc(
        READ_SPACE,
        harness.claimRef,
        { id: FOREIGN_DOC },
      );
    } catch (error) {
      thrown = error as Error;
    }
    assert(thrown !== undefined, "the denial surfaced as a typed error");
    assertEquals(thrown.name, "AuthorizationError");
    assert(
      thrown.message.startsWith("foreign-read-access-denied"),
      `message leads with the named code: ${thrown.message}`,
    );
    // Fail-closed consumption: the mount holds only authorized data.
    assertEquals(harness.storage.foreignMountSpaces(), []);
    assertEquals(
      harness.storage.foreignDocument(READ_SPACE, FOREIGN_DOC),
      undefined,
    );
    assertEquals(harness.storage.foreignMountEntries(READ_SPACE), []);
    // Bounded: exactly ONE request crossed — no retry spin.
    assertEquals(
      foreignPointReadFrames(harness.frames).length,
      framesBefore + 1,
    );
  } finally {
    await harness.close();
  }
});

Deno.test("C3.4 (e): a scoped foreign address refuses at the channel send side with the named code and zero wire frames (decision #3)", async () => {
  const harness = await setupForeignHarness("xpr-foreign-scoped");
  try {
    for (const scope of ["user", "session"] as const) {
      const framesBefore = foreignPointReadFrames(harness.frames).length;
      let thrown: Error | undefined;
      try {
        await harness.storage.readForeignDoc(
          READ_SPACE,
          harness.claimRef,
          { id: FOREIGN_DOC, scope },
        );
      } catch (error) {
        thrown = error as Error;
      }
      assert(thrown !== undefined, `${scope}-scoped address refused`);
      assertEquals(thrown.name, "QueryError");
      assert(
        thrown.message.startsWith("foreign-read-scoped-address"),
        `message leads with the named code: ${thrown.message}`,
      );
      assertEquals(
        foreignPointReadFrames(harness.frames).length,
        framesBefore,
        "the refusal issued no wire traffic",
      );
      assertEquals(harness.storage.foreignMountSpaces(), []);
    }
  } finally {
    await harness.close();
  }
});

/** Raw-frame reply correlation over a provider channel port. */
const rawResponses = (
  port: MessagePort,
): {
  request(frame: Record<string, unknown>): Promise<ResponseMessage<unknown>>;
} => {
  const pending = new Map<
    string,
    PromiseWithResolvers<ResponseMessage<unknown>>
  >();
  port.addEventListener("message", (event: MessageEvent<unknown>) => {
    const envelope = event.data as { type?: unknown; payload?: unknown };
    if (envelope.type !== "memory" || typeof envelope.payload !== "string") {
      return;
    }
    const message = decodeMemoryBoundary(envelope.payload);
    if (typeof message !== "object" || message === null) return;
    if ((message as { type?: unknown }).type !== "response") return;
    const requestId = (message as { requestId?: unknown }).requestId;
    if (typeof requestId !== "string") return;
    pending.get(requestId)?.resolve(message as ResponseMessage<unknown>);
    pending.delete(requestId);
  });
  port.start();
  return {
    request(frame) {
      const deferred = Promise.withResolvers<ResponseMessage<unknown>>();
      pending.set(frame.requestId as string, deferred);
      port.postMessage({
        type: "memory",
        payload: encodeMemoryBoundary(frame),
      });
      return deferred.promise;
    },
  };
};

Deno.test("C3.4 (g): the guard relaxes for reads ONLY — foreign writes/queries and lease-less foreign reads keep the byte-identical rejection; the foreign arm validates its frame; a dead claim rides the constant fence shape", async () => {
  const harness = await setupForeignHarness("xpr-foreign-guard");
  const boundRejection = {
    name: "AuthorizationError",
    message: `executor provider is bound to ${HOME}`,
  };
  // Raw-frame channels of their own (the harness channel's port is owned
  // by its storage manager). The lease handle carries to a second
  // channel — binding is per-connection — so the leased raw channel has
  // the exact authority shape of the Worker's.
  const leased = createHostProviderChannel({
    server: harness.server,
    space: HOME,
    executionLease: harness.lease,
  });
  // A LEASE-LESS channel: the read relax is lease-bound-only, so its
  // foreign docs.read keeps the byte-identical guard rejection.
  const unleased = createHostProviderChannel({
    server: harness.server,
    space: HOME,
    authorizeSessionOpen: (_space, _session, context) => ({
      invocation: {
        aud: context.audience,
        challenge: context.challenge.value,
      },
      authorization: { principal: SPONSOR },
    }),
  });
  try {
    const raw = rawResponses(leased.port);
    const rawUnleased = rawResponses(unleased.port);
    const framesBefore = foreignPointReadFrames(harness.frames).length;
    const foreignDocsRead = (
      overrides: Record<string, unknown>,
      query: Record<string, unknown> = { docs: [{ id: FOREIGN_DOC }] },
    ) => ({
      type: "docs.read",
      requestId: `raw:${crypto.randomUUID()}`,
      space: READ_SPACE,
      sessionId: "session:raw",
      executionClaim: harness.claimRef,
      query,
      ...overrides,
    });

    // -- regression pins: every non-read foreign surface keeps the
    // byte-identical rejection ------------------------------------------
    const foreignTransact = await raw.request({
      type: "transact",
      requestId: "raw:foreign-transact",
      space: READ_SPACE,
      sessionId: "session:raw",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: FOREIGN_DOC, value: { value: 99 } }],
      },
    });
    assertEquals(foreignTransact.error, boundRejection);
    const foreignQuery = await raw.request({
      type: "graph.query",
      requestId: "raw:foreign-graph-query",
      space: READ_SPACE,
      sessionId: "session:raw",
      query: {
        roots: [{ id: FOREIGN_DOC, selector: { path: [], schema: false } }],
      },
    });
    assertEquals(foreignQuery.error, boundRejection);
    // The foreign doc is untouched by the rejected write.
    assertEquals(
      (await harness.server.readDocument(READ_SPACE, FOREIGN_DOC))?.value,
      41,
    );

    // A lease-LESS channel gets no foreign read arm at all.
    const unleasedRead = await rawUnleased.request(
      foreignDocsRead({ requestId: "raw:unleased-read" }),
    );
    assertEquals(unleasedRead.error, boundRejection);

    // -- the foreign arm's frame validations (each a ProtocolError; the
    // scoped address carries its named code) ----------------------------
    const claimless = await raw.request(
      foreignDocsRead({ executionClaim: undefined }),
    );
    assertEquals(claimless.error?.name, "ProtocolError");
    assert(
      claimless.error?.message.includes("execution claim reference"),
    );
    const withActingContext = await raw.request(
      foreignDocsRead({ actingContext: "space" }),
    );
    assertEquals(withActingContext.error?.name, "ProtocolError");
    const withBranch = await raw.request(
      foreignDocsRead({}, { docs: [{ id: FOREIGN_DOC }], branch: "side" }),
    );
    assertEquals(withBranch.error?.name, "ProtocolError");
    assert(withBranch.error?.message.includes("default branch"));
    const withAtSeq = await raw.request(
      foreignDocsRead({}, { docs: [{ id: FOREIGN_DOC }], atSeq: 3 }),
    );
    assertEquals(withAtSeq.error?.name, "ProtocolError");
    const batched = await raw.request(
      foreignDocsRead({}, {
        docs: [{ id: FOREIGN_DOC }, { id: "of:xpr-foreign:second" }],
      }),
    );
    assertEquals(batched.error?.name, "ProtocolError");
    assert(batched.error?.message.includes("exactly one document"));
    const scoped = await raw.request(
      foreignDocsRead({}, { docs: [{ id: FOREIGN_DOC, scope: "user" }] }),
    );
    assertEquals(scoped.error?.name, "QueryError");
    assert(scoped.error?.message.startsWith("foreign-read-scoped-address"));

    // -- a dead claim reference rides the constant C1.3 fence shape
    // end-to-end through the channel (home-side, before any frame) ------
    const deadClaim = await raw.request(
      foreignDocsRead({
        executionClaim: {
          ...harness.claimRef,
          claimGeneration: harness.claimRef.claimGeneration + 1,
        },
      }),
    );
    assertEquals(deadClaim.error, {
      name: "ExecutionLeaseFenceError",
      message: "claim-not-live: foreign point read requires live acting " +
        "authority at the bound generations",
    });

    // NONE of the rejections above issued a single foreign frame.
    assertEquals(
      foreignPointReadFrames(harness.frames).length,
      framesBefore,
      "every rejection stayed home-side",
    );

    // Control: the same raw channel with the live claim SERVES — the
    // zero-frame assertions above were not vacuous.
    const served = await raw.request(foreignDocsRead({}));
    assertEquals(served.error, undefined);
    const outcome = served.ok as {
      status: string;
      space: string;
      branch: string;
    };
    assertEquals(outcome.status, "served");
    assertEquals(outcome.space, READ_SPACE);
    assertEquals(outcome.branch, "");
    assertEquals(
      foreignPointReadFrames(harness.frames).length,
      framesBefore + 1,
    );
  } finally {
    await leased.dispose();
    await unleased.dispose();
    await harness.close();
  }
});

// -- (posture) the intermediate contract, pinned at the router ----------

const ROUTER_SPACE = "did:key:z6Mk-xpr-foreign-router" as MemorySpace;
const HOME_ROUTER_INPUT: IMemorySpaceAddress = {
  space: ROUTER_SPACE,
  scope: "space",
  id: "of:xpr-foreign:router-home-input",
  path: ["value"],
};
const FOREIGN_INPUT: IMemorySpaceAddress = {
  space: READ_SPACE,
  scope: "space",
  id: "of:xpr-foreign:router-input",
  path: ["value", "deep"],
};
const routerOutput = {
  space: ROUTER_SPACE,
  scope: "space" as const,
  id: "of:xpr-foreign:router-output",
  path: ["value"],
};

const foreignReadObservation = () => ({
  version: 2 as const,
  ownerSpace: ROUTER_SPACE,
  branch: "",
  pieceId: "space:of:xpr-foreign:router-piece",
  processGeneration: 1,
  actionId: "action:xpr-foreign-router",
  actionKind: "computation" as const,
  implementationFingerprint: "impl:xpr-foreign-router",
  runtimeFingerprint: "runtime:xpr-foreign-router",
  observedAtSeq: 0,
  transactionKind: "action-run" as const,
  reads: [HOME_ROUTER_INPUT, FOREIGN_INPUT],
  // A second address of the SAME foreign doc plus a second foreign doc:
  // the reported surface dedupes by (space, scope, id) and roots paths.
  shallowReads: [
    { ...FOREIGN_INPUT, path: ["value", "other"] },
    {
      space: READ_SPACE,
      scope: "space" as const,
      id: "of:xpr-foreign:router-second",
      path: [],
    },
  ],
  actualChangedWrites: [routerOutput],
  currentKnownWrites: [routerOutput],
  materializerWriteEnvelopes: [],
  completeActionScopeSummary: {
    version: 1 as const,
    complete: true as const,
    implementationFingerprint: "impl:xpr-foreign-router",
    runtimeFingerprint: "runtime:xpr-foreign-router",
    piece: {
      space: ROUTER_SPACE,
      scope: "space" as const,
      id: "of:xpr-foreign:router-piece",
      path: ["value"],
    },
    reads: [FOREIGN_INPUT],
    writes: [routerOutput],
    materializerWriteEnvelopes: [],
    directOutputs: [routerOutput],
  },
  status: "success" as const,
});

const foreignReadCommit = (): ClientCommit => ({
  localSeq: 1,
  reads: { confirmed: [], pending: [] },
  operations: [{
    op: "set",
    id: "of:xpr-foreign:router-output",
    scope: "space",
    value: { value: 42 },
  }],
  schedulerObservation: foreignReadObservation(),
});

Deno.test("C3.4 (posture): a claimed foreign-read attempt still settles canonically unserved (foreign-read-space) while onForeignReadSurface reports the deduped foreign READ addresses — the C3.5 seam", async () => {
  const action = {};
  const claim: ExecutionClaim = {
    branch: "",
    space: ROUTER_SPACE,
    contextKey: "space",
    pieceId: "space:of:xpr-foreign:router-piece",
    actionId: "action:xpr-foreign-router",
    actionKind: "computation",
    implementationFingerprint: "impl:xpr-foreign-router",
    runtimeFingerprint: "runtime:xpr-foreign-router",
    leaseGeneration: 3,
    claimGeneration: 4,
    expiresAt: 100_000,
  };
  const surfaces: Array<{
    sourceAction: object;
    addresses: readonly IMemorySpaceAddress[];
  }> = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const settled: string[] = [];
  const stampQueries: Array<readonly IMemorySpaceAddress[]> = [];
  const router = createExecutorActionTransactionRouter({
    servedSpace: ROUTER_SPACE,
    branch: "",
    claimForAction: () => claim,
    onForeignReadSurface: (sourceAction, addresses) =>
      surfaces.push({ sourceAction, addresses }),
    // C3.5: the stamp carriage — queried with the SAME deduped foreign
    // read surface, attached beside the claim assertion.
    foreignReadStampsForAction: (_sourceAction, addresses) => {
      stampQueries.push(addresses);
      return [{ space: READ_SPACE, id: FOREIGN_INPUT.id, seq: 41 }];
    },
    onCandidate: () => {
      throw new Error("a claimed unservable attempt must not re-candidate");
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onUnserved: (settledClaim, _sourceAction, diagnosticCode) => {
      assertEquals(settledClaim, claim);
      settled.push(diagnosticCode);
    },
  });

  const commit = foreignReadCommit();
  const route = await router({
    space: ROUTER_SPACE,
    commit,
    sourceAction: action,
  });
  // The pinned intermediate posture: point reads may land stamped data
  // in the mount, but the attempt STILL settles canonically unserved —
  // the servability classifier is untouched until C3.6 (C3.5 relaxed the
  // ENGINE firewall only; the router's static classify still refuses).
  assertEquals(route.disposition, "unserved");
  assert(route.disposition === "unserved");
  assertEquals(route.diagnosticCode, "foreign-read-space");
  route.onSettled?.();
  assertEquals(settled, ["foreign-read-space"]);
  // The canonical unserved settle carries the exact claim assertion AND
  // (C3.5) the Worker's stamp assertion — the same attach point the
  // upstream claimed route uses, so C3.6's classifier relax inherits the
  // carriage without router changes.
  assertEquals(
    (commit.schedulerObservation as Record<string, unknown>)
      .executionClaimAssertion,
    {
      contextKey: "space",
      leaseGeneration: 3,
      claimGeneration: 4,
    },
  );
  assertEquals(
    (commit.schedulerObservation as Record<string, unknown>)
      .foreignReadStamps,
    [{ space: READ_SPACE, id: FOREIGN_INPUT.id, seq: 41 }],
  );
  assertEquals(stampQueries.length, 1);
  assertEquals(stampQueries[0].map((address) => address.id), [
    FOREIGN_INPUT.id,
    "of:xpr-foreign:router-second",
  ]);
  // The C3.5 seam: the foreign READ surface reported once, deduped by
  // (space, scope, id) and path-rooted — the exact key shape the
  // Worker's mount refresh consumes.
  assertEquals(surfaces.length, 1);
  assertStrictEquals(surfaces[0].sourceAction, action);
  const expectedSurface: IMemorySpaceAddress[] = [
    { ...FOREIGN_INPUT, path: [] },
    {
      space: READ_SPACE,
      scope: "space",
      id: "of:xpr-foreign:router-second",
      path: [],
    },
  ];
  assertEquals([...surfaces[0].addresses], expectedSurface);

  // A home-only observation reports NO foreign surface.
  const homeAction = {};
  const homeCommit = foreignReadCommit();
  const homeObservation = foreignReadObservation();
  homeObservation.reads = [HOME_ROUTER_INPUT];
  homeObservation.shallowReads = [];
  homeObservation.completeActionScopeSummary.reads = [HOME_ROUTER_INPUT];
  homeCommit.schedulerObservation = homeObservation;
  const homeRouter = createExecutorActionTransactionRouter({
    servedSpace: ROUTER_SPACE,
    branch: "",
    claimForAction: () => undefined,
    onForeignReadSurface: (sourceAction, addresses) =>
      surfaces.push({ sourceAction, addresses }),
    onCandidate: () => {},
    onDiagnostic: () => {},
  });
  const homeRoute = await homeRouter({
    space: ROUTER_SPACE,
    commit: homeCommit,
    sourceAction: homeAction,
  });
  assertEquals(homeRoute.disposition, "local");
  assertEquals(surfaces.length, 1, "no foreign surface for a home-only run");
});
