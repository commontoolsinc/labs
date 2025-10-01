import ts from "typescript";

export type Transformer = ts.TransformerFactory<ts.SourceFile>;

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
