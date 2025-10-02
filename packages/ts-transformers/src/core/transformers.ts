import ts from "typescript";
import { TransformationContext } from "./mod.ts";

export type TransformMode = "transform" | "error";

export interface TransformationOptions {
  readonly mode?: TransformMode;
  readonly debug?: boolean;
  readonly logger?: (message: string) => void;
  readonly typeRegistry?: TypeRegistry;
}

export interface TransformationDiagnostic {
  readonly type: string;
  readonly message: string;
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
}

export interface DiagnosticInput {
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
        transformation,
        options: this.#options,
      });

      if (!this.filter(context)) {
        return sourceFile;
      }

      const transformed = this.transform(context);

      if (
        context.options.mode === "error" &&
        context.diagnostics.length > 0
      ) {
        const message = context.diagnostics
          .map((diagnostic) =>
            `${diagnostic.fileName}:${diagnostic.line}:${diagnostic.column} - ${diagnostic.message}`
          )
          .join("\n");
        throw new Error(`OpaqueRef transformation errors:\n${message}`);
      }
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
