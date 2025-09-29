import ts from "typescript";

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
export class TypeRegistry {
  private types = new WeakMap<ts.Node, ts.Type>();

  /**
   * Store a Type for a given AST node (typically a toSchema call expression)
   */
  set(node: ts.Node, type: ts.Type): void {
    this.types.set(node, type);
  }

  /**
   * Retrieve the Type stored for a given AST node
   */
  get(node: ts.Node): ts.Type | undefined {
    return this.types.get(node);
  }

  /**
   * Check if a Type is stored for a given node
   */
  has(node: ts.Node): boolean {
    return this.types.has(node);
  }
}
