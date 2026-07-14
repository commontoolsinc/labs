import { assert, assertEquals, assertExists } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";

const TEST_AUDIENCE = "did:key:z6Mk-runner-acl-bootstrap-audience";

class RecordingLoopbackSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;
  readonly principals: string[] = [];
  readonly sessions: Array<{
    space: MemorySpace;
    requested: MemoryV2Client.MountOptions;
    actualSessionId: string;
  }> = [];

  constructor(private readonly server: MemoryV2Server.Server) {}

  async create(
    space: MemorySpace,
    signer?: Signer,
    requested: MemoryV2Client.MountOptions = {},
  ) {
    this.principals.push(signer?.did() ?? "<anonymous>");
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.server),
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
