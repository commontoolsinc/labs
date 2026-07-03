import { assert, assertFalse } from "@std/assert";
import {
  ANYONE_USER,
  isACL,
  isACLUser,
  isCapability,
  isCapable,
} from "../acl.ts";

Deno.test("memory ACL helpers validate users and capability names", () => {
  assert(isACLUser(ANYONE_USER));
  assert(isACLUser("did:key:alice"));
  assertFalse(isACLUser("did:key:alice:extra"));
  assertFalse(isACLUser("alice"));

  assert(isCapability("READ"));
  assert(isCapability("WRITE"));
  assert(isCapability("OWNER"));
  assertFalse(isCapability("ADMIN"));
});

Deno.test("memory ACL helpers validate ACL objects", () => {
  assert(isACL({
    [ANYONE_USER]: "READ",
    "did:key:alice": "OWNER",
  }));
  assertFalse(isACL(null));
  assertFalse(isACL({ "did:key:alice": "ADMIN" }));
  assertFalse(isACL({ alice: "READ" }));
});

Deno.test("memory ACL helpers compare capabilities by access level", () => {
  assert(isCapable("OWNER", "READ"));
  assert(isCapable("OWNER", "WRITE"));
  assert(isCapable("OWNER", "OWNER"));
  assert(isCapable("WRITE", "READ"));
  assertFalse(isCapable("READ", "WRITE"));
  assertFalse(isCapable("WRITE", "OWNER"));
});
