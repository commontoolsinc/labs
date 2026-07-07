import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ACL } from "@commonfabric/memory/acl";
import {
  createRuntimeSpaceMembershipProvider,
  spaceReaderRole,
} from "../src/cfc/space-membership.ts";
import type { Cancel } from "../src/cancel.ts";
import type { Runtime } from "../src/runtime.ts";

// §4.9.3 render membership lookup — the client-side capability resolver
// (design: docs/specs/cfc-render-membership-lookup.md §3.1). `spaceReaderRole`
// mirrors the server's `#resolveCapability` (packages/memory/v2/server.ts) so
// the render gate's authority decision cannot drift from the server's.

const ALICE = "did:key:alice";
const MALLORY = "did:key:mallory";
const SPACE_TEAM = "did:key:team-space";
const SERVICE = "did:web:commonfabric.org#runtime";

describe("spaceReaderRole (§4.9.3 capability resolver)", () => {
  it("grants implicit OWNER for a principal's own identity space", () => {
    // A principal definitionally owns its own space (space DID == principal
    // DID), independent of any ACL document or deployment ACL mode.
    expect(spaceReaderRole(undefined, ALICE, ALICE)).toBe("owner");
  });

  it("grants implicit OWNER to a configured service DID", () => {
    expect(spaceReaderRole(undefined, SPACE_TEAM, SERVICE, [SERVICE])).toBe(
      "owner",
    );
  });

  it("maps a READ grant to the reader role", () => {
    const acl: ACL = { [ALICE]: "READ" };
    expect(spaceReaderRole(acl, SPACE_TEAM, ALICE)).toBe("reader");
  });

  it("maps a WRITE grant to the writer role (WRITE implies READ)", () => {
    const acl: ACL = { [ALICE]: "WRITE" };
    expect(spaceReaderRole(acl, SPACE_TEAM, ALICE)).toBe("writer");
  });

  it("maps an OWNER grant to the owner role", () => {
    const acl: ACL = { [ALICE]: "OWNER" };
    expect(spaceReaderRole(acl, SPACE_TEAM, ALICE)).toBe("owner");
  });

  it("falls back to the ANYONE ('*') grant when the principal is unlisted", () => {
    const acl: ACL = { "*": "READ" };
    expect(spaceReaderRole(acl, SPACE_TEAM, ALICE)).toBe("reader");
  });

  it("prefers an explicit principal entry over the ANYONE grant", () => {
    // `acl[principal] ?? acl["*"]` — the explicit entry wins even when it is
    // narrower than the public grant.
    const acl: ACL = { [ALICE]: "READ", "*": "OWNER" };
    expect(spaceReaderRole(acl, SPACE_TEAM, ALICE)).toBe("reader");
  });

  it("returns null for a principal absent from a `*`-less ACL (fail closed)", () => {
    const acl: ACL = { [MALLORY]: "OWNER" };
    expect(spaceReaderRole(acl, SPACE_TEAM, ALICE)).toBeNull();
  });

  it("returns null for a missing ACL document (fail closed)", () => {
    // The whole soundness point: an unread/absent ACL grants NOTHING, so the
    // Space label stays blocked. Residency is not read authority.
    expect(spaceReaderRole(undefined, SPACE_TEAM, ALICE)).toBeNull();
  });

  it("returns null for a malformed ACL value (fail closed)", () => {
    expect(spaceReaderRole("not-an-acl" as unknown as ACL, SPACE_TEAM, ALICE))
      .toBeNull();
    expect(
      spaceReaderRole({ [ALICE]: "SUDO" } as unknown as ACL, SPACE_TEAM, ALICE),
    ).toBeNull();
  });

  it("does not grant a service role to a non-service principal", () => {
    expect(spaceReaderRole(undefined, SPACE_TEAM, ALICE, [SERVICE])).toBeNull();
  });
});

// A minimal runtime double: one ACL doc per space id, plus per-space sink
// callbacks so a test can drive a reactive change. `get()` records calls so
// the sync-read + background-sync-kick contract is observable.
const fakeRuntime = (aclBySpace: Record<string, unknown>) => {
  const sinks = new Map<string, Set<() => void>>();
  const getCalls: string[] = [];
  const runtime = {
    getCellFromLink(link: { id: string; path: readonly []; space: string }) {
      return {
        get() {
          getCalls.push(link.id);
          return aclBySpace[link.id];
        },
        sink(cb: () => void): Cancel {
          let set = sinks.get(link.id);
          if (set === undefined) {
            set = new Set();
            sinks.set(link.id, set);
          }
          set.add(cb);
          return () => set!.delete(cb);
        },
      };
    },
  } as unknown as Runtime;
  const fire = (space: string) => {
    for (const cb of sinks.get(space) ?? []) cb();
  };
  return { runtime, getCalls, fire, sinks };
};

describe("createRuntimeSpaceMembershipProvider (§4.9.3 provider)", () => {
  it("reads a granted ACL synchronously and returns the reader role", () => {
    const { runtime, getCalls } = fakeRuntime({
      [SPACE_TEAM]: { [ALICE]: "READ" },
    });
    const provider = createRuntimeSpaceMembershipProvider(runtime, ALICE);
    expect(provider.readerRole(SPACE_TEAM)).toBe("reader");
    // The ACL doc for the queried space was read (a Cell.get() sync read that
    // also kicks a background sync when unsynced).
    expect(getCalls).toContain(SPACE_TEAM);
  });

  it("fails closed when the ACL doc is absent (residency is not authority)", () => {
    // The runtime may have synced the space's bytes without the acting user
    // being an authorized reader; an absent/unread ACL grants NOTHING.
    const { runtime } = fakeRuntime({});
    const provider = createRuntimeSpaceMembershipProvider(runtime, ALICE);
    expect(provider.readerRole(SPACE_TEAM)).toBeNull();
  });

  it("grants the acting user's own space without reading an ACL", () => {
    const { runtime, getCalls } = fakeRuntime({});
    const provider = createRuntimeSpaceMembershipProvider(runtime, ALICE);
    expect(provider.readerRole(ALICE)).toBe("owner");
    // Own-space is implicit OWNER — no ACL doc read needed.
    expect(getCalls).not.toContain(ALICE);
  });

  it("fails closed on a malformed ACL value", () => {
    const { runtime } = fakeRuntime({ [SPACE_TEAM]: "not-an-acl" });
    const provider = createRuntimeSpaceMembershipProvider(runtime, ALICE);
    expect(provider.readerRole(SPACE_TEAM)).toBeNull();
  });

  it("reflects the latest replica across reads (no stale memo on revoke)", () => {
    // Soundness under revoke: a later read must see the ACL as it now stands.
    const acl: Record<string, unknown> = { [SPACE_TEAM]: { [ALICE]: "READ" } };
    const { runtime } = fakeRuntime(acl);
    const provider = createRuntimeSpaceMembershipProvider(runtime, ALICE);
    expect(provider.readerRole(SPACE_TEAM)).toBe("reader");
    delete acl[SPACE_TEAM]; // ACL revoked / doc dropped
    expect(provider.readerRole(SPACE_TEAM)).toBeNull();
  });

  it("subscribe fires onChange when the ACL cell changes, and cancels cleanly", () => {
    const { runtime, fire, sinks } = fakeRuntime({
      [SPACE_TEAM]: { [ALICE]: "READ" },
    });
    const provider = createRuntimeSpaceMembershipProvider(runtime, ALICE);
    let changes = 0;
    const cancel = provider.subscribe(SPACE_TEAM, () => changes++);
    fire(SPACE_TEAM);
    expect(changes).toBe(1);
    cancel();
    fire(SPACE_TEAM);
    expect(changes).toBe(1); // no further callbacks after cancel
    expect(sinks.get(SPACE_TEAM)?.size ?? 0).toBe(0);
  });

  it("honors service DIDs for implicit OWNER", () => {
    const { runtime } = fakeRuntime({});
    const provider = createRuntimeSpaceMembershipProvider(runtime, SERVICE, [
      SERVICE,
    ]);
    expect(provider.readerRole(SPACE_TEAM)).toBe("owner");
  });
});
