/**
 * Tests for the CFC Policy Exchange Rule Engine
 *
 * Tests mirror the Lean regressions in formal/Cfc/Proofs/Policy.lean:
 *   1. With integrity guards, authority-only confidentiality is dropped
 *   2. Without guards, policy evaluation is a no-op (safe default)
 *   3. Stale index handling for multiple drops
 *
 * Plus an end-to-end Gmail read case test.
 */

import { assertEquals } from "jsr:@std/assert";
import type { Atom, Label, Clause } from "../src/labels.ts";
import { labels } from "../src/labels.ts";
import {
  evalExchangeRules,
  pat,
  type ExchangeRule,
  type PolicyRecord,
  type AtomPattern,
} from "../src/policy.ts";

// ============================================================================
// Gmail example atoms (mirrors formal/Cfc/Proofs/GmailExample.lean)
// ============================================================================

function googleAuth(user: string): Atom {
  return { kind: "Policy", name: "GoogleAuth", subject: user, hash: "h" };
}

function user(did: string): Atom {
  return { kind: "PersonalSpace", did };
}

const authorizedRequest: Atom = { kind: "IntegrityToken", name: "AuthorizedRequest" };
const networkProvenance: Atom = { kind: "IntegrityToken", name: "NetworkProvenance" };

/** Token label: { conf: [[User(Alice)], [GoogleAuth(Alice)]], integ: [] } */
function tokenLabel(u: string): Label {
  return {
    confidentiality: [[user(u)], [googleAuth(u)]],
    integrity: [],
  };
}

// ============================================================================
// Gmail policy record (mirrors formal/Cfc/Proofs/Policy.lean)
// ============================================================================

/**
 * GoogleAuth authority-only drop rule:
 *   If integrity contains AuthorizedRequest and NetworkProvenance,
 *   drop the GoogleAuth(u) confidentiality clause.
 */
function googleAuthDropRule(u: string): ExchangeRule {
  return {
    name: "AuthorityOnlyDropGoogleAuth",
    preConf: [
      { kind: "Policy", name: pat.lit("GoogleAuth"), subject: pat.lit(u), hash: pat.lit("h") },
    ],
    preInteg: [
      { kind: "IntegrityToken", name: pat.lit("AuthorizedRequest") },
      { kind: "IntegrityToken", name: pat.lit("NetworkProvenance") },
    ],
    postConf: [],  // drop
    postInteg: [],
  };
}

function googleAuthPolicy(u: string): PolicyRecord {
  return {
    principal: googleAuth(u),
    exchangeRules: [googleAuthDropRule(u)],
  };
}

// ============================================================================
// Tests
// ============================================================================

Deno.test("policy: with guards, drops GoogleAuth confidentiality", () => {
  const alice = "Alice";
  const policies = [googleAuthPolicy(alice)];
  const boundary = [authorizedRequest, networkProvenance];

  const result = evalExchangeRules(policies, boundary, tokenLabel(alice));

  // GoogleAuth clause should be dropped, leaving only User(Alice)
  assertEquals(result.confidentiality.length, 1);
  assertEquals(result.confidentiality[0].length, 1);
  assertEquals(result.confidentiality[0][0], user(alice));
});

Deno.test("policy: without guards, no-op (safe default)", () => {
  const alice = "Alice";
  const policies = [googleAuthPolicy(alice)];
  const boundary: Atom[] = [];  // no integrity evidence

  const input = tokenLabel(alice);
  const result = evalExchangeRules(policies, boundary, input);

  // Label should be unchanged
  assertEquals(result.confidentiality.length, 2);
  assertEquals(result.integrity.length, 0);
});

Deno.test("policy: partial guards (only AuthorizedRequest) — no-op", () => {
  const alice = "Alice";
  const policies = [googleAuthPolicy(alice)];
  const boundary = [authorizedRequest];  // missing NetworkProvenance

  const input = tokenLabel(alice);
  const result = evalExchangeRules(policies, boundary, input);

  // Should not fire — both guards are required
  assertEquals(result.confidentiality.length, 2);
});

Deno.test("policy: stale index handling — multiple drops", () => {
  // Mirrors formal/Cfc/Proofs/Policy.lean Regression 3
  const P: Atom = { kind: "Policy", name: "P", subject: "subject", hash: "h" };

  const dropAnyCustom: ExchangeRule = {
    name: "DropAnyCustom",
    preConf: [{ kind: "Custom", tag: pat.var("X"), value: pat.var("V") }],
    preInteg: [],
    postConf: [],
    postInteg: [],
  };

  const policies: PolicyRecord[] = [{
    principal: P,
    exchangeRules: [dropAnyCustom],
  }];

  const input: Label = {
    confidentiality: [
      [P],
      [{ kind: "Custom", tag: "A", value: "" }],
      [{ kind: "Custom", tag: "B", value: "" }],
      [{ kind: "Custom", tag: "C", value: "" }],
    ],
    integrity: [],
  };

  const result = evalExchangeRules(policies, [], input);

  // All Custom clauses should be dropped, leaving only [P]
  assertEquals(result.confidentiality.length, 1);
  assertEquals(result.confidentiality[0][0], P);
});

Deno.test("policy: add alternatives (non-drop rule)", () => {
  // Exchange rule that adds User(acting) as alternative to Space clause
  const spaceAtom: Atom = { kind: "Space", id: "workspace-1" };
  const readerRole: Atom = { kind: "HasRole", principal: "Alice", space: "workspace-1", role: "reader" };

  const spaceReaderRule: ExchangeRule = {
    name: "SpaceReaderAccess",
    preConf: [
      { kind: "Space", id: pat.var("S") },
    ],
    preInteg: [
      { kind: "HasRole", principal: pat.var("U"), space: pat.var("S"), role: pat.lit("reader") },
    ],
    // Add User(U) as alternative in the Space clause
    postConf: [
      { kind: "PersonalSpace", did: pat.var("U") },
    ],
    postInteg: [],
  };

  const policies: PolicyRecord[] = [];  // No policy principal needed for this test
  // Actually, the rule needs to be triggered by a policy principal in scope.
  // Let's make Space a policy principal via a wrapper.
  const spacePolicyAtom: Atom = { kind: "Policy", name: "SpacePolicy", subject: "workspace-1", hash: "h" };

  const spacePolicies: PolicyRecord[] = [{
    principal: spacePolicyAtom,
    exchangeRules: [spaceReaderRule],
  }];

  const input: Label = {
    confidentiality: [[spacePolicyAtom], [spaceAtom]],
    integrity: [],
  };

  // Provide role as boundary integrity
  const result = evalExchangeRules(spacePolicies, [readerRole], input);

  // The Space clause should now also contain PersonalSpace(Alice)
  const spaceClause = result.confidentiality.find(c =>
    c.some(a => a.kind === "Space")
  );
  assertEquals(spaceClause !== undefined, true);
  assertEquals(spaceClause!.some(a =>
    a.kind === "PersonalSpace" && a.did === "Alice"
  ), true);
});

Deno.test("policy: variable binding across conf and integ patterns", () => {
  // Rule that uses the same variable in conf and integ patterns
  const alice = "Alice";
  const P: Atom = { kind: "Policy", name: "TestPolicy", subject: alice, hash: "h" };

  // Drop PersonalSpace(X) if EndorsedBy(X) is in integrity
  const endorsedDropRule: ExchangeRule = {
    name: "EndorsedDrop",
    preConf: [
      { kind: "Policy", name: pat.lit("TestPolicy"), subject: pat.var("U"), hash: pat.lit("h") },
    ],
    preInteg: [
      { kind: "EndorsedBy", principal: pat.var("U") },
    ],
    postConf: [],
    postInteg: [],
  };

  const policies: PolicyRecord[] = [{
    principal: P,
    exchangeRules: [endorsedDropRule],
  }];

  const input: Label = {
    confidentiality: [[P], [user(alice)]],
    integrity: [],
  };

  // Without matching endorsement — no-op
  const result1 = evalExchangeRules(policies, [{ kind: "EndorsedBy", principal: "Bob" }], input);
  assertEquals(result1.confidentiality.length, 2);

  // With matching endorsement — drops the Policy clause
  const result2 = evalExchangeRules(policies, [{ kind: "EndorsedBy", principal: alice }], input);
  assertEquals(result2.confidentiality.length, 1);
  // Only User(Alice) remains
  assertEquals(result2.confidentiality[0][0], user(alice));
});

Deno.test("policy: no policies in scope — no-op", () => {
  const input: Label = {
    confidentiality: [[{ kind: "Custom", tag: "secret", value: "" }]],
    integrity: [],
  };

  // No policy principals in the label, so no rules fire
  const result = evalExchangeRules(
    [googleAuthPolicy("Alice")],
    [authorizedRequest, networkProvenance],
    input,
  );

  assertEquals(result.confidentiality.length, 1);
});

// ============================================================================
// End-to-end Gmail Read Case
// ============================================================================

Deno.test("gmail read case: token confidentiality dropped after authorized fetch", () => {
  /**
   * Scenario from spec §1.2:
   *   1. Token has label { conf: [[User(Alice)], [GoogleAuth(Alice)]], integ: [] }
   *   2. curl fetches with Authorization header → mints AuthorizedRequest boundary integrity
   *   3. Successful HTTPS fetch → NetworkProvenance in response integrity
   *   4. Exchange rule fires: drops GoogleAuth(Alice) clause
   *   5. Response label: { conf: [[User(Alice)]], integ: [Origin, NetworkProvenance] }
   */
  const alice = "Alice";
  const policies = [googleAuthPolicy(alice)];

  // After fetch, the raw response label combines:
  //   - confidentiality from the PC (token's confidentiality flows through)
  //   - integrity from network fetch
  const rawResponseLabel: Label = {
    confidentiality: tokenLabel(alice).confidentiality,
    integrity: [
      { kind: "Origin", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages" },
      { kind: "NetworkProvenance", tls: true, host: "gmail.googleapis.com" },
    ],
  };

  // Boundary integrity minted by curl (structural proof: secret in Authorization header only)
  const boundaryIntegrity = [
    { kind: "Origin", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages" } as Atom,
    { kind: "NetworkProvenance", tls: true, host: "gmail.googleapis.com" } as Atom,
    { kind: "IntegrityToken", name: "AuthorizedRequest" } as Atom,
    { kind: "IntegrityToken", name: "NetworkProvenance" } as Atom,
  ];

  const result = evalExchangeRules(policies, boundaryIntegrity, rawResponseLabel);

  // GoogleAuth(Alice) clause should be dropped
  assertEquals(result.confidentiality.length, 1, "Should have 1 confidentiality clause");
  assertEquals(result.confidentiality[0].length, 1, "Clause should have 1 atom");
  assertEquals(result.confidentiality[0][0], user(alice), "Should be User(Alice)");

  // Integrity preserved
  assertEquals(result.integrity.length, 2, "Should have 2 integrity atoms");
  assertEquals(result.integrity[0].kind, "Origin");
  assertEquals(result.integrity[1].kind, "NetworkProvenance");
});

Deno.test("gmail read case: query secret taints response (data-bearing)", () => {
  /**
   * Scenario from spec §1.3:
   *   Token has GoogleAuth(Alice) + User(Alice) confidentiality
   *   Query comes from Notes with NotesSecret(Alice) confidentiality
   *   Response should have: User(Alice) + NotesSecret(Alice)
   *   GoogleAuth dropped (authority-only), but NotesSecret preserved (data-bearing)
   */
  const alice = "Alice";
  const policies = [googleAuthPolicy(alice)];

  const notesSecret: Atom = { kind: "Custom", tag: "NotesSecret", value: alice };

  // The PC label is the join of token + query labels
  // Token: [[User(Alice)], [GoogleAuth(Alice)]]
  // Query: [[NotesSecret(Alice)]]
  // Join: [[User(Alice)], [GoogleAuth(Alice)], [NotesSecret(Alice)]]
  const rawResponseLabel: Label = {
    confidentiality: [
      [user(alice)],
      [googleAuth(alice)],
      [notesSecret],
    ],
    integrity: [
      { kind: "Origin", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages" },
      { kind: "NetworkProvenance", tls: true, host: "gmail.googleapis.com" },
    ],
  };

  const boundaryIntegrity = [
    { kind: "Origin", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages" } as Atom,
    { kind: "NetworkProvenance", tls: true, host: "gmail.googleapis.com" } as Atom,
    { kind: "IntegrityToken", name: "AuthorizedRequest" } as Atom,
    { kind: "IntegrityToken", name: "NetworkProvenance" } as Atom,
  ];

  const result = evalExchangeRules(policies, boundaryIntegrity, rawResponseLabel);

  // GoogleAuth dropped, but User(Alice) and NotesSecret(Alice) preserved
  assertEquals(result.confidentiality.length, 2, "Should have 2 confidentiality clauses");

  const hasUser = result.confidentiality.some(c =>
    c.length === 1 && c[0].kind === "PersonalSpace" && c[0].did === alice
  );
  assertEquals(hasUser, true, "Should have User(Alice)");

  const hasNotes = result.confidentiality.some(c =>
    c.length === 1 && c[0].kind === "Custom" && c[0].tag === "NotesSecret"
  );
  assertEquals(hasNotes, true, "Should have NotesSecret(Alice)");

  // GoogleAuth should be gone
  const hasGoogleAuth = result.confidentiality.some(c =>
    c.some(a => a.kind === "Policy" && a.name === "GoogleAuth")
  );
  assertEquals(hasGoogleAuth, false, "GoogleAuth should be dropped");
});
