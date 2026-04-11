/**
 * Agent Visibility Policy
 *
 * Controls what data an agent can observe based on label integrity.
 * The main agent can't see injection-tainted data; sub-agents can
 * (but their outputs inherit the taint).
 */

import { Atom, Label } from "../labels.ts";

/** Defines what integrity atoms are required for an agent to see data */
export interface AgentPolicy {
  name: string;
  /** Integrity atoms required on data for this agent to see it.
   *  If empty, agent can see everything. */
  requiredIntegrity: Atom[];
  /** Whether ALL required atoms must be present, or just ANY one */
  mode: "all" | "any";
  /** If true, agent can spawn sub-agents with relaxed policies */
  canSpawnSubAgents: boolean;
  /** Description for audit/display */
  description: string;
}

/** Pre-built policies */
export const policies = {
  /** Main agent: can only see injection-free data */
  main(): AgentPolicy {
    return {
      name: "main-agent",
      requiredIntegrity: [{ kind: "InjectionFree" }],
      mode: "all",
      canSpawnSubAgents: true,
      description: "Can only see data attested as injection-free",
    };
  },

  /** Sub-agent: can see everything (including injection-tainted data) */
  sub(): AgentPolicy {
    return {
      name: "sub-agent",
      requiredIntegrity: [],
      mode: "all",
      canSpawnSubAgents: true,
      description: "Can see all data including injection-tainted content",
    };
  },

  /** Restricted sub-agent: can see everything but cannot spawn */
  restricted(): AgentPolicy {
    return {
      name: "restricted-sub-agent",
      requiredIntegrity: [],
      mode: "all",
      canSpawnSubAgents: false,
      description: "Can see all data but cannot spawn sub-agents",
    };
  },
};

/**
 * Check if a label satisfies a policy's visibility requirements.
 * Returns null if visible, or a reason string if filtered.
 */
export function checkVisibility(
  label: Label,
  policy: AgentPolicy,
): string | null {
  if (policy.requiredIntegrity.length === 0) {
    return null; // no requirements = see everything
  }

  const hasAtom = (required: Atom) =>
    label.integrity.some((a) => a.kind === required.kind);

  if (policy.mode === "all") {
    for (const required of policy.requiredIntegrity) {
      if (!hasAtom(required)) {
        return `Data lacks required integrity: ${required.kind}`;
      }
    }
    return null;
  } else {
    // "any" mode
    if (policy.requiredIntegrity.some((r) => hasAtom(r))) {
      return null;
    }
    return `Data lacks any of required integrity: ${
      policy.requiredIntegrity.map((a) => a.kind).join(", ")
    }`;
  }
}

/**
 * Filter output content based on policy. Returns the filtered content
 * and whether filtering occurred.
 */
export function filterOutput(
  content: string,
  label: Label,
  policy: AgentPolicy,
): { content: string; filtered: boolean; reason?: string } {
  // Empty content cannot contain injection — skip filtering.
  if (content.length === 0) {
    return { content, filtered: false };
  }
  const reason = checkVisibility(label, policy);
  if (reason) {
    return {
      content: `[FILTERED: ${reason}]`,
      filtered: true,
      reason,
    };
  }
  return { content, filtered: false };
}
