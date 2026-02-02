/**
 * Exchange Rule System
 *
 * Implements policy enforcement at commit points based on data labels and PC labels.
 * Exchange rules determine whether data flows are permitted based on integrity
 * and confidentiality requirements.
 */

import { Atom, Label } from "./labels.ts";

/**
 * Matches atoms by kind and optional parameters
 */
export interface AtomMatcher {
  kind: Atom["kind"];
  /** If provided, all specified fields must match */
  params?: Record<string, unknown>;
}

/**
 * An exchange rule governing data flow at commit points
 */
export interface ExchangeRule {
  name: string;
  /** What triggers this rule */
  match: {
    /** Command names this rule applies to */
    commands?: string[];
    /** Or: any command that is a commit point */
    commitPoint?: boolean;
    /** Or: any command in this category */
    category?:
      | "exec"
      | "network-egress"
      | "network-fetch"
      | "destructive-write"
      | "env-mutation";
  };
  /** Conditions that must be met for the flow to be allowed */
  requires?: {
    /** Data must have at least one of these integrity atoms */
    integrity?: AtomMatcher[];
    /** Data must NOT have these integrity atoms (blacklist) */
    notIntegrity?: AtomMatcher[];
    /** PC must have at least one of these integrity atoms */
    pcIntegrity?: AtomMatcher[];
    /** Data must be public (empty confidentiality) */
    publicOnly?: boolean;
  };
  /** What to do on violation */
  onViolation: "block" | "request-intent" | "warn" | "sandbox";
  /** Human-readable description */
  description: string;
  /** Priority (lower = checked first) */
  priority: number;
}

export interface Verdict {
  allowed: boolean;
  rule?: ExchangeRule;
  reason?: string;
  action?: "block" | "request-intent" | "warn" | "sandbox";
}

/**
 * Check if an atom matches a matcher
 */
export function atomMatchesMatcher(atom: Atom, matcher: AtomMatcher): boolean {
  if (atom.kind !== matcher.kind) {
    return false;
  }

  // If no params specified, just kind match is enough
  if (!matcher.params) {
    return true;
  }

  // Check that all specified param fields match
  for (const [key, value] of Object.entries(matcher.params)) {
    if ((atom as any)[key] !== value) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a label has at least one atom matching any of the matchers
 */
export function atomMatchesAny(label: Label, matchers: AtomMatcher[]): boolean {
  return label.integrity.some((atom) =>
    matchers.some((matcher) => atomMatchesMatcher(atom, matcher))
  );
}

/**
 * Evaluates exchange rules against data flows
 */
export class ExchangeRuleEvaluator {
  private rules: ExchangeRule[] = [];

  addRule(rule: ExchangeRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => a.priority - b.priority);
  }

  addRules(rules: ExchangeRule[]): void {
    for (const r of rules) {
      this.addRule(r);
    }
  }

  /**
   * Evaluate rules against a data flow.
   * @param command - the command name being executed
   * @param category - the command's category
   * @param dataLabel - the label of the data being processed
   * @param pcLabel - the current PC label
   * @returns Verdict - whether the flow is allowed
   */
  evaluate(
    command: string,
    category: ExchangeRule["match"]["category"] | undefined,
    dataLabel: Label,
    pcLabel: Label,
  ): Verdict {
    // Check rules in priority order
    for (const rule of this.rules) {
      // Check if rule matches this command/category
      if (!this.ruleMatches(rule, command, category)) {
        continue;
      }

      // Check if requirements are met
      const violation = this.checkRequirements(rule, dataLabel, pcLabel);
      if (violation) {
        return {
          allowed: false,
          rule,
          reason: violation,
          action: rule.onViolation,
        };
      }

      // Intent-gate rules with no substantive requirements always trigger
      if (rule.onViolation === "request-intent") {
        const r = rule.requires;
        const hasSubstantiveReqs = r && (
          r.integrity || r.notIntegrity || r.pcIntegrity || r.publicOnly
        );
        if (!hasSubstantiveReqs) {
          return {
            allowed: false,
            rule,
            reason: `${rule.name}: requires intent`,
            action: "request-intent",
          };
        }
      }

      // Rule matches and requirements met - allow
      return {
        allowed: true,
        rule,
      };
    }

    // No rule matched - default allow
    return {
      allowed: true,
    };
  }

  private ruleMatches(
    rule: ExchangeRule,
    command: string,
    category: ExchangeRule["match"]["category"] | undefined,
  ): boolean {
    if (rule.match.commands && rule.match.commands.includes(command)) {
      return true;
    }

    if (rule.match.category && rule.match.category === category) {
      return true;
    }

    if (rule.match.commitPoint) {
      // This would be checked by the caller marking certain commands as commit points
      // For now, we consider network and exec categories as commit points
      return category === "network-egress" ||
        category === "exec" ||
        category === "destructive-write";
    }

    return false;
  }

  private checkRequirements(
    rule: ExchangeRule,
    dataLabel: Label,
    pcLabel: Label,
  ): string | null {
    if (!rule.requires) {
      return null;
    }

    // Check data integrity requirements
    if (rule.requires.integrity) {
      if (!atomMatchesAny(dataLabel, rule.requires.integrity)) {
        return `Data lacks required integrity atoms: ${
          rule.requires.integrity.map((m) => m.kind).join(", ")
        }`;
      }
    }

    // Check data integrity blacklist
    if (rule.requires.notIntegrity) {
      for (const matcher of rule.requires.notIntegrity) {
        if (
          dataLabel.integrity.some((atom) => atomMatchesMatcher(atom, matcher))
        ) {
          return `Data has blacklisted integrity atom: ${matcher.kind}`;
        }
      }
    }

    // Check PC integrity requirements
    if (rule.requires.pcIntegrity) {
      if (!atomMatchesAny(pcLabel, rule.requires.pcIntegrity)) {
        return `PC lacks required integrity atoms: ${
          rule.requires.pcIntegrity.map((m) => m.kind).join(", ")
        }`;
      }
    }

    // Check confidentiality requirement (public only)
    if (rule.requires.publicOnly) {
      if (dataLabel.confidentiality.length > 0) {
        return `Data has confidentiality constraints and cannot be made public`;
      }
    }

    return null;
  }
}
