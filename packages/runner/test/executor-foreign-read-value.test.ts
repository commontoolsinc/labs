// C3.13-2 — served foreign-read VALUE reaches a derivation read over a REAL
// HostStorageManager, through loadRoot.
//
// WHY (CV2): the C3.13-1 unit fixture proves the loadRoot seam over an EMULATED
// manager with a hand-written `foreignReadDocument`. This fixture binds the same
// carriage over the REAL executor plane: a genuine `HostStorageManager` whose
// mount is populated by the REAL authenticated point-read path
// (`readForeignDoc`), read through a Runtime-over-HostStorageManager transaction
// — the exact `loadRoot` seam the executor Worker's derivation uses when it folds
// `computed(() => (source.get() ?? 0) * 2)`. It asserts the COMPUTED VALUE (82 =
// 2×41), not the vector basis/settlement — closing the hand-attached-stamp blind
// spot at the value layer. RED before C3.13-1: the read resolves the empty home
// replica (undefined → Default<0> → 0).
//
// DISCRIMINATION: after the mount captures 41 / {inner:20}, the READ space is
// OVERWRITTEN to 999 / {inner:333}. loadRoot's mount read is synchronous (no live
// cross-space fetch), so a fold of 82/40 can come ONLY from the served MOUNT that
// C3.13 threads — never the empty replica (0) nor a live server fetch (1998/666).
//
// SCOPE NOTE: this binds the served value THROUGH loadRoot over a real Host
// provider. Driving the full `computed` to a COMMITTED settlement additionally
// requires the executor pool to integrate the claimed commit (a bare
// lease-bound provider fences the activating commit with no pool to accept it);
// that end-to-end scheduler-run-to-settlement fold is the composed gate's job
// (server-execution-cross-space-gate.test.ts asserts the settled doubled ==
// 2×foreign).

import { assert, assertEquals } from "@std/assert";
import type { MemorySpace } from "@commonfabric/memory/interface";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import { Runtime } from "../src/runtime.ts";
import {
  createHostProviderChannel,
  HostStorageManager,
} from "../src/storage/v2-host-provider.ts";

const HOME = "did:key:z6Mk-c3-13-2-home" as MemorySpace;
const READ_SPACE = "did:key:z6Mk-c3-13-2-read" as MemorySpace;
const ADMIN = "did:key:z6Mk-c3-13-2-admin";
const SPONSOR = "did:key:z6Mk-c3-13-2-sponsor";
const OTHER = "did:key:z6Mk-c3-13-2-other";
const AUDIENCE = "did:key:z6Mk-c3-13-2-audience";

const PIECE_ROOT = "of:c3-13-2:piece";
const SCHEDULER_PIECE_ID = `space:${PIECE_ROOT}`;
const ACTION_ID = "action:c3-13-2-reader";
const HOME_DOC = "of:c3-13-2:home";
const SOURCE_DOC = "of:c3-13-2:source";
const DEEP_DOC = "of:c3-13-2:deep";
const DOC_TYPE = "application/json";

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
  setExecutionDemand(branch: string, pieces: readonly string[]): Promise<boolean>;
};

const mountAs = async (
  client: MemoryClient.Client,
  space: string,
  principal: string,
): Promise<ExecutionSession> =>
  await client.mount(space, {}, (_space, _session, context) => ({
    invocation: { aud: context.audience, challenge: context.challenge.value },
    authorization: { principal },
  })) as ExecutionSession;

// The derivation the executor Worker folds: (source.get() ?? 0) * 2, and a deep
// variant reading a nested field. Applied to the value the transaction resolves
// through loadRoot — the seam under test.
const doubled = (value: unknown): number =>
  ((typeof value === "number" ? value : 0)) * 2;

Deno.test("C3.13-2: the served foreign VALUE reaches a Runtime-over-HostStorageManager derivation read through loadRoot (folds 82, not 0), at root and deep paths", async () => {
  const server = createServer(`c3-13-2-${crypto.randomUUID()}`);
  const adminClient = await connectClient(server);
  const sponsorClient = await connectClient(server);
  const otherClient = await connectClient(server);
  let workerStorage: HostStorageManager | undefined;
  let workerRuntime: Runtime | undefined;
  let channel: ReturnType<typeof createHostProviderChannel> | undefined;
  try {
    // ---- ACLs. HOME runs the executor plane (sponsor WRITE); READ_SPACE holds
    // the foreign source (sponsor READ so the served point read is authorized,
    // other WRITE so it can seed the docs). ----
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
          value: { [ADMIN]: "OWNER", [SPONSOR]: "READ", [OTHER]: "WRITE" },
        },
      }],
    });

    // OTHER seeds the foreign docs: a scalar (41) and a nested object
    // ({ inner: 20 }) — the values the mount will capture.
    const other = await mountAs(otherClient, READ_SPACE, OTHER);
    let otherSeq = 1;
    await other.transact({
      localSeq: otherSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: SOURCE_DOC, value: { value: 41 } }],
    });
    await other.transact({
      localSeq: otherSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: DEEP_DOC, value: { value: { inner: 20 } } }],
    });

    // ---- The executor WORKER plane: a lease-bound HostStorageManager. ----
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
      implementationFingerprint: "impl:c3-13-2",
      runtimeFingerprint: "runtime:c3-13-2",
    });
    channel = createHostProviderChannel({
      server,
      space: HOME,
      executionLease: lease,
    });
    workerStorage = HostStorageManager.connect({
      port: channel.port,
      principal: HOME,
      space: HOME,
      protocolFlags: EXECUTION_FLAGS,
    });
    // Mount the Worker replica session (the foreign leg requires it) and pin the
    // home-read baseline through the same channel.
    const workerProvider = workerStorage.open(HOME);
    assertEquals(
      (await workerProvider.sync(HOME_DOC, { path: [], schema: false })).error,
      undefined,
      "home baseline through the channel",
    );
    const claimRef = {
      contextKey: claim.contextKey,
      pieceId: SCHEDULER_PIECE_ID,
      actionId: ACTION_ID,
      actionKind: "computation" as const,
      implementationFingerprint: "impl:c3-13-2",
      runtimeFingerprint: "runtime:c3-13-2",
      leaseGeneration: claim.leaseGeneration,
      claimGeneration: claim.claimGeneration,
    };

    // Land BOTH served foreign reads in the Worker's mount via the real
    // authenticated point-read path (SPONSOR holds READ on READ_SPACE).
    const served = await workerStorage.readForeignDoc(READ_SPACE, claimRef, {
      id: SOURCE_DOC,
    });
    assert(served.status === "served", `source read served: ${served.status}`);
    assertEquals((served.document as { value?: unknown } | null)?.value, 41);
    const servedDeep = await workerStorage.readForeignDoc(READ_SPACE, claimRef, {
      id: DEEP_DOC,
    });
    assert(
      servedDeep.status === "served",
      `deep read served: ${servedDeep.status}`,
    );

    // DISCRIMINATION: after the mount captured 41 / {inner:20}, OTHER OVERWRITES
    // the server docs with DIFFERENT values (999 / {inner:333}). The mount holds
    // 41/20; the server now holds 999/333. loadRoot's mount read is synchronous
    // and mount-first, so a fold of 82/40 can ONLY come from the served MOUNT —
    // never the empty home replica (0, defect (iii)) nor a live fetch (1998/666).
    await other.transact({
      localSeq: otherSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: SOURCE_DOC, value: { value: 999 } }],
    });
    await other.transact({
      localSeq: otherSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: DEEP_DOC, value: { value: { inner: 333 } } }],
    });

    // The Runtime over the mount-only HostStorageManager. Its transaction reads
    // `source` (scalar root) and `deep.inner` (nested path) through loadRoot —
    // the exact read the Worker's `computed(() => (source.get() ?? 0) * 2)`
    // performs — and the derivation logic folds the resolved value.
    workerRuntime = new Runtime({
      apiUrl: new URL("https://toolshed.example/"),
      storageManager: workerStorage,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
    });
    const tx = workerRuntime.edit();
    const sourceRead = tx.read({
      space: READ_SPACE,
      id: SOURCE_DOC,
      type: DOC_TYPE,
      path: ["value"],
    });
    const deepRead = tx.read({
      space: READ_SPACE,
      id: DEEP_DOC,
      type: DOC_TYPE,
      path: ["value", "inner"],
    });
    tx.abort();

    const sourceValue = sourceRead.ok?.value;
    const deepValue = deepRead.ok?.value;
    const doubledValue = doubled(sourceValue);
    const deepDoubledValue = doubled(deepValue);
    console.log("C3.13-2 folded over HostStorageManager:", {
      sourceValue,
      deepValue,
      doubledValue,
      deepDoubledValue,
    });

    // The served scalar (mount 41, NOT the server's later 999) resolves and folds
    // to 82 — RED (undefined → 0) before C3.13-1.
    assertEquals(sourceValue, 41, "loadRoot must resolve the served mount value");
    assertEquals(
      doubledValue,
      82,
      "the served foreign VALUE must fold to 2×41 over the HostStorageManager (defect (iii): 0 pre-fix)",
    );
    // R6: the served value resolves at a DEEP read path (mount deep.inner = 20 →
    // 40, NOT the server's later 333).
    assertEquals(
      deepValue,
      20,
      "loadRoot must resolve the served mount value at a deep path",
    );
    assertEquals(
      deepDoubledValue,
      40,
      "the served foreign VALUE must fold at a deep read path (2×20)",
    );
  } finally {
    await workerRuntime?.dispose().catch(() => undefined);
    await workerStorage?.close().catch(() => undefined);
    await channel?.dispose().catch(() => undefined);
    await adminClient.close();
    await sponsorClient.close();
    await otherClient.close();
    await server.close();
  }
});
