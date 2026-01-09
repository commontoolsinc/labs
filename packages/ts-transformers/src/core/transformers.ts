import ts from "typescript";
import { TransformationContext } from "./mod.ts";

export type TransformMode = "transform" | "error";

/**
 * Hints for schema generation that override default behavior.
 * Used to communicate access patterns (like array-property-only access)
 * from capture analysis to schema generation.
 */
export interface SchemaHint {
  /** Override for array items schema (e.g., false for items: false) */
  readonly items?: unknown;
}

/**
 * Registry for passing schema hints between transformer stages.
 * Keyed by TypeNode (unique per usage) to avoid conflicts when the same
 * Type is used in multiple places with different access patterns.
 */
export type SchemaHints = WeakMap<ts.Node, SchemaHint>;

export interface TransformationOptions {
  readonly mode?: TransformMode;
  readonly debug?: boolean;
  readonly logger?: (message: string) => void;
  readonly typeRegistry?: TypeRegistry;
  readonly mapCallbackRegistry?: WeakSet<ts.Node>;
  readonly schemaHints?: SchemaHints;
  /**
   * Shared diagnostics collector that accumulates diagnostics across all transformers.
   * If provided, diagnostics are pushed to this array in addition to the local context.
   */
  readonly diagnosticsCollector?: TransformationDiagnostic[];
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
 * When schema-injection creates synthetic TypeNodes, the original Type
 * may not survive round-tripping through checker.getTypeFromTypeNode().
 * This registry allows us to pass the original Type directly to the
 * schema-transformer stage.
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

export class Pipeline {
  #transformers: Transformer[];
  constructor(transformers: Transformer[]) {
    this.#transformers = transformers;
  }

  toFactories(program: ts.Program): ts.TransformerFactory<ts.SourceFile>[] {
    return this.#transformers.map((t) => t.toFactory(program));
  }
}
