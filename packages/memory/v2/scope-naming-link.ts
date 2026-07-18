import type { FabricValue } from "@commonfabric/api";
import { isInstance, isObject } from "@commonfabric/utils/types";

/**
 * Scope-naming-link wire contract (context-lattice design §4, C1.2).
 *
 * When a lane computation's output lands in a broader scoped instance, the
 * runner's output-scoping step writes a **self-redirect link naming only the
 * scope** at the broad address — never a value, never the principal or
 * session id — so every lane writes the byte-identical link at the identical
 * address. The execution firewall keeps this contract as the backstop: a
 * scoped-lane commit (user or, with C2.2, session rank) may write a broad
 * (space-scoped) document only as a conforming scope-naming link; a broad
 * VALUE write indicates output-scoping failed and is rejected.
 *
 * The wire shape is a spec-level JSON contract shared by the runner emit
 * tests and the engine accept tests through the conformance fixture below
 * (memory takes no runner dependency; the runner conforms to this module).
 * The envelope is the sigil link-ref form owned by `data-model/cell-rep`
 * (`LINK_V1_TAG`), pinned here by value:
 *
 * ```json
 * { "/": { "link@1": { "path": ["value"], "scope": "user",
 *                      "overwrite": "redirect" } } }
 * ```
 *
 * Payload contract — exactly the addressing-fields envelope as actually
 * emitted (`pattern-binding.ts` `createSigilLinkFromParsedLink` with the
 * write-redirect binding as base):
 *
 * - `path` (required): array of strings; the cell path of the link within
 *   the written document. Documents store the cell tree under their `value`
 *   field, so an envelope at document path `["value", ...p]` must carry
 *   `path === p` (the self-redirect property: only the scope differs).
 * - `scope` (required): a scope NAME in the validating lane's own non-space
 *   chain (context-lattice §2: `space < user < session`) — `"user"` for a
 *   user lane; `"user"` or `"session"` for a session lane (C2.2/CA2 — the
 *   broader-in-chain rule: a session lane's chain includes its principal's
 *   user rank, and a user-named link is byte-identical to what every user
 *   lane writes). NEVER a resolved scope key, principal, or session id —
 *   the reading runtime context supplies those.
 * - `overwrite` (required): exactly `"redirect"` — the emission path always
 *   resolves the binding in write-redirect mode with `preserveOverwrite`.
 * - `id` (optional): omitted for the self case (emission is base-relative);
 *   when present it must equal the written document id. A foreign id is
 *   nonconforming.
 * - `schema` and every other key are contract violations: `schema` carries
 *   an arbitrary FabricValue and would be a per-lane covert channel; `space`
 *   is never emitted same-space and cross-space is inadmissible anyway.
 */
export const SCOPE_NAMING_LINK_TAG = "link@1";

/**
 * The scope names a scope-naming link may carry — the non-space ranks of
 * the context lattice. Also the validator's lane parameter: the validating
 * lane's OWN rank, which bounds the admissible names to that lane's chain.
 */
export type ScopeNamingLinkScope = "user" | "session";

/**
 * Canonical conforming envelope for a cell path. This is the exact value
 * output-scoping emits for a self-scoped broad write at `path`; the runner
 * emit-side conformance tests assert its real emission equals this builder's
 * output, and the engine accept tests feed the same value to the firewall.
 * A pure function of (path, scope) — deliberately no principal or session
 * id input exists, which is what makes the emitted write byte-identical
 * across lanes (context-lattice §4).
 */
export const scopeNamingLinkForPath = (
  path: readonly string[],
  scope: ScopeNamingLinkScope = "user",
): FabricValue => ({
  "/": {
    [SCOPE_NAMING_LINK_TAG]: {
      path: [...path],
      scope,
      overwrite: "redirect",
    },
  },
});

/**
 * Shared conformance fixture: the broad-instance write output-scoping emits
 * for a `user`-narrowed output bound at cell path `["value"]`, captured from
 * the real runner emission (2026-07-16). `documentPath` is where the
 * envelope sits inside the written document (`value`-rooted).
 */
export const SCOPE_NAMING_LINK_CONFORMANCE = Object.freeze({
  cellPath: Object.freeze(["value"]),
  documentPath: Object.freeze(["value", "value"]),
  link: scopeNamingLinkForPath(["value"]),
}) as {
  readonly cellPath: readonly string[];
  readonly documentPath: readonly string[];
  readonly link: FabricValue;
};

/**
 * Session variant of {@link SCOPE_NAMING_LINK_CONFORMANCE} (C2.2/CA2): the
 * broad-instance write output-scoping emits for a `session`-narrowed output
 * bound at cell path `["value"]`, captured from the real runner emission
 * (2026-07-17). Identical envelope, scope name `"session"` — still never a
 * session id.
 */
export const SESSION_SCOPE_NAMING_LINK_CONFORMANCE = Object.freeze({
  cellPath: Object.freeze(["value"]),
  documentPath: Object.freeze(["value", "value"]),
  link: scopeNamingLinkForPath(["value"], "session"),
}) as {
  readonly cellPath: readonly string[];
  readonly documentPath: readonly string[];
  readonly link: FabricValue;
};

export interface ScopeNamingLinkViolation {
  /** Execution-action firewall diagnostic code. */
  code: "broad-lane-value-write" | "malformed-scope-naming-link";
  detail: string;
}

const PAYLOAD_KEYS = new Set(["id", "path", "scope", "overwrite"]);

const isPlainRecord = (
  value: unknown,
): value is Record<string, FabricValue> =>
  isObject(value) && !isInstance(value);

/**
 * A value shaped like a link-ref envelope: a single-`"/"`-key record. Any
 * such value must then fully conform — a partial or versioned-differently
 * envelope is malformed, never a tolerated plain value.
 */
const envelopeBody = (
  value: FabricValue,
): Record<string, FabricValue> | "not-an-envelope" | undefined => {
  if (!isPlainRecord(value)) return "not-an-envelope";
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "/") return "not-an-envelope";
  const body = value["/"];
  return isPlainRecord(body) ? body : undefined;
};

/**
 * The scope names a lane of rank `laneScope` accepts in a broad link: the
 * lane's own non-space chain (context-lattice §2). A user lane's chain
 * above space is exactly `user`; a session lane's includes `user` (its
 * principal's broader rank — review CA3) and `session`. Cross-lane names —
 * `session` under a user lane — reject: that link would redirect readers to
 * instances the lane's computations can never have written.
 */
const admissibleLinkScopes = (
  laneScope: ScopeNamingLinkScope,
): readonly string[] => laneScope === "session" ? ["user", "session"] : ["user"];

const payloadViolation = (
  payload: Record<string, FabricValue>,
  documentPath: readonly string[],
  writtenDocId: string,
  laneScope: ScopeNamingLinkScope,
): ScopeNamingLinkViolation | undefined => {
  const malformed = (detail: string): ScopeNamingLinkViolation => ({
    code: "malformed-scope-naming-link",
    detail,
  });
  for (const key of Object.keys(payload)) {
    if (!PAYLOAD_KEYS.has(key)) {
      return malformed(
        key === "schema"
          ? "scope-naming links must not carry a schema"
          : `scope-naming link carries unknown key "${key}"`,
      );
    }
  }
  if (payload.overwrite !== "redirect") {
    return malformed('scope-naming links carry overwrite "redirect"');
  }
  const scopes = admissibleLinkScopes(laneScope);
  if (typeof payload.scope !== "string" || !scopes.includes(payload.scope)) {
    return malformed(
      `scope-naming links under a ${laneScope} lane name a scope in [${
        scopes.join(", ")
      }] — never a principal or session id`,
    );
  }
  if (payload.id !== undefined && payload.id !== writtenDocId) {
    return malformed(
      "scope-naming links must name the written document itself",
    );
  }
  const path = payload.path;
  if (
    !Array.isArray(path) ||
    path.some((segment) => typeof segment !== "string")
  ) {
    return malformed("scope-naming link path must be an array of strings");
  }
  const expected = documentPath[0] === "value"
    ? documentPath.slice(1)
    : undefined;
  if (
    expected === undefined || path.length !== expected.length ||
    path.some((segment, index) => segment !== expected[index])
  ) {
    return malformed(
      "scope-naming link path must self-redirect the written document path",
    );
  }
  return undefined;
};

/**
 * Validate one scoped-lane write payload against a broad (space-scoped)
 * document position: every leaf must be a conforming scope-naming link at
 * its own document path; any plain value — primitives, class instances,
 * empty containers, malformed envelopes — is a broad value write and
 * violates §4's byte-identity soundness argument. Fail-closed: an unserved
 * rejection here costs a fail-open client recompute, never a wrong write.
 *
 * `laneScope` is the validating lane's rank and bounds the scope names a
 * link may carry to that lane's own chain (C2.2/CA2). It defaults to
 * `"user"`, keeping every existing caller — the engine firewall included —
 * byte-identical to the pre-C2 user-only contract until it explicitly
 * threads the session rank.
 */
export const scopeNamingLinkWriteViolation = (options: {
  value: FabricValue | undefined;
  /** Document-rooted path at which `value` is being written. */
  documentPath: readonly string[];
  writtenDocId: string;
  laneScope?: ScopeNamingLinkScope;
}): ScopeNamingLinkViolation | undefined => {
  const { value, documentPath, writtenDocId } = options;
  const laneScope = options.laneScope ?? "user";
  const broad = (detail: string): ScopeNamingLinkViolation => ({
    code: "broad-lane-value-write",
    detail,
  });
  const body = envelopeBody(value as FabricValue);
  if (body === undefined) {
    return {
      code: "malformed-scope-naming-link",
      detail: "link envelope body must be a single-version record",
    };
  }
  if (body !== "not-an-envelope") {
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== SCOPE_NAMING_LINK_TAG) {
      return {
        code: "malformed-scope-naming-link",
        detail: `link envelope must carry exactly ${SCOPE_NAMING_LINK_TAG}`,
      };
    }
    const payload = body[SCOPE_NAMING_LINK_TAG];
    if (!isPlainRecord(payload)) {
      return {
        code: "malformed-scope-naming-link",
        detail: "scope-naming link payload must be a record",
      };
    }
    return payloadViolation(payload, documentPath, writtenDocId, laneScope);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return broad("empty array is a broad value write");
    }
    for (let index = 0; index < value.length; index++) {
      const violation = scopeNamingLinkWriteViolation({
        value: value[index],
        documentPath: [...documentPath, String(index)],
        writtenDocId,
        laneScope,
      });
      if (violation !== undefined) return violation;
    }
    return undefined;
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return broad("empty record is a broad value write");
    }
    for (const [key, entry] of entries) {
      const violation = scopeNamingLinkWriteViolation({
        value: entry,
        documentPath: [...documentPath, key],
        writtenDocId,
        laneScope,
      });
      if (violation !== undefined) return violation;
    }
    return undefined;
  }
  return broad(
    `broad write at /${
      documentPath.join("/")
    } is a value, not a scope-naming link`,
  );
};
