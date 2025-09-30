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
export type TypeRegistry = WeakMap<ts.Node, ts.Type>;
