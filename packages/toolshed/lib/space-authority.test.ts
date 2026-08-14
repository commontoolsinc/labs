import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { Runtime } from "@commonfabric/runner";
import {
  createAclServer,
  genesisAcl,
  LoopbackSessionFactory,
  TestStorageManager,
} from "@/lib/test-support/memory-acl.ts";
import {
  authorizeSpaceOwner,
  hostsSpaceInStore,
  isExplicitSpaceOwner,
  isValidSpaceDid,
} from "@/lib/space-authority.ts";

// ---------------------------------------------------------------------------
// The narrow entitlement predicate. Cheap, exhaustive, and the place the
// wildcard attack is pinned — see the "*" cases.
// ---------------------------------------------------------------------------

// Shaped like real ed25519 did:keys, and valid base58btc (no 0, O, I or l).
const ALICE = "did:key:z6MkaaaabbbbccccddddeeeeffffgggghhhhAAAA";
const MALLORY = "did:key:z6MkmmmmnnnnppppqqqqrrrrssssttttuuuuBBBB";

describe("isExplicitSpaceOwner", () => {
  it("admits an explicit concrete OWNER grant", () => {
    expect(isExplicitSpaceOwner({ [ALICE]: "OWNER" }, ALICE)).toBe(true);
  });

  it("refuses WRITE and READ", () => {
    expect(isExplicitSpaceOwner({ [ALICE]: "WRITE" }, ALICE)).toBe(false);
    expect(isExplicitSpaceOwner({ [ALICE]: "READ" }, ALICE)).toBe(false);
  });

  // THE load-bearing case. The genesis default for a named space is
  // `{ owner: "OWNER", "*": "WRITE" }`, so every authenticated principal holds
  // WRITE. A proof-of-write ceremony (the rejected Option A) would admit
  // Mallory here; the OWNER predicate must not.
  it("refuses a principal covered only by the `*: WRITE` genesis default", () => {
    const acl = { [ALICE]: "OWNER", "*": "WRITE" } as const;
    expect(isExplicitSpaceOwner(acl, ALICE)).toBe(true);
    expect(isExplicitSpaceOwner(acl, MALLORY)).toBe(false);
  });

  // spaceReaderRole resolves `acl[principal] ?? acl["*"]`, so it would return
  // "owner" for Mallory here. That is why this seam does NOT reuse it: a
  // permissive oracle is right for the render fit and wrong for minting write
  // authority. Reachable in production via `cf acl set ANYONE OWNER`.
  it("refuses a principal covered only by a wildcard OWNER grant", () => {
    const acl = { [ALICE]: "OWNER", "*": "OWNER" } as const;
    expect(isExplicitSpaceOwner(acl, MALLORY)).toBe(false);
  });

  it("fails closed on absent, malformed, and non-ACL values", () => {
    expect(isExplicitSpaceOwner(null, ALICE)).toBe(false);
    expect(isExplicitSpaceOwner(undefined, ALICE)).toBe(false);
    // deno-lint-ignore no-explicit-any
    expect(isExplicitSpaceOwner({ [ALICE]: "SUPERUSER" } as any, ALICE)).toBe(
      false,
    );
    // deno-lint-ignore no-explicit-any
    expect(isExplicitSpaceOwner("OWNER" as any, ALICE)).toBe(false);
  });

  it("does not admit inherited Object.prototype keys", () => {
    expect(isExplicitSpaceOwner({ [ALICE]: "OWNER" }, "constructor")).toBe(
      false,
    );
    expect(isExplicitSpaceOwner({ [ALICE]: "OWNER" }, "toString")).toBe(false);
  });
});

describe("hostsSpaceInStore", () => {
  // A non-NotFound stat error (here ENOTDIR: a path segment that is a file)
  // must read as "not hosted" rather than escaping as an uncaught 500 from
  // every control-plane call.
  it("treats an unreadable store as not hosting the space", () => {
    const hosts = hostsSpaceInStore(new URL("file:///dev/null/not-a-dir/"));
    expect(hosts(ALICE)).toBe(false);
  });
});

describe("isValidSpaceDid", () => {
  it("accepts a well-formed did:key", () => {
    expect(isValidSpaceDid(ALICE)).toBe(true);
  });

  // Each of these reaches four consumers that must agree: the hosted-space
  // lookup, the ACL key, the `\n`-joined channel id, and the `.sqlite` filename.
  it("rejects newlines, whitespace, and non-did:key forms", () => {
    expect(isValidSpaceDid(`${ALICE}\nprod`)).toBe(false);
    expect(isValidSpaceDid(`${ALICE} `)).toBe(false);
    expect(isValidSpaceDid(` ${ALICE}`)).toBe(false);
    expect(isValidSpaceDid("did:web:example.com")).toBe(false);
    expect(isValidSpaceDid("did:key:")).toBe(false);
    expect(isValidSpaceDid("")).toBe(false);
    // base58btc excludes 0, O, I and l — a homoglyph must not slip through.
    expect(isValidSpaceDid("did:key:z0OIl0OIl0OIl0OIl0OIl0OIl")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Against a REAL memory-v2 server with ACL enforcement on.
//
// This is the fixture the existing ingest suite lacks: ingest.utils.test.ts uses
// StorageManager.emulate, whose server is constructed with no `acl` option at
// all, so `#aclMode()` returns "off" and no authorization is exercised. Without
// the harness below, the central security property of this feature — "refused
// when naming a space you don't control" — is not testable, and a regression
// would pass CI silently.
// ---------------------------------------------------------------------------

describe("authorizeSpaceOwner against real ACL enforcement", () => {
  let server: MemoryV2Server.Server;
  let factory: LoopbackSessionFactory;
  let operator: Identity;
  let alice: Identity;
  let mallory: Identity;
  let spaceIdentity: Identity;
  let space: string;
  let storageManager: TestStorageManager;
  let runtime: Runtime;

  const deps = () => ({
    runtime,
    operatorDid: operator.did(),
    serviceDids: [] as readonly string[],
    hostsSpace: () => true,
  });

  beforeEach(async () => {
    server = createAclServer(`space-authority-${crypto.randomUUID()}`);
    factory = new LoopbackSessionFactory(server);
    operator = await Identity.fromPassphrase("space-authority-operator");
    alice = await Identity.fromPassphrase("space-authority-alice");
    mallory = await Identity.fromPassphrase("space-authority-mallory");
    spaceIdentity = await Identity.fromPassphrase("space-authority-space");
    space = spaceIdentity.did();
    storageManager = TestStorageManager.overServer({ as: operator }, factory);
    runtime = new Runtime({
      apiUrl: new URL("https://space-authority-test.invalid"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  it("admits the explicit owner and refuses a wildcard-WRITE stranger", async () => {
    // The genesis default shape for a named space.
    await genesisAcl(factory, spaceIdentity, {
      [alice.did()]: "OWNER",
      "*": "WRITE",
    });

    const owner = await authorizeSpaceOwner(deps(), space, alice.did());
    expect(owner.ok).toBe(true);

    const stranger = await authorizeSpaceOwner(deps(), space, mallory.did());
    expect(stranger.ok).toBe(false);
    assert(!stranger.ok);
    expect(stranger.kind).toBe("not-owner");
  });

  it("returns a byte-identical denial for unhosted and not-owned spaces", async () => {
    await genesisAcl(factory, spaceIdentity, {
      [alice.did()]: "OWNER",
      "*": "WRITE",
    });

    const notOwned = await authorizeSpaceOwner(deps(), space, mallory.did());
    const notHosted = await authorizeSpaceOwner(
      { ...deps(), hostsSpace: () => false },
      space,
      alice.did(),
    );

    assert(!notOwned.ok);
    assert(!notHosted.ok);
    // The existence oracle is the thing being prevented: a caller must not be
    // able to tell "this deployment hosts that space" from "you are not its
    // owner". Only the server-side logDetail differs.
    expect(notHosted.kind).toBe(notOwned.kind);
    expect(notHosted.message).toBe(notOwned.message);
    expect(notHosted.logDetail).not.toBe(notOwned.logDetail);
  });

  it("refuses everyone when the space has no ACL, without leaking that fact", async () => {
    const result = await authorizeSpaceOwner(deps(), space, alice.did());
    expect(result.ok).toBe(false);
    assert(!result.ok);
    // No ACL => no concrete owner => nobody is an owner. Collapsing this into
    // the ordinary denial is both true and fail-closed.
    expect(result.kind).toBe("not-owner");
  });

  // The operator is granted WRITE deliberately: without it the operator cannot
  // read the ACL at all and this passes via `operator-denied`, which would be
  // false confidence — it would prove nothing about the caller's capability.
  it("refuses a caller holding only READ", async () => {
    await genesisAcl(factory, spaceIdentity, {
      [alice.did()]: "OWNER",
      [mallory.did()]: "READ",
      [operator.did()]: "WRITE",
    });
    const result = await authorizeSpaceOwner(deps(), space, mallory.did());
    expect(result.ok).toBe(false);
    assert(!result.ok);
    expect(result.kind).toBe("not-owner");
  });

  // Fail loudly at create, not silently at ingest: with an owner-only ACL the
  // operator has no grant, so a channel minted here would accept POSTs and
  // commit nothing. The caller has proven ownership, so the detail is theirs.
  it("refuses with an actionable error when the operator cannot write", async () => {
    await genesisAcl(factory, spaceIdentity, {
      [alice.did()]: "OWNER",
      [operator.did()]: "READ",
    });

    const result = await authorizeSpaceOwner(deps(), space, alice.did());
    expect(result.ok).toBe(false);
    assert(!result.ok);
    expect(result.kind).toBe("operator-cannot-write");
    expect(result.message).toContain(operator.did());
  });

  it("admits when the operator holds WRITE via an explicit grant", async () => {
    await genesisAcl(factory, spaceIdentity, {
      [alice.did()]: "OWNER",
      [operator.did()]: "WRITE",
    });
    const result = await authorizeSpaceOwner(deps(), space, alice.did());
    expect(result.ok).toBe(true);
  });

  // The memory server short-circuits authorization entirely when the deployment
  // is not enforcing, so predicting a denial from the ACL would refuse work the
  // server would happily accept — which breaks local dev outright and would
  // silently disable minting if ops rolled back to `observe`.
  it("skips the operator-write prediction when the deployment does not enforce", async () => {
    // Operator holds no grant, so under enforce it cannot write.
    await genesisAcl(factory, spaceIdentity, { [alice.did()]: "OWNER" });
    const enforced = await authorizeSpaceOwner(deps(), space, alice.did());
    expect(enforced.ok).toBe(false);

    // Same ACL, non-enforcing deployment: the write would land, so admit.
    const offServer = createAclServer(`sa-off-${crypto.randomUUID()}`, "off");
    const offFactory = new LoopbackSessionFactory(offServer);
    const offStorage = TestStorageManager.overServer(
      { as: operator },
      offFactory,
    );
    const offRuntime = new Runtime({
      apiUrl: new URL("https://space-authority-test.invalid"),
      storageManager: offStorage,
    });
    try {
      await genesisAcl(offFactory, spaceIdentity, { [alice.did()]: "OWNER" });
      const relaxed = await authorizeSpaceOwner(
        { ...deps(), runtime: offRuntime, aclMode: "off" },
        space,
        alice.did(),
      );
      expect(relaxed.ok).toBe(true);
    } finally {
      await offRuntime.dispose();
      await offStorage.close();
      await offServer.close();
    }
  });

  it("admits when the operator is a configured service DID", async () => {
    await genesisAcl(factory, spaceIdentity, {
      [alice.did()]: "OWNER",
      "*": "READ",
    });
    const result = await authorizeSpaceOwner(
      { ...deps(), serviceDids: [operator.did()] },
      space,
      alice.did(),
    );
    expect(result.ok).toBe(true);
  });
});
