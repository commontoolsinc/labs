import ts from "typescript";
import { TransformationContext } from "./mod.ts";
import { CrossStageState } from "./cross-stage-state.ts";

export type TransformMode = "transform" | "error";

/**
 * Hints for schema generation that override default behavior.
 * Used to communicate access patterns (like array-property-only access)
 * from capture analysis to schema generation.
 */
export interface SchemaHint {
  /** Override for array items schema (e.g., false for items: false) */
  readonly items?: unknown;
  readonly cfcUiContract?: {
    readonly helper: "UiAction" | "UiPromptSlot" | "UiDisclosure";
    readonly action?: string;
    readonly surface?: string;
    readonly role?: string;
    readonly kind?: string;
    readonly trustedPattern?: string;
    readonly requiredEventIntegrity?: readonly string[];
  };
}

export type ReactiveCapability =
  | "opaque"
  | "comparable"
  | "readonly"
  | "writeonly"
  | "writable";

export interface CapabilityParamDefault {
  readonly path: readonly string[];
  readonly defaultType: ts.TypeNode;
}

export interface CapabilityParamSummary {
  readonly name: string;
  readonly capability: ReactiveCapability;
  readonly readPaths: readonly (readonly string[])[];
  readonly fullShapePaths?: readonly (readonly string[])[];
  readonly writePaths: readonly (readonly string[])[];
  readonly opaquePaths?: readonly (readonly string[])[];
  readonly passthrough: boolean;
  readonly wildcard: boolean;
  /**
   * Write-exhaustiveness is unverifiable for this parameter — `writePaths`
   * may be incomplete. Set by unrecognized or dynamic method calls on
   * cell-like receivers, and by `set`/`send` calls carrying an onCommit
   * callback. Treat like `wildcard` and fail closed. Detection is per
   * method-call dispatch: extracted method references
   * (`const f = cell.send; f(x)`) are outside the contract.
   */
  readonly hasUnverifiedCellUse?: boolean;
  readonly identityOnly?: boolean;
  readonly identityPaths?: readonly (readonly string[])[];
  readonly identityCellPaths?: readonly (readonly string[])[];
  readonly comparablePaths?: readonly (readonly string[])[];
  readonly comparableCellPaths?: readonly (readonly string[])[];
  readonly defaults?: readonly CapabilityParamDefault[];
}

/**
 * A cell argument that flows to an out-of-file parameter whose declared type the
 * capability contract cannot read (bare `Cell<T>`, a mixed union, an unbounded
 * generic, or a non-branded cell-like interface). The capability silently
 * degrades, so the caller surfaces this as a diagnostic.
 */
export interface UnreadableCellArgument {
  readonly node: ts.Node;
  readonly message: string;
}

export interface FunctionCapabilitySummary {
  readonly params: readonly CapabilityParamSummary[];
  /** True when analysis was short-circuited due to recursion. */
  readonly recursive?: boolean;
  /** Cell arguments passed to parameters the contract could not classify. */
  readonly unreadableCellArguments?: readonly UnreadableCellArgument[];
}

export type PatternCoverageKind = "runtime";

// Moved to runtime-contract.ts (typescript-free) so the runtime can import it
// without the compiler stack; re-exported here for the compile-side callers.
export { PATTERN_COVERAGE_GLOBAL } from "./runtime-contract.ts";

export interface PatternCoverageSpan {
  readonly fileName: string;
  readonly id: number;
  readonly kind: PatternCoverageKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

export interface PatternCoverageOptions {
  readonly fileName?: (sourceFileName: string) => string;
  readonly mapSpan?: (
    span: PatternCoverageSpan,
  ) => PatternCoverageSpan | undefined;
  readonly registerSpan: (span: PatternCoverageSpan) => void;
}

/**
 * Registry for passing schema hints between transformer stages.
 * Keyed by TypeNode (unique per usage) to avoid conflicts when the same
 * Type is used in multiple places with different access patterns.
 */
export type SchemaHints = WeakMap<ts.Node, SchemaHint>;
export type SyntheticReactiveCollectionRegistry = WeakSet<ts.Symbol>;

export interface TransformationOptions {
  readonly mode?: TransformMode;
  readonly debug?: boolean;
  readonly logger?: (message: string) => void;
  /**
   * Single owner of the pipeline's cross-transformer communication registries
   * (typeRegistry, schemaHints, the marker sets, etc.). Replaces the formerly
   * separate registry fields. See `CrossStageState`.
   */
  readonly state?: CrossStageState;
  /**
   * Shared diagnostics collector that accumulates diagnostics across all transformers.
   * If provided, diagnostics are pushed to this array in addition to the local context.
   */
  readonly diagnosticsCollector?: TransformationDiagnostic[];
  readonly patternCoverage?: PatternCoverageOptions;
}

export type DiagnosticSeverity = "error" | "warning";

export interface TransformationDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly type: string;
  readonly message: string;
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly length: number;
}

export interface DiagnosticInput {
  readonly severity?: DiagnosticSeverity;
  readonly type: string;
  readonly message: string;
  readonly node: ts.Node;
}

/**
 * Registry for passing Type information between transformer stages.
 *
 * The registry carries three related kinds of synthetic typing:
 * - replacement expression nodes that should keep the original authored type
 * - synthetic TypeNodes that later schema/codegen phases must resolve faithfully
 * - synthetic call expressions (`lift-applied`, `ifElse`, etc.) whose
 *   result types would otherwise be lost after rewriting
 *
 * Most TypeNodes are registered directly at creation time. For composite
 * synthetic TypeNodes that still collapse to unresolved `any` / `unknown`
 * through the public checker APIs, `ensureTypeNodeRegistered(...)` in
 * `ast/type-inference.ts` reconstructs and caches a Type on demand.
 *
 * Uses WeakMap with node identity as key. Node identity is preserved when
 * transformers are applied in sequence via ts.transform().
 */
export type TypeRegistry = WeakMap<ts.Node, ts.Type>;

export abstract class Transformer {
  #options: TransformationOptions;
  constructor(options: TransformationOptions) {
    this.#options = options;
  }

  abstract transform(context: TransformationContext): ts.SourceFile;

  // Receives a TransformationContext, returning a boolean indicating
  // whether a transformation should run for this source file.
  // If not provided, always returns true.
  filter(_context: TransformationContext): boolean {
    return true;
  }

  toFactory(
    program: ts.Program,
  ): ts.TransformerFactory<ts.SourceFile> {
    return (transformation: ts.TransformationContext) =>
    (sourceFile: ts.SourceFile) => {
      const context = new TransformationContext({
        program,
        sourceFile,
        tsContext: transformation,
        options: this.#options,
      });

      if (!this.filter(context)) {
        return sourceFile;
      }

      const transformed = this.transform(context);

      return transformed;
    };
  }
}

export abstract class HelpersOnlyTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.cfHelpers.sourceHasHelpers();
  }
}

export class Pipeline {
  #transformers: Transformer[];
  constructor(transformers: Transformer[]) {
    this.#transformers = transformers;
  }

  toFactories(program: ts.Program): ts.TransformerFactory<ts.SourceFile>[] {
    return this.#transformers.map((t) => t.toFactory(program));
  }
}
