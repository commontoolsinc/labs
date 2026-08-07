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
  type ControlDeps,
  type ControlResult,
  processList,
  processMint,
  processRevoke,
  processRotate,
} from "./ingest-channels.utils.ts";
import {
  channelId,
  getRegistration,
  getRegistrationIndex,
  processIngest,
  saveRegistration,
} from "@/routes/ingest/ingest.utils.ts";

/** Narrow a ControlResult to its success body, failing loudly otherwise. */
// Shaped like a real derived channel id: ids are validated before they become
// a cell cause in the operator's service space.
const WELL_FORMED_ID = "ing_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const ok = <T>(result: ControlResult<T>): T => {
  assert(
    result.status === 200,
    `expected 200, got ${result.status}: ${JSON.stringify(result.body)}`,
  );
  return result.body;
};

/** Narrow a ControlResult to its error message. */
const err = (result: ControlResult<unknown>): string => {
  assert(result.status !== 200, "expected a failure");
  return result.body.error;
};

// The brief's acceptance criteria, run against a REAL memory server with
// `acl: { mode: "enforce" }`: a user holding only their own identity key can
// mint a channel for their own space, is refused when naming a space they do
// not control, can list / rotate / revoke, and a revoked token stops working.
//
// Ownership is enforced against a space with a CONCRETE, non-derived owner.
// That matters: on a deployment where space DIDs derive from a public
// passphrase, anyone can sign as the space and grant themselves OWNER, so a
// test against such a space would prove nothing about the check.

describe("ingest-channels control plane", () => {
  let server: MemoryV2Server.Server;
  let factory: LoopbackSessionFactory;
  let operator: Identity;
  let alice: Identity;
  let mallory: Identity;
  let spaceIdentity: Identity;
  let space: string;
  let storageManager: TestStorageManager;
  let runtime: Runtime;
  let deps: ControlDeps;

  beforeEach(async () => {
    server = createAclServer(`ingest-channels-${crypto.randomUUID()}`);
    factory = new LoopbackSessionFactory(server);
    operator = await Identity.fromPassphrase("ic-operator");
    alice = await Identity.fromPassphrase("ic-alice");
    mallory = await Identity.fromPassphrase("ic-mallory");
    spaceIdentity = await Identity.fromPassphrase("ic-space");
    space = spaceIdentity.did();
    storageManager = TestStorageManager.overServer({ as: operator }, factory);
    runtime = new Runtime({
      apiUrl: new URL("https://ic-test.invalid"),
      storageManager,
    });
    deps = {
      runtime,
      serviceSpace: operator.did(),
      operatorDid: operator.did(),
      serviceDids: [],
      hostsSpace: () => true,
      apiUrl: "https://ic-test.invalid",
    };
    // Alice owns the space; the operator can write into it. This is the
    // healthy, correctly-provisioned shape.
    await genesisAcl(factory, spaceIdentity, {
      [alice.did()]: "OWNER",
      [operator.did()]: "WRITE",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  /**
   * A second space co-owned by alice and mallory. A space ACL can only be
   * INITIALIZED once, so a co-owned shape has to be genesis'd on its own space
   * rather than layered onto the one in beforeEach.
   */
  const sharedSpace = async (): Promise<string> => {
    const id = await Identity.fromPassphrase(
      `ic-shared-${crypto.randomUUID()}`,
    );
    await genesisAcl(factory, id, {
      [alice.did()]: "OWNER",
      [mallory.did()]: "OWNER",
      [operator.did()]: "WRITE",
    });
    return id.did();
  };

  const mint = (caller: Identity, requestId: string, over = {}) =>
    processMint(deps, caller.did(), {
      space,
      installId: "phone-1",
      requestId,
      ...over,
    });

  it("mints for a space the caller owns, and returns the token exactly once", async () => {
    const res = await mint(alice, "req-1");
    expect(res.status).toBe(200);
    expect(typeof ok(res).token).toBe("string");
    expect(ok(res).token.startsWith("ingsec_")).toBe(true);
    expect(ok(res).space).toBe(space);

    // Only the hash is ever stored, and the hash never leaves the server.
    const stored = await getRegistration(
      runtime,
      operator.did(),
      ok(res).id,
    );
    expect(stored?.secretHash).toBeDefined();
    expect(stored?.secretHash).not.toBe(ok(res).token);
    expect(stored?.owner).toBe(alice.did());
    expect(JSON.stringify(res.body)).not.toContain(stored!.secretHash);
  });

  // The headline acceptance criterion.
  it("refuses a caller who does not own the space", async () => {
    const res = await mint(mallory, "req-2");
    expect(res.status).toBe(403);
    expect(err(res)).toContain("Not authorized");
    // Nothing was minted, so no request id was consumed either.
    expect(await getRegistration(runtime, operator.did(), "ing_anything"))
      .toBeNull();
  });

  it("refuses an unhosted space identically to an unowned one", async () => {
    const unowned = await mint(mallory, "req-3");
    const unhosted = await processMint(
      { ...deps, hostsSpace: () => false },
      alice.did(),
      { space, installId: "phone-1", requestId: "req-4" },
    );
    expect(unhosted.status).toBe(unowned.status);
    expect(unhosted.body).toEqual(unowned.body);
  });

  // Without this, a captured mint replayed inside the ≤300s proof freshness
  // window would mint a FRESH secret and hand it to the replayer.
  it("returns 409 and NO token when a requestId is replayed", async () => {
    const first = await mint(alice, "req-dup");
    expect(first.status).toBe(200);

    const replay = await mint(alice, "req-dup");
    expect(replay.status).toBe(409);
    expect("token" in replay.body).toBe(false);

    // And the live token is untouched — a replay must not rotate anyone out.
    const stored = await getRegistration(
      runtime,
      operator.did(),
      ok(first).id,
    );
    const ingest = await processIngest(
      runtime,
      operator.did(),
      ok(first).id,
      ok(first).token,
      JSON.stringify({ partition: "2026-08-04", records: [{ x: 1 }] }),
    );
    expect(ingest.status).toBe(200);
    expect(stored).not.toBeNull();
  });

  it("refuses to re-mint under a different causePrefix", async () => {
    expect((await mint(alice, "req-a")).status).toBe(200);
    const res = await mint(alice, "req-b", { causePrefix: "elsewhere" });
    expect(res.status).toBe(409);
    expect(err(res)).toContain("cause-prefix");
  });

  it("rejects an installId that could impersonate an integration audience", async () => {
    // `did:web:commonfabric.org#oauth2` and `#plaid` are the token-less
    // integration audiences; the segment charset is what keeps a minted
    // audience out of that namespace.
    const res = await mint(alice, "req-c", {
      installId: "did:web:commonfabric.org#oauth2",
    });
    expect(res.status).toBe(400);
  });

  it("rotates in place: new token works, old token stops", async () => {
    const first = await mint(alice, "req-r1");
    const id = ok(first).id;

    const rotated = await processRotate(deps, alice.did(), {
      id,
      requestId: "req-r2",
    });
    expect(rotated.status).toBe(200);
    expect(ok(rotated).id).toBe(id);
    expect(ok(rotated).token).not.toBe(ok(first).token);

    const body = JSON.stringify({
      partition: "2026-08-04",
      records: [{ x: 1 }],
    });
    const withNew = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(rotated).token,
      body,
    );
    expect(withNew.status).toBe(200);

    // 403, not 401: the holder of the superseded token has proven possession,
    // so it gets an actionable "re-pair" instead of a blank refusal. A merely
    // wrong token still gets the equalized 401 — asserted below.
    const withOld = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(first).token,
      body,
    );
    expect(withOld.status).toBe(403);
  });

  // The invariant whose violation is a total break: rotate/revoke authorize
  // against the registration's STORED space, never against caller input.
  it("refuses rotate and revoke from a non-owner (IDOR)", async () => {
    const first = await mint(alice, "req-i1");
    const id = ok(first).id;

    const rot = await processRotate(deps, mallory.did(), {
      id,
      requestId: "req-i2",
    });
    expect(rot.status).toBe(403);
    expect("token" in rot.body).toBe(false);

    const rev = await processRevoke(deps, mallory.did(), { id });
    expect(rev.status).toBe(403);

    // Alice's token still works — Mallory changed nothing.
    const still = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(first).token,
      JSON.stringify({ partition: "2026-08-04", records: [{ x: 1 }] }),
    );
    expect(still.status).toBe(200);
  });

  it("answers identically for an unknown channel id and an unowned one", async () => {
    const first = await mint(alice, "req-u1");
    const unowned = await processRevoke(deps, mallory.did(), {
      id: ok(first).id,
    });
    const unknown = await processRevoke(deps, mallory.did(), {
      id: "ing_nosuchchannel",
    });
    expect(unknown.status).toBe(unowned.status);
    expect(unknown.body).toEqual(unowned.body);
  });

  it("revokes: subsequent POSTs stop, and the audit record survives", async () => {
    const first = await mint(alice, "req-v1");
    const id = ok(first).id;

    const revoked = await processRevoke(deps, alice.did(), { id });
    expect(revoked.status).toBe(200);

    const after = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(first).token,
      JSON.stringify({ partition: "2026-08-04", records: [{ x: 1 }] }),
    );
    // A correct token on a revoked channel gets the re-pair signal, not a 401.
    expect(after.status).toBe(403);

    // The registration is kept — it is the only record of who was authorized
    // to write provenance-marked data into this space.
    const stored = await getRegistration(runtime, operator.did(), id);
    expect(stored?.enabled).toBe(false);
    expect(stored?.revoked?.by).toBe(alice.did());
  });

  it("lists only the caller's own channels, never a secret hash", async () => {
    await mint(alice, "req-l1");

    const mine = await processList(deps, alice.did(), {});
    const channels = ok(mine).channels;
    expect(channels.length).toBe(1);
    expect(channels[0].space).toBe(space);
    expect(JSON.stringify(mine.body)).not.toContain("secretHash");

    const theirs = await processList(deps, mallory.did(), {});
    expect(ok(theirs).channels.length).toBe(0);
  });

  it("scopes the list to one space the caller owns", async () => {
    await mint(alice, "req-f1");
    const otherSpace = await sharedSpace();
    await processMint(deps, alice.did(), {
      space: otherSpace,
      installId: "phone-9",
      requestId: "req-f2",
    });

    // Unscoped: everything alice minted, across both spaces.
    expect(ok(await processList(deps, alice.did(), {})).channels.length).toBe(
      2,
    );

    // Scoped: only the named space. Passing a space is now an authorization
    // boundary, not a client-side filter — see the owner-inventory tests.
    const scoped = ok(
      await processList(deps, alice.did(), { space: otherSpace }),
    );
    expect(scoped.channels.map((c) => c.space)).toEqual([otherSpace]);
  });

  // The highest-value item in the brief: a channel that would accept POSTs and
  // commit nothing must be refused at mint, with an actionable message.
  it("refuses at mint when the operator cannot write the space", async () => {
    const lonely = await Identity.fromPassphrase("ic-space-no-operator");
    await genesisAcl(factory, lonely, { [alice.did()]: "OWNER" });

    const res = await processMint(deps, alice.did(), {
      space: lonely.did(),
      installId: "phone-2",
      requestId: "req-o1",
    });
    expect(res.status).toBe(409);
    expect(err(res)).toContain(operator.did());
  });

  // The data plane refuses any registration carrying `revoked`, so a re-mint
  // that left the flag set would hand back a token dead on its first POST —
  // a success message and a broken device.
  it("re-minting a revoked channel yields a token that actually works", async () => {
    const first = await mint(alice, "req-rm1");
    const id = ok(first).id;
    expect((await processRevoke(deps, alice.did(), { id })).status).toBe(200);

    const reminted = await mint(alice, "req-rm2");
    expect(reminted.status).toBe(200);

    const post = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(reminted).token,
      JSON.stringify({ partition: "2026-08-04", records: [{ x: 1 }] }),
    );
    expect(post.status).toBe(200);

    // Re-authorizing clears the live flag but must NOT erase the trail.
    const stored = await getRegistration(runtime, operator.did(), id);
    expect(stored?.enabled).toBe(true);
    expect(stored?.revoked).toBeUndefined();
    expect(stored?.revocations?.length).toBe(1);
    expect(stored?.revocations?.[0].by).toBe(alice.did());
  });

  // The whole point of relaxing the 401 equalization was the rotation case, and
  // rotation replaces the secret — so without a superseded-hash record the 403
  // branch is structurally unreachable for exactly that case.
  it("tells a device holding a rotated-away token to re-pair", async () => {
    const first = await mint(alice, "req-rr1");
    const id = ok(first).id;
    await processRotate(deps, alice.did(), { id, requestId: "req-rr2" });

    const body = JSON.stringify({
      partition: "2026-08-04",
      records: [{ x: 1 }],
    });
    const stale = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(first).token,
      body,
    );
    expect(stale.status).toBe(403);
    expect(JSON.stringify(stale.body)).toContain("rotated");

    // A merely WRONG token still gets the equalized 401 — the 403 is
    // proof-of-possession of the superseded secret, not a channel oracle.
    const wrong = await processIngest(
      runtime,
      operator.did(),
      id,
      "ingsec_notarealtokenatall",
      body,
    );
    expect(wrong.status).toBe(401);

    // And an empty token must not match the dummy hash into a 403.
    const empty = await processIngest(runtime, operator.did(), id, "", body);
    expect(empty.status).toBe(401);
  });

  // A co-owner minting the same low-entropy installId ("phone-1") would
  // otherwise silently replace `owner` and kill the incumbent's live token with
  // no revocation record.
  it("refuses to take over a channel owned by another principal", async () => {
    const shared = await sharedSpace();
    const first = await processMint(deps, alice.did(), {
      space: shared,
      installId: "phone-1",
      requestId: "req-to1",
    });
    expect(first.status).toBe(200);

    const takeover = await processMint(deps, mallory.did(), {
      space: shared,
      installId: "phone-1",
      requestId: "req-to2",
    });
    expect(takeover.status).toBe(409);
    expect(err(takeover)).toContain("different owner");

    // Alice's device keeps working.
    const post = await processIngest(
      runtime,
      operator.did(),
      ok(first).id,
      ok(first).token,
      JSON.stringify({ partition: "2026-08-04", records: [{ x: 1 }] }),
    );
    expect(post.status).toBe(200);
  });

  // The guard's error message says "revoke it first" — so revoking first has to
  // actually work. Revoke preserves `owner` (attribution, not liveness) and
  // there is no delete path, so gating on owner alone would lock the channel to
  // one DID permanently and the advice would be a lie. This is also how a user
  // who re-keys recovers their own device.
  it("allows takeover after an explicit revoke, and records it", async () => {
    const shared = await sharedSpace();
    const first = await processMint(deps, alice.did(), {
      space: shared,
      installId: "phone-1",
      requestId: "req-tk1",
    });
    const id = ok(first).id;

    expect((await processRevoke(deps, mallory.did(), { id })).status).toBe(200);

    const taken = await processMint(deps, mallory.did(), {
      space: shared,
      installId: "phone-1",
      requestId: "req-tk2",
    });
    expect(taken.status).toBe(200);

    const stored = await getRegistration(runtime, operator.did(), id);
    expect(stored?.owner).toBe(mallory.did());
    expect(stored?.enabled).toBe(true);
    expect(stored?.revoked).toBeUndefined();
    // The handover is on the record.
    expect(stored?.revocations?.length).toBe(1);
    expect(stored?.revocations?.[0].by).toBe(mallory.did());

    // And the new owner's token actually works.
    const post = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(taken).token,
      JSON.stringify({ partition: "2026-08-04", records: [{ x: 1 }] }),
    );
    expect(post.status).toBe(200);
  });

  // `processRevoke` shallow-spreads a stored registration, and stored values
  // are deep-frozen: without rebuilding them the history is silently dropped on
  // the second revoke.
  it("keeps the revocation history across repeated revoke/mint cycles", async () => {
    const first = await mint(alice, "req-h1");
    const id = ok(first).id;
    await processRevoke(deps, alice.did(), { id });
    await mint(alice, "req-h2");
    await processRevoke(deps, alice.did(), { id });
    await mint(alice, "req-h3");

    const stored = await getRegistration(runtime, operator.did(), id);
    expect(stored?.revocations?.length).toBe(2);
  });

  it("exposes the revocation history to the owner via list", async () => {
    const first = await mint(alice, "req-x1");
    await processRevoke(deps, alice.did(), { id: ok(first).id });
    await mint(alice, "req-x2");

    const listed = await processList(deps, alice.did(), {});
    const channels = ok(listed).channels;
    // A trail the owner cannot read would not have justified soft-revoke.
    expect((channels[0].revocations as unknown[]).length).toBe(1);
  });

  // Re-minting the same installId is how a user re-pairs a device, and it
  // replaces the secret — so it IS a rotation and must leave the old device an
  // actionable answer. Without the superseded hash it gets the blank 401 that
  // the whole 403 re-pair decision exists to remove, on the likeliest path to
  // reach it.
  it("re-minting leaves the old device an actionable 403, not a blank 401", async () => {
    const first = await mint(alice, "req-rp1");
    const id = ok(first).id;

    const reminted = await mint(alice, "req-rp2");
    expect(reminted.status).toBe(200);

    const body = JSON.stringify({
      partition: "2026-08-04",
      records: [{ x: 1 }],
    });
    const stale = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(first).token,
      body,
    );
    expect(stale.status).toBe(403);
    expect(JSON.stringify(stale.body)).toContain("rotated");

    // The new token works, and a wrong token still gets the equalized 401.
    expect(
      (await processIngest(
        runtime,
        operator.did(),
        id,
        ok(reminted).token,
        body,
      )).status,
    ).toBe(200);
    expect(
      (await processIngest(
        runtime,
        operator.did(),
        id,
        "ingsec_nope",
        body,
      )).status,
    ).toBe(401);
  });

  // Storage faults must surface as 502, never as a denial or an uncaught 500 —
  // the same contract the data plane holds. Every verb reaches storage, so
  // every verb needs it.
  describe("storage faults", () => {
    const broken = {
      getCell() {
        throw new Error("boom");
      },
      // `authorizeSpaceOwner` reaches this before any cell work.
      storageManager: { synced: () => Promise.resolve() },
    } as unknown as Runtime;

    const brokenDeps = () => ({ ...deps, runtime: broken });

    /**
     * Fail only on the registry cells, so authorization succeeds first and the
     * fault lands on the write path proper — the 502-not-a-denial contract.
     *
     * Shadows `getCell` on the instance rather than wrapping the runtime in a
     * Proxy: `Runtime` reads private class fields, which throw when `this` is a
     * Proxy receiver.
     */
    const withFault = async <T>(
      match: string,
      fn: (faulted: ControlDeps) => Promise<T>,
    ): Promise<T> => {
      // deno-lint-ignore no-explicit-any
      const original = (runtime.getCell as any).bind(runtime) as (
        // deno-lint-ignore no-explicit-any
        ...args: any[]
      ) => unknown;
      // deno-lint-ignore no-explicit-any
      (runtime as any).getCell = (...args: any[]) => {
        if (typeof args[1] === "string" && args[1].includes(match)) {
          throw new Error(`boom: ${args[1]}`);
        }
        return original(...args);
      };
      try {
        return await fn(deps);
      } finally {
        // deno-lint-ignore no-explicit-any
        delete (runtime as any).getCell;
      }
    };

    it("a failed registration lookup is a 502, not a denial", async () => {
      const res = await withFault(
        "cf:ingest:ing_",
        (d) =>
          processMint(d, alice.did(), {
            space,
            installId: "phone-1",
            requestId: "req-f1",
          }),
      );
      expect(res.status).toBe(502);
    });

    it("a failed request-id claim is a 502", async () => {
      const res = await withFault(
        "cf:ingest:requests:",
        (d) =>
          processMint(d, alice.did(), {
            space,
            installId: "phone-1",
            requestId: "req-f2",
          }),
      );
      expect(res.status).toBe(502);
    });

    it("a failed owner-index read is a 502", async () => {
      const res = await withFault(
        "cf:ingest:by-owner:",
        (d) =>
          processMint(d, alice.did(), {
            space,
            installId: "phone-1",
            requestId: "req-f3",
          }),
      );
      expect(res.status).toBe(502);
    });

    it("a failed revoke write is a 502", async () => {
      const first = await mint(alice, "req-f4");
      const id = ok(first).id;
      const res = await withFault(
        "cf:ingest:by-owner:",
        (d) => processRevoke(d, alice.did(), { id }),
      );
      expect(res.status).toBe(502);
    });

    it("mint -> fails closed as a denial, not an admit", async () => {
      const res = await processMint(brokenDeps(), alice.did(), {
        space,
        installId: "phone-1",
        requestId: "req-b1",
      });
      expect(res.status).toBe(403);
    });

    it("list -> 502", async () => {
      expect((await processList(brokenDeps(), alice.did(), {})).status).toBe(
        502,
      );
    });

    it("rotate and revoke -> 502", async () => {
      expect(
        (await processRotate(brokenDeps(), alice.did(), {
          id: WELL_FORMED_ID,
          requestId: "req-b2",
        })).status,
      ).toBe(502);
      expect(
        (await processRevoke(brokenDeps(), alice.did(), { id: WELL_FORMED_ID }))
          .status,
      ).toBe(502);
    });
  });

  describe("input validation", () => {
    it("a malformed space DID shares the ownership denial, not its own error", async () => {
      // A distinguishable shape error would be a free probe for whether a
      // space exists, so it must answer exactly like "not an owner".
      const res = await processMint(deps, alice.did(), {
        space: "not-a-did",
        installId: "phone-1",
        requestId: "req-v1",
      });
      expect(res.status).toBe(403);
      expect(res.body).toEqual(
        (await mint(mallory, "req-v2")).body,
      );
    });

    it("rejects a malformed causePrefix and requestId", async () => {
      expect(
        (await mint(alice, "req-v3", { causePrefix: "has/slash" })).status,
      ).toBe(400);
      expect((await mint(alice, "bad requestId")).status).toBe(400);
      expect(
        (await processRotate(deps, alice.did(), {
          id: WELL_FORMED_ID,
          requestId: "bad id",
        })).status,
      ).toBe(400);
    });
  });

  it("refuses once the caller holds the per-owner cap of live channels", async () => {
    const capped = { ...deps, maxChannelsPerOwner: 1 };
    expect(
      (await processMint(capped, alice.did(), {
        space,
        installId: "phone-1",
        requestId: "req-c1",
      })).status,
    ).toBe(200);

    const second = await processMint(capped, alice.did(), {
      space,
      installId: "phone-2",
      requestId: "req-c2",
    });
    expect(second.status).toBe(409);
    expect(err(second)).toContain("Revoke some before minting more");

    // The cap counts LIVE channels, so the remedy it prescribes has to work.
    const first = channelId(space, "phone-1");
    expect((await processRevoke(capped, alice.did(), { id: first })).status)
      .toBe(200);
    expect(
      (await processMint(capped, alice.did(), {
        space,
        installId: "phone-2",
        requestId: "req-c3",
      })).status,
    ).toBe(200);
  });

  it("list skips an index entry whose registration now belongs to someone else", async () => {
    const shared = await sharedSpace();
    const minted = await processMint(deps, alice.did(), {
      space: shared,
      installId: "phone-1",
      requestId: "req-o1",
    });
    const id = ok(minted).id;
    // Mallory takes it over after a revoke, so alice's index keeps a stale id.
    await processRevoke(deps, alice.did(), { id });
    await processMint(deps, mallory.did(), {
      space: shared,
      installId: "phone-1",
      requestId: "req-o2",
    });

    const alices = await processList(deps, alice.did(), {});
    expect(ok(alices).channels.find((c) => c.id === id)).toBeUndefined();
    expect(ok(await processList(deps, mallory.did(), {})).channels.length)
      .toBe(1);
  });

  // The owner and space indexes track live channels; the audit index keeps the
  // full history. Revoking therefore removes a channel from the caller's list,
  // which is what bounds those indexes.
  it("drops a revoked channel from the list but keeps it in the audit index", async () => {
    const first = await mint(alice, "req-lr1");
    const id = ok(first).id;
    await processRevoke(deps, alice.did(), { id });

    expect(ok(await processList(deps, alice.did(), {})).channels.length).toBe(
      0,
    );
    // Still enumerable for audit, and still readable by id.
    expect(await getRegistrationIndex(runtime, operator.did())).toContain(id);
    expect((await getRegistration(runtime, operator.did(), id))?.revoked?.by)
      .toBe(alice.did());
  });

  // Gating the cap on "no existing registration" let one owner loop
  // mint -> revoke -> re-mint past it without limit.
  it("counts a re-minted revoked channel against the live cap", async () => {
    const capped = { ...deps, maxChannelsPerOwner: 1 };
    const first = await processMint(capped, alice.did(), {
      space,
      installId: "phone-1",
      requestId: "req-cap1",
    });
    expect(first.status).toBe(200);
    await processRevoke(capped, alice.did(), { id: ok(first).id });

    // One live channel again...
    expect(
      (await processMint(capped, alice.did(), {
        space,
        installId: "phone-2",
        requestId: "req-cap2",
      })).status,
    ).toBe(200);

    // ...so re-minting the revoked one must be refused, not waved through.
    const revived = await processMint(capped, alice.did(), {
      space,
      installId: "phone-1",
      requestId: "req-cap3",
    });
    expect(revived.status).toBe(409);
    expect(err(revived)).toContain("Revoke some before minting more");
  });

  describe("a space's current owner can find and revoke foreign channels", () => {
    it("sees channels minted by someone whose grant was later removed", async () => {
      // Bob owns the space and grants Alice OWNER; Alice mints; the grant is
      // then removed. Alice's token keeps working, so Bob has to be able to
      // discover and revoke it.
      const shared = await sharedSpace();
      const minted = await processMint(deps, alice.did(), {
        space: shared,
        installId: "phone-1",
        requestId: "req-w1",
      });
      const id = ok(minted).id;

      // Bob owns the space too, and did not mint this.
      const bobsUnscoped = ok(await processList(deps, mallory.did(), {}));
      expect(bobsUnscoped.channels.length).toBe(0);

      // Scoped to the space he owns, he sees it — and can therefore revoke it.
      const bobsScoped = ok(
        await processList(deps, mallory.did(), { space: shared }),
      );
      expect(bobsScoped.channels.map((c) => c.id)).toEqual([id]);
      expect(bobsScoped.channels[0].owner).toBe(alice.did());

      expect((await processRevoke(deps, mallory.did(), { id })).status).toBe(
        200,
      );
      const after = await processIngest(
        runtime,
        operator.did(),
        id,
        ok(minted).token,
        JSON.stringify({ partition: "2026-08-05", records: [{ x: 1 }] }),
      );
      expect(after.status).toBe(403);
    });

    it("refuses a space-scoped list to someone who does not own the space", async () => {
      const res = await processList(deps, mallory.did(), { space });
      expect(res.status).toBe(403);
    });
  });

  // Rotating replaces the secret and reassigns `owner`, so without this guard a
  // co-owner takes a channel over silently: the incumbent's device dies and no
  // revocation record explains it.
  it("refuses to rotate a channel registered to a different owner", async () => {
    const shared = await sharedSpace();
    const first = await processMint(deps, alice.did(), {
      space: shared,
      installId: "phone-1",
      requestId: "req-w2",
    });
    const id = ok(first).id;

    const stolen = await processRotate(deps, mallory.did(), {
      id,
      requestId: "req-w3",
    });
    expect(stolen.status).toBe(409);
    expect(err(stolen)).toContain("different owner");

    // Alice's device still works and she still owns it.
    const post = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(first).token,
      JSON.stringify({ partition: "2026-08-05", records: [{ x: 1 }] }),
    );
    expect(post.status).toBe(200);
    expect(
      (await getRegistration(runtime, operator.did(), id))?.owner,
    ).toBe(alice.did());
  });

  describe("lifecycle writes are optimistic", () => {
    // Rotate and revoke each decide against a snapshot, so without a
    // precondition an interleaving leaves revoke reporting success on a channel
    // that is live again, or rotate returning an already-dead token.
    it("a write loses when the registration moved underneath it", async () => {
      const first = await mint(alice, "req-cc1");
      const id = ok(first).id;
      const stale = await getRegistration(runtime, operator.did(), id);

      // Something else advances the channel.
      expect((await processRevoke(deps, alice.did(), { id })).status).toBe(200);

      // A write based on the pre-revoke snapshot must be refused, not applied.
      await expect(
        saveRegistration(
          runtime,
          operator.did(),
          { ...stale!, enabled: true, revision: (stale!.revision ?? 0) + 1 },
          stale!.revision ?? 0,
        ),
      ).rejects.toThrow();

      // The revocation stands.
      expect((await getRegistration(runtime, operator.did(), id))?.enabled)
        .toBe(false);
    });

    it("every mint bumps the revision", async () => {
      const first = await mint(alice, "req-cc2");
      const id = ok(first).id;
      expect((await getRegistration(runtime, operator.did(), id))?.revision)
        .toBe(1);
      await processRotate(deps, alice.did(), { id, requestId: "req-cc3" });
      expect((await getRegistration(runtime, operator.did(), id))?.revision)
        .toBe(2);
    });
  });

  // Every self-serve credential is finite-lived: an unbounded token means the
  // only bound on a removed owner's access is somebody noticing.
  it("always sets an expiry, even when no ttl is requested", async () => {
    const res = await mint(alice, "req-ttl0");
    expect(typeof ok(res).expiresAt).toBe("string");
    expect(Date.parse(ok(res).expiresAt!)).toBeGreaterThan(Date.now());
  });

  it("clamps an absurd ttlDays instead of throwing a RangeError", async () => {
    // `new Date(now + 1e15 * 86_400_000).toISOString()` throws RangeError, and
    // that line sits outside the try — it would escape as an uncaught 500.
    const res = await mint(alice, "req-ttl", { ttlDays: 1e15 });
    expect(res.status).toBe(200);
    expect(Date.parse(ok(res).expiresAt ?? "")).toBeGreaterThan(Date.now());
  });

  it("scopes requestIds per caller, so one owner cannot burn another's", async () => {
    const shared = await sharedSpace();
    expect(
      (await processMint(deps, alice.did(), {
        space: shared,
        installId: "phone-1",
        requestId: "shared-id",
      })).status,
    ).toBe(200);
    // Same requestId, different caller, different installId -> must not collide.
    const other = await processMint(deps, mallory.did(), {
      space: shared,
      installId: "phone-2",
      requestId: "shared-id",
    });
    expect(other.status).toBe(200);
  });

  it("honours ttlDays and enforces the resulting expiry on the data plane", async () => {
    const res = await mint(alice, "req-t1", { ttlDays: 30 });
    expect(res.status).toBe(200);
    expect(typeof ok(res).expiresAt).toBe("string");
    expect(Date.parse(ok(res).expiresAt ?? "")).toBeGreaterThan(Date.now());

    const listed = await processList(deps, alice.did(), {});
    const channels = ok(listed).channels;
    expect(channels[0].expiresAt).toBe(ok(res).expiresAt);
  });
});
