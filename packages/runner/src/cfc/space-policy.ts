import type { PolicyRecord } from "./policy.ts";
import { DEFAULT_POLICY } from "./policy.ts";
import type { Label } from "./labels.ts";
import { emptyIntegrity, integrityFromAtoms } from "./integrity.ts";
import { hasRoleAtom, spaceAtom, userAtom } from "./atoms.ts";

/** A role assignment for a user within a space. */
export type SpaceRole = {
  principal: string;
  role: string;
};

/**
 * Manages policy records and role assignments per space.
 *
 * - Policies contain exchange rules for declassification.
 * - Roles determine user clearance within a space.
 * - The space owner (whose DID matches the space) always gets full clearance.
 */
export class SpacePolicyManager {
  private policies = new Map<string, PolicyRecord>();
  private roles = new Map<string, SpaceRole[]>();

  /** Get the active policy for a space. Returns DEFAULT_POLICY if none set. */
  getPolicy(space: string): PolicyRecord {
    return this.policies.get(space) ?? DEFAULT_POLICY;
  }

  /** Set a policy for a space (for testing or future cell-based loading). */
  setPolicy(space: string, policy: PolicyRecord): void {
    this.policies.set(space, policy);
  }

  /** Remove a space's policy, reverting to default. */
  clearPolicy(space: string): void {
    this.policies.delete(space);
  }

  /** Grant a role to a principal within a space. */
  grantRole(space: string, principal: string, role: string): void {
    const existing = this.roles.get(space) ?? [];
    if (!existing.some((r) => r.principal === principal && r.role === role)) {
      this.roles.set(space, [...existing, { principal, role }]);
    }
  }

  /** Revoke a role from a principal within a space. */
  revokeRole(space: string, principal: string, role: string): void {
    const existing = this.roles.get(space) ?? [];
    this.roles.set(
      space,
      existing.filter((r) => !(r.principal === principal && r.role === role)),
    );
  }

  /** Get all roles for a principal within a space. */
  getRoles(space: string, principal: string): string[] {
    const spaceRoles = this.roles.get(space) ?? [];
    return spaceRoles
      .filter((r) => r.principal === principal)
      .map((r) => r.role);
  }

  /**
   * Compute the clearance label for a user acting within a space.
   *
   * Clearance = confidentiality clauses that the user is allowed to read.
   * - Always includes: [[User(did)], [Space(space)]]
   * - Owner of a space (did === space) gets no additional restrictions
   * - Roles add HasRole integrity atoms that enable exchange rules
   */
  getClearance(userDid: string, space: string): Label {
    const roles = this.getRoles(space, userDid);
    const isOwner = userDid === space;

    // Base clearance: can read User(self) and Space(space) labeled data
    const confidentiality = [[userAtom(userDid)], [spaceAtom(space)]];

    // Build integrity from roles — these enable exchange rule preconditions
    const integrityAtoms = roles.map((role) =>
      hasRoleAtom(userDid, space, role)
    );

    // Owner implicitly has all access — represented by "owner" role integrity
    if (isOwner && !roles.includes("owner")) {
      integrityAtoms.push(hasRoleAtom(userDid, space, "owner"));
    }

    return {
      confidentiality,
      integrity: integrityAtoms.length > 0
        ? integrityFromAtoms(integrityAtoms)
        : emptyIntegrity(),
    };
  }
}
