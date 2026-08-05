// Contract tests for the shared scope_key vocabulary (ledger LD3, owner
// 2026-08-03; docs/specs/server-side-execution/key-vocabulary.md §3).
// These bind the WIRE-VOCABULARY semantics: the one definition in the
// wire-shape module, its format, its throw conditions, its parse/inspect
// helpers, and the single-definition property (the engine re-exports the
// same objects — no second definition exists to drift).
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  canResolveScopeKey,
  isScopeKey,
  principalOfSessionKey,
  ProtocolError,
  resolvePrincipalSessionKey,
  resolveScopeKey,
  scopeOfScopeKey,
} from "../v2.ts";
import * as Engine from "../v2/engine.ts";

const identity = {
  principal: "did:key:z6MkAlice",
  sessionId: "session-1",
};

Deno.test("scope_key format: space, user:<principal>, session:<principal>:<sessionId>", () => {
  assertEquals(resolveScopeKey("space", {}), "space");
  assertEquals(resolveScopeKey(undefined, {}), "space");
  // Space needs no identity; supplying one changes nothing.
  assertEquals(resolveScopeKey("space", identity), "space");
  assertEquals(
    resolveScopeKey("user", identity),
    "user:did%3Akey%3Az6MkAlice",
  );
  assertEquals(
    resolveScopeKey("session", identity),
    "session:did%3Akey%3Az6MkAlice:session-1",
  );
});

Deno.test("scope_key segments are encodeURIComponent-encoded — ':' splits exactly, no '/' survives", () => {
  const tricky = resolveScopeKey("session", {
    principal: "did:web:example.com:alice",
    sessionId: "a/b:c",
  });
  // Splitting on ":" yields exactly three segments.
  assertEquals(tricky.split(":").length, 3);
  // No "/" survives encoding, so composite `a/b/c` keys stay 3-way
  // splittable.
  assert(!tricky.includes("/"));
  assertEquals(
    principalOfSessionKey(tricky),
    "did:web:example.com:alice",
  );
});

Deno.test("scope_key construction throws ProtocolError on missing identity components — never invents one", () => {
  assertThrows(
    () => resolveScopeKey("user", {}),
    ProtocolError,
    "user scoped memory operations require a principal",
  );
  assertThrows(
    () => resolveScopeKey("session", { sessionId: "s" }),
    ProtocolError,
    "session scoped memory operations require a principal",
  );
  assertThrows(
    () => resolveScopeKey("session", { principal: "did:key:x" }),
    ProtocolError,
    "session scoped memory operations require a session id",
  );
});

Deno.test("canResolveScopeKey is the predicate twin of the constructor's throws", () => {
  for (
    const [scope, id] of [
      ["space", {}],
      ["user", {}],
      ["user", identity],
      ["session", {}],
      ["session", { principal: identity.principal }],
      ["session", identity],
      [undefined, {}],
    ] as const
  ) {
    let threw = false;
    try {
      resolveScopeKey(scope, id);
    } catch {
      threw = true;
    }
    assertEquals(
      canResolveScopeKey(scope, id),
      !threw,
      `predicate disagrees with constructor for ${scope}`,
    );
  }
});

Deno.test("scopeOfScopeKey inverts the constructor's scope; isScopeKey validates", () => {
  for (const scope of ["space", "user", "session"] as const) {
    const key = resolveScopeKey(scope, identity);
    assertEquals(scopeOfScopeKey(key), scope);
    assert(isScopeKey(key));
  }
  // The scope NAMES themselves are not instance keys (except space, whose
  // one shared instance IS its name).
  assert(isScopeKey("space"));
  assert(!isScopeKey("user"));
  assert(!isScopeKey("session"));
  assert(!isScopeKey("user:"));
  assert(!isScopeKey("session:x"));
  assert(!isScopeKey("session:x:"));
  assert(!isScopeKey("something-else"));
});

Deno.test("principalOfSessionKey decodes the session key's principal; non-session keys yield undefined", () => {
  assertEquals(
    principalOfSessionKey(
      resolvePrincipalSessionKey("did:key:z6MkBob", "s-9"),
    ),
    "did:key:z6MkBob",
  );
  assertEquals(principalOfSessionKey("user:did%3Akey%3Ax"), undefined);
  assertEquals(principalOfSessionKey("space"), undefined);
  assertEquals(principalOfSessionKey("bare-session-id"), undefined);
});

Deno.test("single definition: the engine re-exports the SAME constructor and error class (LD3)", () => {
  // Not equal behavior — the same object. A second definition of the
  // format is the key-vocabulary.md §4 tripwire.
  assert(Engine.resolveScopeKey === resolveScopeKey);
  assert(Engine.ProtocolError === ProtocolError);
  assert(Engine.principalOfSessionKey === principalOfSessionKey);
});

Deno.test("commit session keys share the session-key constructor", () => {
  assertEquals(
    Engine.resolveCommitSessionKey("s-1", "did:key:z6MkCara"),
    resolvePrincipalSessionKey("did:key:z6MkCara", "s-1"),
  );
  // Principal-less commit session keys stay the bare session id.
  assertEquals(Engine.resolveCommitSessionKey("s-1"), "s-1");
});
