import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { isRecord } from "@commonfabric/utils/types";
import type { URI } from "@commonfabric/memory/interface";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import { internalVerifierRead } from "../storage/reactivity-log.ts";
import { FORBIDDEN_OR_CLAUSE_ALTERNATIVE_TYPES, isOrClause } from "./clause.ts";
import type {
  CfcGrantResolver,
  CfcGrantResolverQuery,
} from "./exchange-eval.ts";

/**
 * CFC grant records (spec §8.12.7 route 2a; design
 * docs/specs/cfc-persisted-declassification.md §2): durable, revocable
 * release decisions persisted as content-addressed documents at a reserved
 * namespace, written only through the trusted policy-writer path
 * (`IExtendedStorageTransaction.writeCfcGrant`) and consumed at access time
 * by `policyState`-guarded exchange rules. The stored label of the released
 * value never changes — monotonicity is untouched; revocation is the grant's
 * lifecycle (mark revoked / expire); "disjunctions arise at access time"
 * stays true.
 *
 * ## Addressing decision (the design doc's one open point)
 *
 * A grant document's entity id derives deterministically from its RELEASE
 * SCOPE — `{ space, kind, owner, resource }` — hashed under a versioned
 * `cfcGrant` wrapper and carried under the reserved `grant:cfc:` id scheme
 * (the `cid:` schema-doc precedent: a distinct URI scheme IS the reserved
 * namespace, recognizable by the S18-class write gate without any registry):
 *
 *   id = `grant:cfc:` + hashStringOf({ cfcGrant:
 *          { version, space, kind, owner, resource } })
 *
 * Why these four fields and not the full record:
 *
 * - **Point-query-able (§4.9.3 discipline, never enumeration).** A consuming
 *   rule's guard binds `owner` from the label atom its `appliesTo` matched
 *   (a label-carried discovery) and names `kind`/`resource` concretely (or
 *   through already-bound variables), so the resolver can COMPUTE the one
 *   candidate address from `(kind + bound fields)` and point-read it. Fields
 *   that stay free in the guard — the audience being resolved — must
 *   therefore not participate in the address.
 * - **Revocable in place.** `audience`, `expiresAt` and `revoked` live in the
 *   document VALUE, not the address: revoking (or extending) a grant updates
 *   the same document, and consumers stop resolving it on the next
 *   evaluation. Hashing the full record would give a revocation a NEW
 *   address while the old address kept resolving the un-revoked content —
 *   exactly backwards.
 * - **One decision per scope.** Two grants by the same owner over the same
 *   resource under the same kind are the SAME durable decision (audience is
 *   the decision's current extent) — matching the §4.9.3 ACL precedent (one
 *   ACL doc per space whose value maps principals to capabilities; here: one
 *   grant doc per release scope whose value lists the audience).
 * - **Verified on read.** The stored value repeats the identity fields; the
 *   resolver recomputes the address from them and refuses a document that
 *   does not hash to the address it sits at (a forgery/corruption), before
 *   any lifecycle or audience check. Fail closed throughout.
 *
 * The GOVERNING SPACE for this PR is the owner's identity space
 * (`space === owner`): only the owner (and their runtime) holds write
 * authority there, so a verified document at the derived address carries the
 * owner's release authority implicitly — the same way the space ACL document
 * is owner-gated by living in the space it governs. Grants hosted in shared
 * spaces (a team space's policy root) need per-document write-attribution
 * verification and arrive with the B2b space-hosted policy work.
 */

/** Reserved id scheme for grant documents. The whole document is policy
 * state: any unprivileged write at any path under an id with this prefix is
 * recorded and fails closed (S18-class, `noteSystemWrite`). */
export const CFC_GRANT_ID_PREFIX = "grant:cfc:";

/** Version stamped into both the address derivation and the stored value. */
export const CFC_GRANT_VERSION = 1;

/** Digest marker recorded for a consulted candidate address that resolved to
 * no document — binding "we looked and found nothing" into the prepared
 * digest, so a grant appearing between prepare and commit changes it. */
export const CFC_GRANT_ABSENT_DIGEST = "absent";

/** The identity (address-determining) fields of a grant. */
export type CfcGrantIdentity = {
  /** Governing space the document lives in (== `owner` in this PR). */
  readonly space: string;
  /** Grant kind matched by `policyState` guards ("ShareGrant", …). */
  readonly kind: string;
  /** DID whose release authority this grant spends. */
  readonly owner: string;
  /** What it releases: a doc reference (URI string) or an atom-pattern
   * scope record (design §2.1 `Reference | AtomPattern`). */
  readonly resource: unknown;
};

/** A verified grant record (design doc §2.1 shape). */
export type CfcGrant = CfcGrantIdentity & {
  readonly version: typeof CFC_GRANT_VERSION;
  /** Principal-like atoms (§3.1.8-validated) the release extends to. */
  readonly audience: readonly unknown[];
  readonly grantedAt: number;
  readonly expiresAt?: number;
  /** §6 intent attribution once the intent substrate exists. */
  readonly sourceIntentId?: string;
  readonly revoked?: { readonly at: number; readonly by: string };
};

/** Authoring input for the trusted policy-writer path. */
export type CfcGrantWriteInput = {
  readonly kind: string;
  readonly owner: string;
  readonly resource: unknown;
  readonly audience: readonly unknown[];
  /** Defaults to `owner` — the v1 governing-space posture (module doc). */
  readonly space?: string;
  /** Defaults to the runner clock at write time. */
  readonly grantedAt?: number;
  readonly expiresAt?: number;
  readonly sourceIntentId?: string;
  readonly revoked?: { readonly at: number; readonly by: string };
};

/** The derived grant-document id for a release scope (module doc). */
export const cfcGrantDocId = (identity: CfcGrantIdentity): URI =>
  `${CFC_GRANT_ID_PREFIX}${
    hashStringOf({
      cfcGrant: {
        version: CFC_GRANT_VERSION,
        space: identity.space,
        kind: identity.kind,
        owner: identity.owner,
        resource: identity.resource,
      },
    })
  }` as URI;

const isDid = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("did:");

// `var` is the atom-pattern placeholder key (atom-pattern.ts reserved-key
// discipline). An audience entry carrying one anywhere would interact with
// pattern matching when the entry later lands in a clause — refuse at write.
const containsVarKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsVarKey);
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, "var")) return true;
  return Object.values(value).some(containsVarKey);
};

/**
 * §3.1.8 principal-like validation for one audience entry — the same
 * discipline `disallowedAuthoredClauseReason` applies to authored OR-clause
 * alternatives (a grant audience entry IS a future clause alternative, added
 * by the consuming rule's postcondition). Returns a reason, or undefined
 * when the entry is admissible.
 */
export const disallowedGrantAudienceEntryReason = (
  entry: unknown,
): string | undefined => {
  if (!isRecord(entry) || Array.isArray(entry)) {
    return "audience entries must be principal-like atom records";
  }
  if (isOrClause(entry)) {
    return "audience entries must be atoms, not anyOf clauses";
  }
  if (containsVarKey(entry)) {
    return "audience entries must not carry pattern placeholders (var)";
  }
  const type = (entry as { type?: unknown }).type;
  if (typeof type !== "string" || type.length === 0) {
    return "audience entries need a string type";
  }
  if (FORBIDDEN_OR_CLAUSE_ALTERNATIVE_TYPES.has(type)) {
    return `audience entries of type ${type} are not permitted ` +
      `(spec §3.1.8: alternatives must be principal-like; ` +
      `Expires/Caveat forbidden as alternatives)`;
  }
  return undefined;
};

/**
 * Validates a grant-write input into the exact document value + derived
 * address, throwing on any violation (the trusted policy-writer is
 * fail-closed config-style: a refused grant is an error the caller must
 * see, never a silently skipped write).
 *
 * Release-authority check for THIS PR: `owner` must equal the transaction's
 * acting principal (from the trust snapshot) — an owner grants only their own
 * authority, and a revocation must be attributed to that same principal. The
 * fuller §13.4.3 evidence chain (rendered-state match, trusted share surface,
 * intent consumption) strengthens this when the §6 intent substrate lands.
 */
export const prepareCfcGrantWrite = (
  input: CfcGrantWriteInput,
  actingPrincipal: string | undefined,
  now: number = Date.now(),
): { space: MemorySpace; id: URI; value: CfcGrant } => {
  if (!isRecord(input) || Array.isArray(input)) {
    throw new Error("cfc-grant: write input must be an object");
  }
  const { kind, owner, resource, audience } = input;
  if (typeof kind !== "string" || kind.length === 0) {
    throw new Error("cfc-grant: kind must be a non-empty string");
  }
  if (!isDid(owner)) {
    throw new Error("cfc-grant: owner must be a DID");
  }
  if (!isDid(actingPrincipal) || owner !== actingPrincipal) {
    throw new Error(
      "cfc-grant: owner must equal the transaction's acting principal " +
        "(release authority; §13.4.3 verification list, intent evidence " +
        "deferred)",
    );
  }
  const space = input.space ?? owner;
  if (space !== owner) {
    // v1 governing-space posture (module doc): grants live in the owner's
    // identity space. Shared-space policy roots arrive with B2b.
    throw new Error(
      "cfc-grant: space must equal owner (grants live in the owner's " +
        "identity space until B2b space-hosted policy roots)",
    );
  }
  if (
    resource === undefined || resource === null ||
    (typeof resource === "string" && resource.length === 0)
  ) {
    throw new Error("cfc-grant: resource must name what the grant releases");
  }
  if (!Array.isArray(audience) || audience.length === 0) {
    throw new Error("cfc-grant: audience must be a non-empty array");
  }
  for (const entry of audience) {
    const reason = disallowedGrantAudienceEntryReason(entry);
    if (reason !== undefined) {
      throw new Error(`cfc-grant: ${reason}`);
    }
  }
  const grantedAt = input.grantedAt ?? now;
  if (typeof grantedAt !== "number" || !Number.isFinite(grantedAt)) {
    throw new Error("cfc-grant: grantedAt must be a finite number");
  }
  if (
    input.expiresAt !== undefined &&
    (typeof input.expiresAt !== "number" || !Number.isFinite(input.expiresAt))
  ) {
    throw new Error("cfc-grant: expiresAt must be a finite number");
  }
  if (
    input.sourceIntentId !== undefined &&
    typeof input.sourceIntentId !== "string"
  ) {
    throw new Error("cfc-grant: sourceIntentId must be a string");
  }
  if (input.revoked !== undefined) {
    const revoked = input.revoked;
    if (
      !isRecord(revoked) || typeof revoked.at !== "number" ||
      !Number.isFinite(revoked.at) || !isDid(revoked.by)
    ) {
      throw new Error("cfc-grant: revoked must be { at: number, by: DID }");
    }
    if (revoked.by !== actingPrincipal) {
      throw new Error(
        "cfc-grant: revoked.by must equal the transaction's acting principal",
      );
    }
  }
  const value: CfcGrant = {
    version: CFC_GRANT_VERSION,
    space,
    kind,
    owner,
    resource,
    audience: [...audience],
    grantedAt,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.sourceIntentId !== undefined
      ? { sourceIntentId: input.sourceIntentId }
      : {}),
    ...(input.revoked !== undefined
      ? { revoked: { at: input.revoked.at, by: input.revoked.by } }
      : {}),
  };
  return {
    space: space as MemorySpace,
    id: cfcGrantDocId(value),
    value,
  };
};

/**
 * Verify-on-read (B2b storage discipline): a stored value is a grant only if
 * it is shape-valid AND its identity fields re-derive the exact address it
 * was read from AND its audience passes the §3.1.8 principal-like validation
 * (defense in depth — a document written by a client that skipped the write
 * gate must still not resolve). Anything else → `undefined`, fail closed.
 */
export const verifyCfcGrantDocument = (
  space: string,
  id: string,
  value: unknown,
): CfcGrant | undefined => {
  if (!isRecord(value) || Array.isArray(value)) return undefined;
  const candidate = value as Partial<CfcGrant> & Record<string, unknown>;
  if (candidate.version !== CFC_GRANT_VERSION) return undefined;
  if (
    typeof candidate.kind !== "string" || !isDid(candidate.owner) ||
    typeof candidate.space !== "string" || candidate.space !== space
  ) {
    return undefined;
  }
  if (!Array.isArray(candidate.audience) || candidate.audience.length === 0) {
    return undefined;
  }
  if (
    candidate.audience.some((entry) =>
      disallowedGrantAudienceEntryReason(entry) !== undefined
    )
  ) {
    return undefined;
  }
  if (
    typeof candidate.grantedAt !== "number" ||
    !Number.isFinite(candidate.grantedAt)
  ) {
    return undefined;
  }
  if (
    candidate.expiresAt !== undefined &&
    typeof candidate.expiresAt !== "number"
  ) {
    return undefined;
  }
  if (candidate.revoked !== undefined) {
    const revoked = candidate.revoked;
    if (
      !isRecord(revoked) || typeof revoked.at !== "number" ||
      !isDid((revoked as { by?: unknown }).by)
    ) {
      return undefined;
    }
  }
  // The content-address check: identity fields must re-derive the address.
  if (
    cfcGrantDocId({
      space: candidate.space,
      kind: candidate.kind,
      owner: candidate.owner,
      resource: candidate.resource,
    }) !== id
  ) {
    return undefined;
  }
  return candidate as CfcGrant;
};

/** Unrevoked and unexpired at `now` (revocation/expiry honored at
 * RESOLUTION — spec §8.12.7 2a: "revocation is the grant's lifecycle"). */
export const cfcGrantIsLive = (grant: CfcGrant, now: number): boolean =>
  grant.revoked === undefined &&
  (grant.expiresAt === undefined || now < grant.expiresAt);

/**
 * Expands a verified live grant into its match-pool FACTS: one record per
 * audience entry, carrying the grant's scalar fields plus that single entry
 * under `audience`. `policyState` guard patterns match these facts (subset
 * field semantics), so a guard binding `audience: {var: "$recipient"}` (or a
 * nested `{type: User, subject: {var}}` pattern) enumerates the §4.3.4
 * disjunction of all audience matches — one rule firing per released
 * principal. Fact order follows the stored audience array (content-
 * determined, deterministic).
 */
export const expandCfcGrantFacts = (grant: CfcGrant): readonly unknown[] =>
  grant.audience.map((entry) => ({
    kind: grant.kind,
    space: grant.space,
    owner: grant.owner,
    resource: grant.resource,
    audience: entry,
    grantedAt: grant.grantedAt,
    ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
    ...(grant.sourceIntentId !== undefined
      ? { sourceIntentId: grant.sourceIntentId }
      : {}),
  }));

const INTERNAL_VERIFIER_META = { ...internalVerifierRead };

/**
 * The runner-side grant resolver for boundary evaluation sites that hold a
 * transaction (the sink egress gate and the input-requirement gate in
 * prepare.ts). All I/O lives here — the evaluator stays pure:
 *
 * - Candidate address: computed from `(kind + bound fields)` — `owner` (a
 *   bound DID) fixes the governing space (module doc), `resource` completes
 *   the release scope. A query with either unresolved returns nothing: the
 *   guard's variables must be bound from the label under evaluation (the
 *   §4.9.3 label-carried discovery), never enumerated. Rules that leave
 *   `resource` free (the §13.4.4 shape at a site that binds it from the
 *   evaluation context) arrive with the share-UI build-order item.
 * - Point read at the derived address, under `internalVerifierRead` metadata
 *   (the `readStoredCfcMetadata` idiom) so grant lookups never enter the
 *   consumed set or PC (design §2.3 soundness condition 2).
 * - Every consulted candidate — present or absent — is recorded with its
 *   content digest into the transaction's CFC state; B5-style digest binding
 *   (`PreparedDigestInput.consultedGrants`) invalidates a prepared decision
 *   whose grant inputs drift (design §2.3 soundness condition 3).
 * - Verification, then lifecycle: absent, malformed, address-mismatched,
 *   revoked, or expired grants resolve nothing (fail closed).
 * - Per-query memo: the transaction reads from a stable snapshot, so a
 *   fixpoint pass re-querying the same guard resolves identically; the memo
 *   keeps repeated evaluation cheap and the consulted-set recording
 *   once-per-candidate.
 *
 * The clock defaults to the runner's wall clock (`Date.now`, the builtin
 * idiom) — injected here, NEVER read inside the pure evaluator.
 */
export const createTxCfcGrantResolver = (
  tx: IExtendedStorageTransaction,
  opts: { readonly now?: () => number } = {},
): CfcGrantResolver => {
  const now = opts.now ?? Date.now;
  const memo = new Map<string, readonly unknown[]>();
  return (query: CfcGrantResolverQuery): readonly unknown[] => {
    const owner = query.fields.owner;
    const resource = query.fields.resource;
    if (!isDid(owner) || resource === undefined || resource === null) {
      return [];
    }
    // v1 governing space == owner's identity space (module doc). An explicit
    // bound `space` field must agree; anything else fails closed.
    const space = query.fields.space ?? owner;
    if (space !== owner) return [];
    const id = cfcGrantDocId({ space, kind: query.kind, owner, resource });
    const memoKey = `${space}\0${id}`;
    const memoized = memo.get(memoKey);
    if (memoized !== undefined) return memoized;
    let facts: readonly unknown[] = [];
    try {
      const value = tx.readOrThrow({
        space: space as MemorySpace,
        id,
        type: "application/json",
        path: ["value"],
      }, { meta: INTERNAL_VERIFIER_META });
      tx.recordCfcConsultedGrant({
        space: space as MemorySpace,
        id,
        digest: value === undefined
          ? CFC_GRANT_ABSENT_DIGEST
          : hashStringOf(value),
      });
      if (value !== undefined) {
        const grant = verifyCfcGrantDocument(space, id, value);
        if (grant === undefined) {
          tx.noteCfcDiagnostic(
            `cfc-grant: malformed grant document at ${id} (fail closed)`,
          );
        } else if (cfcGrantIsLive(grant, now())) {
          facts = expandCfcGrantFacts(grant);
        }
      }
    } catch {
      // Fail closed on read errors (unsynced replica, storage failure): the
      // grant does not resolve; the §4.9.3 posture. The candidate was
      // recorded above only if the read succeeded — a read that THREW never
      // produced a value this decision could have consumed.
      facts = [];
    }
    memo.set(memoKey, facts);
    return facts;
  };
};
