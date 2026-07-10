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

  constructor(private readonly server: MemoryV2Server.Server) {}

  async create(space: MemorySpace, signer?: Signer) {
    this.principals.push(signer?.did() ?? "<anonymous>");
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.server),
    });
    const session = await client.mount(
      space,
      {},
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
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
    assertEquals(acl?.value, { [user.did()]: "OWNER" });
    assertEquals(factory.principals, [
      user.did(),
      spaceIdentity.did(),
      user.did(),
    ]);
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("concurrent named-space bootstrap has a single winning owner", async () => {
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
    assertEquals(
      results.filter((result) => result.error === undefined).length,
      1,
    );

    const acl = (await server.readDocument(space, `of:${space}`))?.value;
    assert(
      JSON.stringify(acl) === JSON.stringify({ [alice.did()]: "OWNER" }) ||
        JSON.stringify(acl) === JSON.stringify({ [bob.did()]: "OWNER" }),
      `expected exactly one bootstrap winner, got ${JSON.stringify(acl)}`,
    );
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
