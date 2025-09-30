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
      // undefined: return true to indicate "accept any value"
      // undefined is handled at runtime/compile time, not by JSON schema validation
      return true;
    }
    if (flags & ts.TypeFlags.Void) {
      // void: return true to indicate "accept any value"
      // void functions don't return meaningful values, so schema validation is permissive
      return true;
    }
    if (flags & ts.TypeFlags.Never) {
      // never: return false to reject all values
      // never means this type can never occur, so no value should validate
      return false;
    }
    if (flags & ts.TypeFlags.Any) {
      // any: return true to indicate "allow any value"
      return true;
    }
    if (flags & ts.TypeFlags.Unknown) {
      // unknown: return true to indicate "accept any value"
      // Type safety is enforced at compile time via TypeScript narrowing
      return true;
    }

    // Fallback
    return { type: "string", enum: ["unknown"] };
  }
}
