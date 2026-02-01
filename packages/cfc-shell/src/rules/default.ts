/**
 * Default Exchange Rules
 *
 * Provides a baseline security policy for the CFC shell.
 * These rules defend against:
 * - Prompt injection (exec integrity gate)
 * - Data exfiltration (network egress gate)
 * - Accidental destructive operations (intent gate)
 * - Control flow integrity (env mutation gate)
 */

import { ExchangeRule } from "../exchange.ts";

export const defaultRules: ExchangeRule[] = [
  // ========================================================================
  // Rule 1: Exec Integrity Gate
  // ========================================================================
  // Prevents prompt injection by requiring high integrity for executed code.
  // Downloaded or LLM-generated content cannot be executed without endorsement.
  {
    name: "exec-integrity-gate",
    match: {
      commands: ["bash", "sh", "eval", "source", "python", "node"],
    },
    requires: {
      integrity: [
        { kind: "UserInput" },
        { kind: "EndorsedBy" },  // matches any EndorsedBy regardless of principal
        { kind: "CodeHash" },     // matches any CodeHash regardless of hash value
      ],
    },
    onViolation: "block",
    description: "Executable code must have UserInput, EndorsedBy, or CodeHash integrity to prevent prompt injection attacks",
    priority: 10,
  },

  // ========================================================================
  // Rule 2: Network Egress Confidentiality Gate
  // ========================================================================
  // Prevents data exfiltration by blocking confidential data from leaving.
  // Data must be public (empty confidentiality) to be sent over network.
  {
    name: "network-egress-confidentiality-gate",
    match: {
      category: "network-egress",
    },
    requires: {
      publicOnly: true,
    },
    onViolation: "block",
    description: "Confidential data (with Space or PersonalSpace labels) cannot be sent over the network",
    priority: 20,
  },

  // ========================================================================
  // Rule 3: Destructive Write Intent Gate
  // ========================================================================
  // Prevents accidental data loss by requiring explicit user approval.
  // Any rm operation must be approved via IntentOnce.
  {
    name: "destructive-write-intent-gate",
    match: {
      commands: ["rm"],
    },
    requires: {
      // No specific requirements - we always ask for intent on rm
      // The evaluator will request intent before proceeding
    },
    onViolation: "request-intent",
    description: "Destructive file operations require explicit user approval",
    priority: 30,
  },

  // ========================================================================
  // Rule 4: Environment Mutation Gate
  // ========================================================================
  // Prevents privilege escalation via environment variable manipulation.
  // PC must have UserInput integrity to modify PATH, HOME, LD_*, etc.
  {
    name: "env-mutation-gate",
    match: {
      category: "env-mutation",
    },
    requires: {
      pcIntegrity: [
        { kind: "UserInput" },
      ],
    },
    onViolation: "block",
    description: "Environment variables cannot be modified from tainted control flow (PC must have UserInput integrity)",
    priority: 40,
  },

  // ========================================================================
  // Rule 5: LLM Prompt Data Framing (FUTURE)
  // ========================================================================
  // This is a future rule showing how to handle untrusted data in LLM prompts.
  // When enabled, it would automatically wrap untrusted content in a frame
  // that instructs the LLM to treat it as data, not instructions.
  /*
  {
    name: "llm-prompt-data-framing",
    match: {
      category: "network-egress",
      // Would need additional context to identify LLM API endpoints
      // Could match on specific hostnames: api.openai.com, api.anthropic.com, etc.
    },
    requires: {
      integrity: [
        { kind: "UserInput" },
        { kind: "EndorsedBy" },
      ],
    },
    onViolation: "sandbox",  // Auto-wrap untrusted data
    description: "Untrusted data flowing into LLM prompts must be wrapped in an untrusted content frame",
    priority: 15,
  },
  */
];
