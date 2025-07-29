/**
 * Base options for all transformers
 */
export interface TransformerOptions {
  // Currently no shared options
}

/**
 * Transformation types for type safety and consistency
 */
export const TRANSFORMATION_TYPES = {
  OPAQUE_REF: {
    TERNARY: "ternary-to-ifelse",
    JSX_EXPRESSION: "jsx-expression-wrap",
    BINARY_EXPRESSION: "binary-to-derive",
    METHOD_CALL: "method-call",
    PROPERTY_ACCESS: "property-access",
    TEMPLATE_LITERAL: "template-literal",
    OBJECT_SPREAD: "object-spread",
    ELEMENT_ACCESS: "element-access",
    FUNCTION_CALL: "function-call",
  },
  SCHEMA: {
    TO_SCHEMA_CALL: "to-schema-call",
    HANDLER_TYPE_ARGS: "handler-type-args",
    RECIPE_TYPE_ARGS: "recipe-type-args",
    TYPE_CONVERSION: "type-conversion",
  },
} as const;

export type TransformationType =
  | typeof TRANSFORMATION_TYPES.OPAQUE_REF[
    keyof typeof TRANSFORMATION_TYPES.OPAQUE_REF
  ]
  | typeof TRANSFORMATION_TYPES.SCHEMA[
    keyof typeof TRANSFORMATION_TYPES.SCHEMA
  ];
