import { assertEquals } from "@std/assert";
import {
  AUXILIARY_SCOPE_NAMING_LINK_CONFORMANCE,
  auxiliaryScopeNamingLinkForTarget,
  SCOPE_NAMING_LINK_CONFORMANCE,
  scopeNamingLinkForPath,
  scopeNamingLinkWriteViolation,
  SESSION_SCOPE_NAMING_LINK_CONFORMANCE,
} from "../v2/scope-naming-link.ts";
import type { FabricValue } from "@commonfabric/api";

// ---------------------------------------------------------------------------
// C2.2 (CA2): the scope-naming-link wire contract, lane-scope parameterized.
//
// The contract is a spec-level JSON shape (context-lattice §4, A7) shared by
// the runner emit tests (pattern-binding.test.ts captures the real emission)
// and the engine accept side. This file binds the MODULE contract both
// directions:
//
//  - emit direction: the canonical builder output for a session-narrowed
//    broad write is the exact session conformance JSON — naming ONLY the
//    scope, never a DID or session id;
//  - accept direction: the validator admits exactly the lane's own chain of
//    scope names ("user" for user lanes; "user"|"session" for session lanes
//    — context-lattice §2's `space < user < session`, review CA3) and
//    rejects everything else, including a link that smuggles a session id.
//
// The engine's firewall (`assertLaneBroadScopeNamingWrite`) bottoms out in
// `scopeNamingLinkWriteViolation`; the laneScope-threading it needs for C2
// is described (not made) by the C2.2 report — these fixtures are the shape
// that change must bind to.
// ---------------------------------------------------------------------------

const violationCode = (
  value: unknown,
  laneScope?: "user" | "session",
): string | undefined =>
  scopeNamingLinkWriteViolation({
    value: value as FabricValue,
    documentPath: ["value", "value"],
    writtenDocId: "of:output",
    ...(laneScope !== undefined ? { laneScope } : {}),
  })?.code;

Deno.test("session conformance fixture is the canonical builder output", () => {
  assertEquals(
    SESSION_SCOPE_NAMING_LINK_CONFORMANCE.link,
    scopeNamingLinkForPath(
      SESSION_SCOPE_NAMING_LINK_CONFORMANCE.cellPath,
      "session",
    ),
  );
  // The exact spec-level JSON wire shape, pinned by value: the
  // addressing-fields envelope naming ONLY the scope.
  assertEquals(
    JSON.parse(JSON.stringify(SESSION_SCOPE_NAMING_LINK_CONFORMANCE.link)),
    {
      "/": {
        "link@1": {
          path: ["value"],
          scope: "session",
          overwrite: "redirect",
        },
      },
    },
  );
});

Deno.test("the session link value never names a DID or session id (byte-identity across lanes)", () => {
  // §4: every lane writes the byte-identical link at the identical address;
  // the reading runtime context supplies principal and session id. The
  // builder output must therefore be a pure function of (path, scope).
  const payload = (JSON.parse(
    JSON.stringify(scopeNamingLinkForPath(["value"], "session")),
  ) as { "/": { "link@1": Record<string, unknown> } })["/"]["link@1"];
  assertEquals(Object.keys(payload).sort(), ["overwrite", "path", "scope"]);
  assertEquals(payload.scope, "session");
  // Two "different sessions" asking for the link get identical bytes.
  assertEquals(
    JSON.stringify(scopeNamingLinkForPath(["value"], "session")),
    JSON.stringify(scopeNamingLinkForPath(["value"], "session")),
  );
});

Deno.test("default lane scope stays user (engine behavior unchanged until C2 threads laneScope)", () => {
  // Backstop compatibility: with no laneScope the validator is
  // byte-identical to the pre-C2 user-only contract — the engine, which
  // does not pass laneScope yet, keeps rejecting session-named links.
  assertEquals(
    violationCode(SCOPE_NAMING_LINK_CONFORMANCE.link),
    undefined,
  );
  assertEquals(
    violationCode(SESSION_SCOPE_NAMING_LINK_CONFORMANCE.link),
    "malformed-scope-naming-link",
  );
});

Deno.test("a session lane admits its own chain of scope names (CA3)", () => {
  // session lane: both "session" (its own rank) and "user"
  // (broader-in-chain — byte-identical to what every user lane writes).
  assertEquals(
    violationCode(SESSION_SCOPE_NAMING_LINK_CONFORMANCE.link, "session"),
    undefined,
  );
  assertEquals(
    violationCode(SCOPE_NAMING_LINK_CONFORMANCE.link, "session"),
    undefined,
  );
});

Deno.test("a user lane rejects a session-named link (cross-lane)", () => {
  // "session" is narrower than the user lane's rank — never in its chain.
  assertEquals(
    violationCode(SESSION_SCOPE_NAMING_LINK_CONFORMANCE.link, "user"),
    "malformed-scope-naming-link",
  );
  assertEquals(
    violationCode(SCOPE_NAMING_LINK_CONFORMANCE.link, "user"),
    undefined,
  );
});

Deno.test("a link naming a session id is rejected in every lane (both directions)", () => {
  const base = (JSON.parse(
    JSON.stringify(SESSION_SCOPE_NAMING_LINK_CONFORMANCE.link),
  ) as { "/": { "link@1": Record<string, unknown> } })["/"]["link@1"];
  const smuggles: Array<Record<string, unknown>> = [
    // Resolved scope key in place of the scope name.
    { ...base, scope: "session:alice:s1" },
    // A dedicated session-id field.
    { ...base, sessionId: "s1" },
    // A principal in place of the scope name.
    { ...base, scope: "user:did:key:alice" },
    // The space scope is never a scope-naming target (a broad write IS the
    // space instance).
    { ...base, scope: "space" },
  ];
  for (const payload of smuggles) {
    const link = { "/": { "link@1": payload } };
    for (const laneScope of ["user", "session"] as const) {
      assertEquals(
        violationCode(link, laneScope),
        "malformed-scope-naming-link",
        `expected rejection for ${JSON.stringify(payload)} under ${laneScope}`,
      );
    }
  }
});

Deno.test("session links keep the full payload discipline of the user contract", () => {
  const base = (JSON.parse(
    JSON.stringify(SESSION_SCOPE_NAMING_LINK_CONFORMANCE.link),
  ) as { "/": { "link@1": Record<string, unknown> } })["/"]["link@1"];
  const cases: Array<Record<string, unknown>> = [
    // Schema-bearing: a per-lane covert channel.
    { ...base, schema: { type: "number" } },
    // Foreign id: must name the written document itself.
    { ...base, id: "of:other" },
    // Non-redirect overwrite.
    { ...base, overwrite: "value" },
    // Unknown key.
    { ...base, cfcLabelView: "smuggled" },
  ];
  for (const payload of cases) {
    assertEquals(
      violationCode({ "/": { "link@1": payload } }, "session"),
      "malformed-scope-naming-link",
    );
  }
  // Self-id is fine (the emitted base-relative form omits it; a present id
  // must equal the written document).
  assertEquals(
    violationCode(
      { "/": { "link@1": { ...base, id: "of:output" } } },
      "session",
    ),
    undefined,
  );
});

Deno.test("the self-redirect path property holds at session scope", () => {
  // Root form: a document-path ["value"] write carries cell path [].
  assertEquals(
    scopeNamingLinkWriteViolation({
      value: scopeNamingLinkForPath([], "session"),
      documentPath: ["value"],
      writtenDocId: "of:output",
      laneScope: "session",
    }),
    undefined,
  );
  // A path that does not self-redirect rejects.
  assertEquals(
    scopeNamingLinkWriteViolation({
      value: scopeNamingLinkForPath(["elsewhere"], "session"),
      documentPath: ["value", "value"],
      writtenDocId: "of:output",
      laneScope: "session",
    })?.code,
    "malformed-scope-naming-link",
  );
});

// ---------------------------------------------------------------------------
// The AUXILIARY result-instance form. `scoped-cell-instances.md` requires
// that "broader output locations then store links to that scoped instance
// with the same causal id" — a CROSS-document link, which the self-redirect
// shape above cannot express. Admitted only against an explicit admission
// set drawn from the action's own trusted certificate.
// ---------------------------------------------------------------------------

const SERVED_SPACE = "did:key:z6Mk-scope-naming-served";

const auxiliaryCode = (
  value: unknown,
  options: {
    declaredWriteIds?: readonly string[];
    laneScope?: "user" | "session";
    documentPath?: readonly string[];
  } = {},
): string | undefined =>
  scopeNamingLinkWriteViolation({
    value: value as FabricValue,
    documentPath: options.documentPath ?? ["value"],
    writtenDocId: "of:output",
    laneScope: options.laneScope ?? "user",
    ...(options.declaredWriteIds === undefined ? {} : {
      auxiliary: {
        declaredWriteIds: new Set(options.declaredWriteIds),
        servedSpace: SERVED_SPACE,
      },
    }),
  })?.code;

Deno.test("the auxiliary conformance fixture is the canonical builder output", () => {
  assertEquals(
    AUXILIARY_SCOPE_NAMING_LINK_CONFORMANCE.link,
    auxiliaryScopeNamingLinkForTarget({
      id: AUXILIARY_SCOPE_NAMING_LINK_CONFORMANCE.targetId,
    }),
  );
  // The exact wire shape a real user-scoped selector emits into its broad
  // output spot: a cross-document link naming the minted result at the
  // `user` scope NAME. No `overwrite` (a result reference, not a redirect)
  // and no principal or session id anywhere.
  assertEquals(
    JSON.parse(JSON.stringify(AUXILIARY_SCOPE_NAMING_LINK_CONFORMANCE.link)),
    { "/": { "link@1": { path: [], id: "of:minted-result", scope: "user" } } },
  );
  // Byte-identity across lanes: the builder takes no principal input, so two
  // lanes asking for the same target get identical bytes.
  assertEquals(
    JSON.stringify(auxiliaryScopeNamingLinkForTarget({ id: "of:minted" })),
    JSON.stringify(auxiliaryScopeNamingLinkForTarget({ id: "of:minted" })),
  );
});

Deno.test("an auxiliary link conforms only when the certificate declares its target", () => {
  const link = AUXILIARY_SCOPE_NAMING_LINK_CONFORMANCE.link;
  // Without an admission set at all, the pre-existing contract holds: a
  // foreign id is the foreign-id violation it has always been.
  assertEquals(auxiliaryCode(link), "malformed-scope-naming-link");
  // Declared: admitted.
  assertEquals(
    auxiliaryCode(link, { declaredWriteIds: ["of:minted-result"] }),
    undefined,
  );
  // Undeclared: still rejected. This is the bound that keeps the named id
  // certificate-derived — and therefore identical across lanes — instead of
  // a per-lane choice a broad reader could observe.
  assertEquals(
    auxiliaryCode(link, { declaredWriteIds: ["of:something-else"] }),
    "malformed-scope-naming-link",
  );
});

Deno.test("the auxiliary form keeps the payload discipline of the self form", () => {
  const declaredWriteIds = ["of:minted-result"];
  const base = (JSON.parse(
    JSON.stringify(AUXILIARY_SCOPE_NAMING_LINK_CONFORMANCE.link),
  ) as { "/": { "link@1": Record<string, unknown> } })["/"]["link@1"];
  const rejected: Array<Record<string, unknown>> = [
    // Schema-bearing: the per-lane covert channel, closed in both forms.
    { ...base, schema: { type: "string", default: "covert" } },
    // A session name under a user lane stays outside the lane's chain.
    { ...base, scope: "session" },
    // A resolved scope key or principal in place of the scope name.
    { ...base, scope: "user:did:key:alice" },
    // `space` is never a scope-naming target.
    { ...base, scope: "space" },
    // A foreign space: cross-space stays inadmissible.
    { ...base, space: "did:key:z6Mk-somewhere-else" },
    // Unknown keys.
    { ...base, sessionId: "s1" },
    // A non-redirect overwrite.
    { ...base, overwrite: "value" },
  ];
  for (const payload of rejected) {
    assertEquals(
      auxiliaryCode({ "/": { "link@1": payload } }, { declaredWriteIds }),
      "malformed-scope-naming-link",
      `expected rejection for ${JSON.stringify(payload)}`,
    );
  }
  const admitted: Array<Record<string, unknown>> = [
    // The served space may be named (the real emission carries it).
    { ...base, space: SERVED_SPACE },
    // `overwrite` is optional here, but "redirect" stays legal.
    { ...base, overwrite: "redirect" },
    // A path inside the named target; the self-redirect equality does not
    // apply because the link does not name its own document.
    { ...base, path: ["status"] },
  ];
  for (const payload of admitted) {
    assertEquals(
      auxiliaryCode({ "/": { "link@1": payload } }, { declaredWriteIds }),
      undefined,
      `expected admission for ${JSON.stringify(payload)}`,
    );
  }
});

Deno.test("the auxiliary admission never admits a broad VALUE write", () => {
  // The carve-out: admitting a scope REDIRECT into a scoped instance must
  // not admit a value. Alice's and Bob's user lanes resolve the same broad
  // document, so a broad value write from one is visible to the other.
  const declaredWriteIds = ["of:minted-result"];
  for (
    const value of [
      "a plain broad value",
      6,
      true,
      { chosen: "alice-only" },
      [1, 2, 3],
      { "/": { "link@1": { path: [], id: "of:minted-result" } } }, // no scope
    ]
  ) {
    const code = auxiliaryCode(value, { declaredWriteIds });
    assertEquals(
      code !== undefined,
      true,
      `expected rejection for ${JSON.stringify(value)}`,
    );
  }
  assertEquals(
    auxiliaryCode("a plain broad value", { declaredWriteIds }),
    "broad-lane-value-write",
  );
  assertEquals(
    auxiliaryCode({ chosen: "alice-only" }, { declaredWriteIds }),
    "broad-lane-value-write",
  );
});

Deno.test("a session lane may name its own chain in an auxiliary link", () => {
  const declaredWriteIds = ["of:minted-result"];
  for (const scope of ["user", "session"] as const) {
    assertEquals(
      auxiliaryCode(
        auxiliaryScopeNamingLinkForTarget({ id: "of:minted-result" }, scope),
        { declaredWriteIds, laneScope: "session" },
      ),
      undefined,
    );
  }
  // A user lane keeps rejecting the session name.
  assertEquals(
    auxiliaryCode(
      auxiliaryScopeNamingLinkForTarget({ id: "of:minted-result" }, "session"),
      { declaredWriteIds, laneScope: "user" },
    ),
    "malformed-scope-naming-link",
  );
});

Deno.test("container recursion threads the lane scope", () => {
  // Every leaf of a broad container write must conform under the SAME lane
  // scope — the recursive walk may not silently fall back to user-only.
  const container = {
    list: [scopeNamingLinkForPath(["list", "0"], "session")],
  };
  assertEquals(
    scopeNamingLinkWriteViolation({
      value: container as unknown as FabricValue,
      documentPath: ["value"],
      writtenDocId: "of:output",
      laneScope: "session",
    }),
    undefined,
  );
  assertEquals(
    scopeNamingLinkWriteViolation({
      value: container as unknown as FabricValue,
      documentPath: ["value"],
      writtenDocId: "of:output",
      laneScope: "user",
    })?.code,
    "malformed-scope-naming-link",
  );
  // A plain value leaf stays a broad value write in every lane.
  assertEquals(
    scopeNamingLinkWriteViolation({
      value: { list: [6] } as unknown as FabricValue,
      documentPath: ["value"],
      writtenDocId: "of:output",
      laneScope: "session",
    })?.code,
    "broad-lane-value-write",
  );
});
