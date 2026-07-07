import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ACL } from "@commonfabric/memory/acl";
import { spaceReaderRole } from "../src/cfc/space-membership.ts";

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
