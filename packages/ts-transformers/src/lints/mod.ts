import type ts from "typescript";
import type { DiagnosticSeverity, TransformationContext } from "../core/mod.ts";
import {
  FOREIGN_OUTPUT_EMBEDDING_DIAGNOSTIC,
  foreignOutputEmbeddingLint,
} from "./foreign-output-embedding.ts";

/**
 * Contract lints: read-only, program-scoped analyses of the cross-pattern
 * relationships a compile can see.
 *
 * A lint is none of the things a transformer is. It rewrites nothing, its
 * subject is a design rule rather than compiler correctness, and it may
 * look across the whole program instead of at one node. It rides the
 * pipeline anyway because this is where the resolved contract types
 * already are, and because the compile is the one tool every pattern
 * author touches — the rules have to reach authors who will never read
 * them.
 *
 * Three boundaries keep the category honest:
 *
 * - A lint receives the pattern call and its resolved contract types and
 *   emits findings. It never mutates the tree and never changes emission.
 * - Severity is policy, not detection: findings map to severity in
 *   {@link FINDING_SEVERITY}, so an advisory can later become a lint error
 *   without touching a detector.
 * - Hard enforcement never lives in the compiler. When a rule graduates
 *   from advisory, the failure belongs to the CI gates that already
 *   collect these diagnostics from the compiles they run — the same tier
 *   as the update gate, which refuses at deploy, not at compile.
 */

export interface ContractLintInput {
  readonly context: TransformationContext;
  readonly callNode: ts.CallExpression;
  readonly inputType: ts.Type | undefined;
  readonly inputTypeNode: ts.TypeNode;
  readonly resultType: ts.Type | undefined;
  readonly resultTypeNode: ts.TypeNode;
}

export interface ContractLintFinding {
  /** Diagnostic type id, e.g. `contract:foreign-output-embedding`. */
  readonly type: string;
  readonly message: string;
  /** Anchor for the diagnostic range. */
  readonly node: ts.Node;
}

/** A contract lint: pure detection, findings out, no mutation. */
export type ContractLint = (input: ContractLintInput) => ContractLintFinding[];

/**
 * Findings map to severity here, not in the lints. Absent entries default
 * to "warning": a new lint is advisory until policy says otherwise.
 */
const FINDING_SEVERITY: Readonly<Record<string, DiagnosticSeverity>> = {
  [FOREIGN_OUTPUT_EMBEDDING_DIAGNOSTIC]: "warning",
};

const CONTRACT_LINTS: readonly ContractLint[] = [
  foreignOutputEmbeddingLint,
];

/**
 * The pipeline's single hook: schema injection calls this once per pattern
 * call, after contract resolution. New lints register in
 * {@link CONTRACT_LINTS}; the caller never changes.
 */
export function runContractLints(input: ContractLintInput): void {
  for (const lint of CONTRACT_LINTS) {
    for (const finding of lint(input)) {
      input.context.reportDiagnosticOnce({
        severity: FINDING_SEVERITY[finding.type] ?? "warning",
        type: finding.type,
        message: finding.message,
        node: finding.node,
      });
    }
  }
}

export {
  FOREIGN_OUTPUT_EMBEDDING_DIAGNOSTIC,
} from "./foreign-output-embedding.ts";
