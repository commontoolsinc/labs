import { assert, assertMatch } from "@std/assert";
import { alice, bob, space } from "./principal.ts";
import * as Access from "../access.ts";
import { refer } from "../reference.ts";
import { type ACL, type Invocation } from "../interface.ts";
import { ANYONE_USER, checkACL } from "../acl.ts";

// Some generated service key.
const serviceDid = "did:key:z6MkfJPMCrTyDmurrAHPUsEjCgvcjvLtAuzyZ7nSqwZwb8KQ";

Deno.test("checkACL - READ capability allows query commands", () => {
  const acl: ACL = {
    [bob.did()]: "READ",
  };

  assert(checkACL(acl, bob.did(), "/memory/query"));
  assert(checkACL(acl, bob.did(), "/memory/query/schema"));
  assert(checkACL(acl, bob.did(), "/memory/graph/query"));
  assert(!checkACL(acl, bob.did(), "/memory/transact"));
  assert(!checkACL(acl, bob.did(), "/other/command"));
});

Deno.test("checkACL - WRITE capability allows query and transact", () => {
  const acl: ACL = {
    [bob.did()]: "WRITE",
  };

  assert(checkACL(acl, bob.did(), "/memory/query"));
  assert(checkACL(acl, bob.did(), "/memory/transact"));
  assert(!checkACL(acl, bob.did(), "/other/command"));
});

Deno.test("checkACL - OWNER capability allows all commands", () => {
  const acl: ACL = {
    [bob.did()]: "OWNER",
  };

  assert(checkACL(acl, bob.did(), "/memory/query"));
  assert(checkACL(acl, bob.did(), "/memory/transact"));
  assert(checkACL(acl, bob.did(), "/other/command"));
});

Deno.test("checkACL - returns false for DID not in ACL", () => {
  const acl: ACL = {
    [alice.did()]: "WRITE",
  };

  assert(!checkACL(acl, bob.did(), "/memory/query"));
  assert(!checkACL(acl, bob.did(), "/memory/transact"));
});

Deno.test("checkACL - '*' allows public access", () => {
  const acl: ACL = {
    [ANYONE_USER]: "READ",
  };

  assert(checkACL(acl, bob.did(), "/memory/query"));
  assert(!checkACL(acl, bob.did(), "/memory/transact"));
});

Deno.test("Access.claim - allows space owner without ACL", async () => {
  const invocation: Invocation = {
    iss: alice.did(),
    cmd: "/memory/transact",
    sub: alice.did(),
    args: {},
    prf: [],
  };

  const result = await Access.authorize([refer(invocation)], alice);
  assert(result.ok, "authorization was issued");
  const authorization = result.ok;

  const claim = await Access.claim(invocation, authorization, serviceDid);
  assert(claim.ok, "space owner should be authorized");
});

Deno.test("Access.claim - allows service DID by matching issuer", async () => {
  // For this test, we'll use space identity as if it were the service
  // The key point is testing that when iss matches serviceDid, it's authorized
  const invocation: Invocation = {
    iss: space.did(),
    cmd: "/memory/transact",
    sub: alice.did(),
    args: {},
    prf: [],
  };

  const result = await Access.authorize([refer(invocation)], space);
  assert(result.ok, "authorization was issued");
  const authorization = result.ok;

  // Pass space.did() as the serviceDid to test service authorization
  const claim = await Access.claim(invocation, authorization, space.did());
  assert(claim.ok, "service DID should be authorized");
});

Deno.test("Access.claim - denies non-owner without ACL", async () => {
  const invocation: Invocation = {
    iss: bob.did(),
    cmd: "/memory/transact",
    sub: alice.did(),
    args: {},
    prf: [],
  };

  const result = await Access.authorize([refer(invocation)], bob);
  assert(result.ok, "authorization was issued");
  const authorization = result.ok;

  const claim = await Access.claim(invocation, authorization, serviceDid);
  assertMatch(
    claim.error?.message ?? "",
    /has no authority over/,
    "non-owner should be denied without ACL",
  );
});

Deno.test("Access.claim - allows authorized user with ACL", async () => {
  const acl: ACL = {
    [bob.did()]: "WRITE",
  };

  const invocation: Invocation = {
    iss: bob.did(),
    cmd: "/memory/transact",
    sub: alice.did(),
    args: {},
    prf: [],
  };

  const result = await Access.authorize([refer(invocation)], bob);
  assert(result.ok, "authorization was issued");
  const authorization = result.ok;

  const claim = await Access.claim(
    invocation,
    authorization,
    serviceDid,
    acl,
  );
  assert(claim.ok, "authorized user should have access via ACL");
});

Deno.test("Access.claim - denies user without sufficient capability", async () => {
  const acl: ACL = {
    [bob.did()]: "READ",
  };

  const invocation: Invocation = {
    iss: bob.did(),
    cmd: "/memory/transact",
    sub: alice.did(),
    args: {},
    prf: [],
  };

  const result = await Access.authorize([refer(invocation)], bob);
  assert(result.ok, "authorization was issued");
  const authorization = result.ok;

  const claim = await Access.claim(
    invocation,
    authorization,
    serviceDid,
    acl,
  );
  assertMatch(
    claim.error?.message ?? "",
    /has no authority over/,
    "user with insufficient capability should be denied",
  );
});
