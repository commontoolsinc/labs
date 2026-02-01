import type { PolicyRecord } from "./policy.ts";
import { DEFAULT_POLICY } from "./policy.ts";

/**
 * Manages policy records per space. For now, returns the default policy.
 * Future: loads policy from a well-known cell in each space and subscribes
 * to changes.
 */
export class SpacePolicyManager {
  private policies = new Map<string, PolicyRecord>();

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
}
