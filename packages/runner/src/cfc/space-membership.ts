import {
  type ACL,
  ANYONE_USER,
  type Capability,
  isACL,
  isCapable,
} from "@commonfabric/memory/acl";

/**
 * §4.9.3 render membership lookup (design:
 * docs/specs/cfc-render-membership-lookup.md). The verified source of the
 * `HasRole(actingUser, space, reader)` facts the render ceiling mints to admit
 * a cross-space `Space(...)` label — sourced from the space's declared ACL
 * document, NEVER from a cell's mere local residency (residency is not read
 * authority; H3b commit 4fc05f800).
 */

/** A principal's role in a space, or `null` if none (fail closed). */
export type SpaceRole = "owner" | "writer" | "reader";

const capToRole: Record<Capability, SpaceRole> = {
  READ: "reader",
  WRITE: "writer",
  OWNER: "owner",
};

/**
 * A principal's reader-or-higher role in a space, or `null` when it holds
 * none. A client-side mirror of the server's `#resolveCapability`
 * (packages/memory/v2/server.ts `#resolveCapability`), so the render gate's
 * authority decision cannot drift from the server's — the two consult the
 * SAME `@commonfabric/memory/acl` helpers (`isACL`, `isCapable`, `ANYONE_USER`).
 *
 * Resolution order (mirrors the server exactly):
 *  1. Implicit `OWNER` when `principal === space` (a principal owns its own
 *     identity space) or `principal` is a configured service DID — these hold
 *     regardless of ACL contents or deployment ACL mode.
 *  2. Otherwise the ACL document decides: `acl[principal] ?? acl["*"]`. A
 *     missing/malformed ACL, an unlisted principal with no `"*"` grant, or a
 *     capability short of READ all yield `null` (fail closed). The implicit
 *     owners above are unaffected by an absent ACL.
 *
 * `acl` is the space's ACL doc value (`undefined` = not yet read / absent):
 * both `undefined` and a malformed value fail closed. A returned role is
 * always reader-or-higher — every `Capability` is `isCapable(_, "READ")`, so
 * any explicit grant admits reader access; the exact rank is returned for
 * callers that need it, but the render mint only needs non-`null`.
 */
export const spaceReaderRole = (
  acl: ACL | undefined,
  space: string,
  principal: string,
  serviceDids: readonly string[] = [],
): SpaceRole | null => {
  // Implicit OWNER: you own your own identity space; service principals.
  if (principal === space || serviceDids.includes(principal)) return "owner";
  // Missing or malformed ACL document grants nothing (fail closed).
  if (!isACL(acl)) return null;
  const byPrincipal = acl as Record<string, Capability | undefined>;
  const cap = byPrincipal[principal] ?? byPrincipal[ANYONE_USER];
  if (cap === undefined) return null;
  // WRITE/OWNER imply READ; a defensive guard mirroring the server's
  // `isCapable(capability, requirement)` — `Capability` is only ever
  // READ/WRITE/OWNER, so a valid grant always clears READ.
  if (!isCapable(cap, "READ")) return null;
  return capToRole[cap];
};
