import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  selectCommitsSince,
  selectDocHead,
} from "@commonfabric/memory/v2/engine";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";

const TEST_AUDIENCE = "did:key:z6Mk-runner-acl-bootstrap-audience";

class RecordingLoopbackSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;
  readonly principals: string[] = [];
  readonly sessions: Array<{
    space: MemorySpace;
    requested: MemoryV2Client.MountOptions;
    actualSessionId: string;
  }> = [];

  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  async create(
    space: MemorySpace,
    signer?: Signer,
    requested: MemoryV2Client.MountOptions = {},
  ) {
    this.principals.push(signer?.did() ?? "<anonymous>");
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server),
    });
    const session = await client.mount(
      space,
      requested,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    this.sessions.push({
      space,
      requested: { ...requested },
      actualSessionId: session.sessionId,
    });
    return { client, session };
  }
}

class TestStorageManager extends StorageManager {
  static overServer(
    options: Omit<Options, "memoryHost">,
    factory: SessionFactory,
  ): TestStorageManager {
    return new TestStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      factory,
    );
  }
}

const createServer = (
  label: string,
  options: {
    store?: URL;
    mode?: "off" | "observe" | "enforce";
  } = {},
): MemoryV2Server.Server =>
  new MemoryV2Server.Server({
    store: options.store ?? new URL(`memory://${label}`),
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: TEST_AUDIENCE },
    acl: { mode: options.mode ?? "enforce" },
    subscriptionRefreshDelayMs: 0,
  });

Deno.test("storage manager uses one session id across spaces and isolates managers", async () => {
  const alice = await Identity.fromPassphrase("manager session alice");
  const bob = await Identity.fromPassphrase("manager session bob");
  const firstSpace = "did:key:z6Mk-manager-session-first" as MemorySpace;
  const secondSpace = "did:key:z6Mk-manager-session-second" as MemorySpace;
  const server = createServer("runner-manager-session-id", { mode: "off" });
  const aliceFactory = new RecordingLoopbackSessionFactory(server);
  const bobFactory = new RecordingLoopbackSessionFactory(server);
  const aliceManager = TestStorageManager.overServer(
    { as: alice },
    aliceFactory,
  );
  const bobManager = TestStorageManager.overServer({ as: bob }, bobFactory);

  try {
    assert(aliceManager.id !== bobManager.id);
    for (const targetSpace of [firstSpace, secondSpace]) {
      const sync = await aliceManager.open(targetSpace).sync(
        "of:manager-session-probe" as URI,
      );
      assert(!sync.error, sync.error?.message);
    }
    const bobSync = await bobManager.open(firstSpace).sync(
      "of:manager-session-probe" as URI,
    );
    assert(!bobSync.error, bobSync.error?.message);

    assertEquals(
      aliceFactory.sessions.map((entry) => ({
        space: entry.space,
        requestedSessionId: entry.requested.sessionId,
        actualSessionId: entry.actualSessionId,
      })),
      [firstSpace, secondSpace].map((targetSpace) => ({
        space: targetSpace,
        requestedSessionId: aliceManager.id,
        actualSessionId: aliceManager.id,
      })),
    );
    assertEquals(bobFactory.sessions, [{
      space: firstSpace,
      requested: { sessionId: bobManager.id },
      actualSessionId: bobManager.id,
    }]);

    await aliceManager.close();
    for (const targetSpace of [firstSpace, secondSpace]) {
      const sync = await aliceManager.open(targetSpace).sync(
        "of:manager-session-reopen-probe" as URI,
      );
      assert(!sync.error, sync.error?.message);
    }
    const reopenedSessions = aliceFactory.sessions.slice(2);
    assertEquals(reopenedSessions.length, 2);
    assert(
      reopenedSessions[0].actualSessionId !== aliceManager.id,
      "a closed manager lifecycle must not reuse its invalidated session id",
    );
    assertEquals(
      reopenedSessions[1].actualSessionId,
      reopenedSessions[0].actualSessionId,
    );
  } finally {
    await aliceManager.close();
    await bobManager.close();
    await server.close();
  }
});

Deno.test("storage ACL bootstrap uses the named-space identity then returns to the user", async () => {
  const user = await Identity.fromPassphrase("acl bootstrap user");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl bootstrap named space",
  );
  const space = spaceIdentity.did();
  const server = createServer("runner-acl-bootstrap-named");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer(
    { as: user, spaceIdentity },
    factory,
  );
  try {
    const sync = await manager.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);

    const acl = await server.readDocument(space, `of:${space}`);
    assertEquals(acl?.value, {
      [user.did()]: "OWNER",
      "*": "WRITE",
    });
    assertEquals(factory.principals, [
      user.did(),
      spaceIdentity.did(),
      user.did(),
    ]);
    assertEquals(factory.sessions.length, 3);
    assertEquals(factory.sessions[0].actualSessionId, manager.id);
    assertEquals(factory.sessions[0].requested, { sessionId: manager.id });
    assert(factory.sessions[1].actualSessionId !== manager.id);
    assertEquals(
      factory.sessions[1].requested.sessionId,
      factory.sessions[1].actualSessionId,
    );
    assertEquals(factory.sessions[2].actualSessionId, manager.id);
    assertEquals(factory.sessions[2].requested.sessionId, manager.id);
    assertExists(factory.sessions[2].requested.sessionToken);

    const guest = await Identity.fromPassphrase("acl bootstrap named guest");
    const guestConnection = await new RecordingLoopbackSessionFactory(server)
      .create(space, guest);
    try {
      await guestConnection.session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:guest-write",
          value: { value: { public: true } },
        }],
      });
      assertEquals(
        (await server.readDocument(space, "of:guest-write"))?.value,
        { public: true },
      );
    } finally {
      await guestConnection.client.close();
    }
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("storage ACL bootstrap accepts multiple runtime-derived space identities", async () => {
  const user = await Identity.fromPassphrase("acl bootstrap multi user");
  const first = await Identity.fromPassphrase("acl bootstrap multi first");
  const second = await Identity.fromPassphrase("acl bootstrap multi second");
  const server = createServer("runner-acl-bootstrap-multi");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  manager.registerSpaceIdentity(first);
  manager.registerSpaceIdentity(second);
  try {
    for (const identity of [first, second]) {
      const space = identity.did();
      const sync = await manager.open(space).sync(`of:${space}` as URI);
      assert(!sync.error, sync.error?.message);
      assertEquals(
        (await server.readDocument(space, `of:${space}`))?.value,
        { [user.did()]: "OWNER", "*": "WRITE" },
      );
    }
    assertEquals(factory.principals, [
      user.did(),
      first.did(),
      user.did(),
      user.did(),
      second.did(),
      user.did(),
    ]);
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("concurrent named-space bootstrap has one owner and both sessions succeed", async () => {
  const alice = await Identity.fromPassphrase("acl bootstrap race alice");
  const bob = await Identity.fromPassphrase("acl bootstrap race bob");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl bootstrap race named space",
  );
  const space = spaceIdentity.did();
  const server = createServer("runner-acl-bootstrap-race");
  const aliceManager = TestStorageManager.overServer(
    { as: alice, spaceIdentity },
    new RecordingLoopbackSessionFactory(server),
  );
  const bobManager = TestStorageManager.overServer(
    { as: bob, spaceIdentity },
    new RecordingLoopbackSessionFactory(server),
  );
  try {
    const results = await Promise.all([
      aliceManager.open(space).sync("of:race-alice" as URI),
      bobManager.open(space).sync("of:race-bob" as URI),
    ]);
    // One ACL genesis wins. The losing initializer can still reopen and write
    // through the winner's rollout-default wildcard WRITE grant.
    assertEquals(
      results.filter((result) => result.error === undefined).length,
      2,
    );

    const acl = (await server.readDocument(space, `of:${space}`))?.value;
    assert(acl !== null && typeof acl === "object" && !Array.isArray(acl));
    const grants = acl as Record<string, unknown>;
    assertEquals(grants["*"], "WRITE");
    assertEquals(
      [alice.did(), bob.did()].filter((did) => grants[did] === "OWNER")
        .length,
      1,
    );
    assertEquals(Object.keys(grants).length, 2);
  } finally {
    await aliceManager.close();
    await bobManager.close();
    await server.close();
  }
});

Deno.test("storage ACL bootstrap claims a fresh home space privately", async () => {
  const user = await Identity.fromPassphrase("acl bootstrap home user");
  const space = user.did();
  const server = createServer("runner-acl-bootstrap-home");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  try {
    const sync = await manager.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);

    const acl = await server.readDocument(space, `of:${space}`);
    assertEquals(acl?.value, { [space]: "OWNER" });
    assertEquals(factory.principals, [space, space, space]);
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("storage ACL bootstrap privatizes a populated legacy home space", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "runner-acl-bootstrap-home-legacy-",
  });
  const store = toFileUrl(`${directory}/`);
  const user = await Identity.fromPassphrase(
    "acl bootstrap populated home user",
  );
  const space = user.did();
  try {
    const seedServer = createServer("unused", { store, mode: "off" });
    try {
      await seedServer.writeDocument(space, "of:legacy-home", {
        legacy: true,
      });
    } finally {
      await seedServer.close();
    }

    const server = createServer("unused", { store });
    const factory = new RecordingLoopbackSessionFactory(server);
    const manager = TestStorageManager.overServer({ as: user }, factory);
    try {
      const sync = await manager.open(space).sync("of:legacy-home" as URI);
      assert(!sync.error, sync.error?.message);
      assertEquals(
        (await server.readDocument(space, `of:${space}`))?.value,
        { [space]: "OWNER" },
      );
      assertEquals(factory.principals, [space, space, space]);
    } finally {
      await manager.close();
      await server.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("storage ACL bootstrap does not recreate a retracted home ACL", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "runner-acl-bootstrap-home-retracted-",
  });
  const store = toFileUrl(`${directory}/`);
  const user = await Identity.fromPassphrase(
    "acl bootstrap retracted home user",
  );
  const space = user.did();
  const aclId = `of:${space}` as URI;
  try {
    const seedServer = createServer("unused", { store, mode: "off" });
    try {
      await seedServer.writeDocument(space, aclId, {
        [space]: "OWNER",
      });
      const seeded = await new RecordingLoopbackSessionFactory(seedServer)
        .create(space, user);
      try {
        await seeded.session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "delete", id: aclId }],
        });
      } finally {
        await seeded.client.close();
      }
      assertEquals(await seedServer.readDocument(space, aclId), null);
    } finally {
      await seedServer.close();
    }

    const server = createServer("unused", { store });
    const factory = new RecordingLoopbackSessionFactory(server);
    const manager = TestStorageManager.overServer({ as: user }, factory);
    try {
      const sync = await manager.open(space).sync(aclId);
      assert(!sync.error, sync.error?.message);
      assertEquals(await server.readDocument(space, aclId), null);
      assertEquals(factory.principals, [space]);
    } finally {
      await manager.close();
      await server.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("storage ACL bootstrap leaves populated named spaces public", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "runner-acl-bootstrap-named-legacy-",
  });
  const store = toFileUrl(`${directory}/`);
  const user = await Identity.fromPassphrase(
    "acl bootstrap populated named user",
  );
  const spaceIdentity = await Identity.fromPassphrase(
    "acl bootstrap populated named space",
  );
  const space = spaceIdentity.did();
  try {
    const seedServer = createServer("unused", { store, mode: "off" });
    try {
      await seedServer.writeDocument(space, "of:legacy-named", {
        legacy: true,
      });
    } finally {
      await seedServer.close();
    }

    const server = createServer("unused", { store });
    const factory = new RecordingLoopbackSessionFactory(server);
    const manager = TestStorageManager.overServer(
      { as: user, spaceIdentity },
      factory,
    );
    try {
      const sync = await manager.open(space).sync("of:legacy-named" as URI);
      assert(!sync.error, sync.error?.message);
      assertEquals(await server.readDocument(space, `of:${space}`), null);
      assertEquals(factory.principals, [user.did()]);
    } finally {
      await manager.close();
      await server.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

//
// OW31 (RULED 2026-08-18; verification-coverage.md): a PROVISIONED
// space's genesis is signed by the space's own keys and names the ACTING
// USER as OWNER in that same first commit — the serving identity appears
// nowhere in the ACL. The client shape (no owner supplied → the signer,
// i.e. the active user) is pinned byte-for-byte by the named-space tests
// above.
//

Deno.test("storage ACL bootstrap names the supplied genesis owner, not the signer (OW31)", async () => {
  const service = await Identity.fromPassphrase("acl bootstrap ow31 service");
  const alice = await Identity.fromPassphrase("acl bootstrap ow31 alice");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl bootstrap ow31 provisioned",
  );
  const space = spaceIdentity.did();
  const server = createServer("runner-acl-bootstrap-ow31-owner");
  const factory = new RecordingLoopbackSessionFactory(server);
  // The serving posture: the manager authenticates as the SERVICE, and
  // the space identity is registered with the ACTING user as genesis
  // owner (threaded from the serving-side resolveSpaceName).
  const manager = TestStorageManager.overServer({ as: service }, factory);
  // Red-first witnessed: without the owner option this minted
  // { [service]: "OWNER", "*": "WRITE" } (the OW31 defect, observed in
  // this test's red run).
  manager.registerSpaceIdentity(spaceIdentity, { owner: alice.did() });
  try {
    const sync = await manager.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);

    // ACL owner = the acting user; the service principal appears NOWHERE.
    const acl = await server.readDocument(space, `of:${space}`);
    assertEquals(acl?.value, {
      [alice.did()]: "OWNER",
      "*": "WRITE",
    });
    assert(
      !(service.did() in (acl?.value as Record<string, unknown>)),
      "the service principal must appear nowhere in the genesis ACL",
    );

    // Genesis actor = the space DID (the bootstrap session signs as the
    // space; owner ≠ signer): normal mount, bootstrap mount, resume.
    assertEquals(factory.principals, [
      service.did(),
      spaceIdentity.did(),
      service.did(),
    ]);

    // The space's commit #1 IS the ACL commit.
    const engine = await server.engineForSpace(space);
    assertEquals(
      selectDocHead(engine, { id: `of:${space}`, scopeKey: "space" }),
      1,
      "the genesis ACL must be the space's first commit",
    );
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("storage without the space signer cannot initialize a foreign space", async () => {
  const user = await Identity.fromPassphrase("acl bootstrap foreign user");
  const space = "did:key:z6Mk-runner-acl-foreign" as MemorySpace;
  const server = createServer("runner-acl-bootstrap-foreign");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  try {
    const sync = await manager.open(space).sync("of:foreign-probe" as URI);
    assert(!sync.error, sync.error?.message);
    assertEquals(await server.readDocument(space, `of:${space}`), null);
    assertEquals(factory.principals, [user.did()]);

    const replica = manager.open(space).replica;
    assertExists(replica.commitNative);
    const write = await replica.commitNative({
      operations: [{
        op: "set",
        id: "of:foreign-write" as URI,
        type: "application/json",
        value: { denied: true },
      }],
    });
    assertExists(write.error, "ordinary writes must not create the space");
  } finally {
    await manager.close();
    await server.close();
  }
});

//
// Genesis-supplied ACL: a caller that holds the space key may name the
// exact document a fresh space is born with, so the space is never in a
// world-writable state it did not ask for. Absent, the rollout default
// (owner + wildcard WRITE — the tests above) is the fallback. The option
// is inert outside true genesis: a populated ACL-less space, a retracted
// ACL, and the home arm all behave as if it were never supplied.
//

Deno.test("a supplied genesis ACL is the space's first and only commit — no wildcard row ever existed", async () => {
  const daemon = await Identity.fromPassphrase("acl genesis supplied daemon");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis supplied space",
  );
  const space = spaceIdentity.did();
  const aclId = `of:${space}` as URI;
  const server = createServer("runner-acl-genesis-supplied");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: daemon }, factory);
  // The downstream shape Loom's share mint wants: the space key is the only
  // OWNER, the minting daemon is a WRITE principal, nobody else is named.
  const supplied = {
    [space]: "OWNER" as const,
    [daemon.did()]: "WRITE" as const,
  };
  manager.registerSpaceIdentity(spaceIdentity, { genesisAcl: supplied });
  try {
    const sync = await manager.open(space).sync(aclId);
    assert(!sync.error, sync.error?.message);

    // The server's stored history, not the client's belief: seq 1 is the
    // ACL, it is the only commit, and its value is exactly the document.
    const engine = await server.engineForSpace(space);
    assertEquals(
      selectDocHead(engine, { id: aclId, scopeKey: "space" }),
      1,
      "the supplied ACL must be the space's first commit",
    );
    assertEquals(
      selectCommitsSince(engine, { fromSeq: 0 }).map((commit) => commit.seq),
      [1],
      "genesis must be the only commit — no intermediate default was written",
    );
    const stored = (await server.readDocument(space, aclId))?.value as
      | Record<string, unknown>
      | undefined;
    assertEquals(stored, supplied);
    assert(stored !== undefined && !("*" in stored), "no wildcard row");
    assertEquals(factory.principals, [
      daemon.did(),
      spaceIdentity.did(),
      daemon.did(),
    ]);

    // Behavioral proof the wildcard never applied: a stranger's write is
    // refused where the rollout default would have admitted it.
    const stranger = await Identity.fromPassphrase(
      "acl genesis supplied stranger",
    );
    const strangerFactory = new RecordingLoopbackSessionFactory(server);
    await assertRejects(
      () => strangerFactory.create(space, stranger),
      Error,
      undefined,
      "an unnamed principal must not even open a sealed space",
    );
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("a supplied genesis ACL without a concrete OWNER is refused by the server and the space stays uninitialized", async () => {
  const daemon = await Identity.fromPassphrase("acl genesis unowned daemon");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis unowned space",
  );
  const space = spaceIdentity.did();
  const aclId = `of:${space}` as URI;
  const server = createServer("runner-acl-genesis-unowned");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: daemon }, factory);
  // Structurally a valid ACL, but its only OWNER is the wildcard — the
  // server's existing genesis check refuses it; the client adds no check.
  manager.registerSpaceIdentity(spaceIdentity, {
    genesisAcl: { "*": "OWNER", [daemon.did()]: "WRITE" },
  });
  try {
    await assertRejects(
      () => manager.ensureSpaceInitialized(space),
      Error,
      "concrete OWNER",
    );
    // Uninitialized: no ACL, no commits, and ordinary writes still need
    // genesis (the client could not mint an unowned space).
    assertEquals(await server.readDocument(space, aclId), null);
    const engine = await server.engineForSpace(space);
    assertEquals(selectCommitsSince(engine, { fromSeq: 0 }), []);
    assertEquals(factory.principals, [daemon.did(), spaceIdentity.did()]);
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("registerSpaceIdentity refuses a genesis ACL together with an owner, and snapshots the document", async () => {
  const user = await Identity.fromPassphrase("acl genesis both user");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis both space",
  );
  const space = spaceIdentity.did();
  const server = createServer("runner-acl-genesis-both");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  try {
    // Two descriptions of one document: refused rather than silently
    // preferring one.
    assertThrows(
      () =>
        manager.registerSpaceIdentity(spaceIdentity, {
          owner: user.did(),
          genesisAcl: { [user.did()]: "OWNER" },
        }),
      Error,
      "genesisAcl",
    );
    // The document is copied at registration: a caller mutating their
    // object afterwards cannot change what genesis writes.
    const supplied: Record<string, "READ" | "WRITE" | "OWNER"> = {
      [user.did()]: "OWNER",
    };
    manager.registerSpaceIdentity(spaceIdentity, { genesisAcl: supplied });
    supplied["*"] = "WRITE";
    const sync = await manager.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);
    assertEquals((await server.readDocument(space, `of:${space}`))?.value, {
      [user.did()]: "OWNER",
    });
  } finally {
    await manager.close();
    await server.close();
  }
});

/** Open `space` on a fresh manager over `store`, with or without a supplied
 * genesis ACL, and report what the server holds afterwards. The two arms of
 * an "inert outside genesis" test must agree on every field. */
const observeOpen = async (
  store: URL,
  user: Signer,
  spaceIdentity: Signer,
  probe: URI,
  genesisAcl?: Record<string, "READ" | "WRITE" | "OWNER">,
) => {
  const space = spaceIdentity.did() as MemorySpace;
  const server = createServer("unused", { store });
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  manager.registerSpaceIdentity(
    spaceIdentity,
    genesisAcl !== undefined ? { genesisAcl } : undefined,
  );
  try {
    const sync = await manager.open(space).sync(probe);
    const engine = await server.engineForSpace(space);
    return {
      syncFailed: sync.error !== undefined,
      acl: (await server.readDocument(space, `of:${space}`))?.value ?? null,
      commits: selectCommitsSince(engine, { fromSeq: 0 }).map((c) => c.seq),
      principals: [...factory.principals],
    };
  } finally {
    await manager.close();
    await server.close();
  }
};

Deno.test("a supplied genesis ACL is inert on a populated ACL-less named space (legacy public stays public)", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "runner-acl-genesis-legacy-",
  });
  const store = toFileUrl(`${directory}/`);
  const user = await Identity.fromPassphrase("acl genesis legacy user");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis legacy space",
  );
  const space = spaceIdentity.did();
  try {
    const seedServer = createServer("unused", { store, mode: "off" });
    try {
      await seedServer.writeDocument(space, "of:legacy-named", {
        legacy: true,
      });
    } finally {
      await seedServer.close();
    }
    const without = await observeOpen(
      store,
      user,
      spaceIdentity,
      "of:legacy-named" as URI,
    );
    const withAcl = await observeOpen(
      store,
      user,
      spaceIdentity,
      "of:legacy-named" as URI,
      { [space]: "OWNER" },
    );
    assertEquals(withAcl, without);
    assertEquals(without.acl, null, "the legacy space must not be claimed");
    assertEquals(without.principals, [user.did()], "no bootstrap session");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

// Mutation note: the legacy-space test above reddens when the option is
// let past the client's true-genesis preconditions (witnessed). This one
// does not — a retracted ACL fails closed at the SERVER before any
// bootstrap session can act, in both arms — so it pins that the option
// changes no observable outcome there, not that a client guard exists.
Deno.test("a supplied genesis ACL is inert on a retracted named ACL (a tombstone is never recreated)", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "runner-acl-genesis-retracted-",
  });
  const store = toFileUrl(`${directory}/`);
  const user = await Identity.fromPassphrase("acl genesis retracted user");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis retracted space",
  );
  const space = spaceIdentity.did();
  const aclId = `of:${space}` as URI;
  try {
    const seedServer = createServer("unused", { store, mode: "off" });
    try {
      await seedServer.writeDocument(space, aclId, { [user.did()]: "OWNER" });
      const seeded = await new RecordingLoopbackSessionFactory(seedServer)
        .create(space, user);
      try {
        await seeded.session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "delete", id: aclId }],
        });
      } finally {
        await seeded.client.close();
      }
      assertEquals(await seedServer.readDocument(space, aclId), null);
    } finally {
      await seedServer.close();
    }
    const without = await observeOpen(store, user, spaceIdentity, aclId);
    const withAcl = await observeOpen(store, user, spaceIdentity, aclId, {
      [space]: "OWNER",
    });
    assertEquals(withAcl, without);
    assertEquals(without.acl, null, "the tombstone must stand");
    assertEquals(without.commits, [1, 2], "no third commit");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a genesis ACL registered under the home identity does not reach the home arm", async () => {
  const user = await Identity.fromPassphrase("acl genesis home user");
  const space = user.did();
  const server = createServer("runner-acl-genesis-home");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  // The home arm is not generalized over: it claims owner-only regardless.
  manager.registerSpaceIdentity(user, {
    genesisAcl: { "*": "WRITE", [space]: "OWNER" },
  });
  try {
    const sync = await manager.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);
    assertEquals((await server.readDocument(space, `of:${space}`))?.value, {
      [space]: "OWNER",
    });
    // The home arm's own three-session dance, every one as the home identity.
    assertEquals(factory.principals, [space, space, space]);
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("runtime.resolveSpaceName threads a supplied genesis ACL to the named space's first commit", async () => {
  const user = await Identity.fromPassphrase("acl genesis resolve user");
  const member = await Identity.fromPassphrase("acl genesis resolve member");
  const server = createServer("runner-acl-genesis-resolve");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
  });
  try {
    const supplied = {
      [user.did()]: "OWNER" as const,
      [member.did()]: "WRITE" as const,
    };
    // The public seam: the name resolves to a DID and registers the derived
    // space key with the document, and the first open writes it verbatim.
    const space = await runtime.resolveSpaceName("genesis-acl-probe", {
      genesisAcl: supplied,
    });
    await manager.ensureSpaceInitialized(space);
    const engine = await server.engineForSpace(space);
    assertEquals(
      selectCommitsSince(engine, { fromSeq: 0 }).map((commit) => commit.seq),
      [1],
    );
    assertEquals(
      (await server.readDocument(space, `of:${space}`))?.value,
      supplied,
    );
    // A serving-posture refusal is unchanged by the new option: owner is
    // still required there (OW31), and the two cannot be combined.
    await assertRejects(
      () =>
        runtime.resolveSpaceName("genesis-acl-both", {
          owner: user.did(),
          genesisAcl: supplied,
        }),
      Error,
      "not both",
    );
  } finally {
    await runtime.dispose();
    await manager.close();
    await server.close();
  }
});
