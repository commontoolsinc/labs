import ts from "typescript";
import type {
  GenerationContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import { TypeWithInternals } from "../type-utils.ts";

/**
 * Formatter for primitive TypeScript types
 */
export class PrimitiveFormatter implements TypeFormatter {
  supportsType(type: ts.Type, context: GenerationContext): boolean {
    const flags = type.flags;

    return (flags & ts.TypeFlags.String) !== 0 ||
      (flags & ts.TypeFlags.Number) !== 0 ||
      (flags & ts.TypeFlags.Boolean) !== 0 ||
      (flags & ts.TypeFlags.BooleanLiteral) !== 0 ||
      (flags & ts.TypeFlags.StringLiteral) !== 0 ||
      (flags & ts.TypeFlags.NumberLiteral) !== 0 ||
      (flags & ts.TypeFlags.Null) !== 0 ||
      (flags & ts.TypeFlags.Undefined) !== 0 ||
      (flags & ts.TypeFlags.Void) !== 0 ||
      (flags & ts.TypeFlags.Never) !== 0 ||
      (flags & ts.TypeFlags.Unknown) !== 0 ||
      (flags & ts.TypeFlags.Any) !== 0;
  }

  formatType(type: ts.Type, context: GenerationContext): SchemaDefinition {
    const flags = type.flags;

    // Handle literal types first (more specific)
    if (flags & ts.TypeFlags.StringLiteral) {
      return {
        type: "string",
        enum: [(type as ts.StringLiteralType).value],
      };
    }
    if (flags & ts.TypeFlags.NumberLiteral) {
      return {
        type: "number",
        enum: [(type as ts.NumberLiteralType).value],
      };
    }
    if (flags & ts.TypeFlags.BooleanLiteral) {
      return {
        type: "boolean",
        enum: [(type as TypeWithInternals).intrinsicName === "true"],
      };
    }

    // Handle general primitive types
    if (flags & ts.TypeFlags.String) {
      return { type: "string" };
    }
    if (flags & ts.TypeFlags.Number) {
      return { type: "number" };
    }
    if (flags & ts.TypeFlags.Boolean) {
      return { type: "boolean" };
    }
    if (flags & ts.TypeFlags.Null) {
      return { type: "null" };
    }
    if (flags & ts.TypeFlags.Undefined) {
      // undefined cannot occur in JSON - return {} which matches anything
      return {};
    }
    if (flags & ts.TypeFlags.Void) {
      // void cannot occur in JSON - return {} which matches anything  
      return {};
    }
    if (flags & ts.TypeFlags.Never) {
      // never cannot occur in JSON - return {} which matches anything
      return {};
    }
    if ((flags & ts.TypeFlags.Unknown) || (flags & ts.TypeFlags.Any)) {
      // unknown/any can be any JSON value (primitive or object) - {} matches everything
      return {};
    }

    // Fallback
    return { type: "string", enum: ["unknown"] };
  }
}
