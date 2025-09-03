import ts from "typescript";
import type {
  FormatterContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";

/**
 * Formatter for primitive TypeScript types
 */
export class PrimitiveFormatter implements TypeFormatter {
  supportsType(type: ts.Type, context: FormatterContext): boolean {
    // Handle primitive types (safely check for methods that might not exist on mock types)
    try {
      if ((type as any).isStringLiteral && (type as any).isStringLiteral()) {
        return true;
      }
      if ((type as any).isNumberLiteral && (type as any).isNumberLiteral()) {
        return true;
      }
    } catch (_) {
      // Ignore errors from mock types
    }

    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return true;
    }

    // Handle primitive type references
    const flags = type.flags;
    const supports = (flags & ts.TypeFlags.String) !== 0 ||
      (flags & ts.TypeFlags.Number) !== 0 ||
      (flags & ts.TypeFlags.Boolean) !== 0 ||
      (flags & ts.TypeFlags.Null) !== 0 ||
      (flags & ts.TypeFlags.Undefined) !== 0 ||
      (flags & ts.TypeFlags.Void) !== 0 ||
      (flags & ts.TypeFlags.Never) !== 0 ||
      (flags & ts.TypeFlags.Unknown) !== 0 ||
      (flags & ts.TypeFlags.Any) !== 0;
    return supports;
  }

  formatType(type: ts.Type, context: FormatterContext): SchemaDefinition {
    const flags = type.flags;

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
      return { type: "string", enum: ["undefined"] };
    }
    if (flags & ts.TypeFlags.Void) {
      return { type: "string", enum: ["void"] };
    }
    if (flags & ts.TypeFlags.Never) {
      return { type: "string", enum: ["never"] };
    }
    if ((flags & ts.TypeFlags.Unknown) || (flags & ts.TypeFlags.Any)) {
      return { type: "object", additionalProperties: true };
    }

    // Handle literal types (safely check for methods that might not exist on mock types)
    try {
      if ((type as any).isStringLiteral && (type as any).isStringLiteral()) {
        return { type: "string", enum: [(type as any).value] };
      }
      if ((type as any).isNumberLiteral && (type as any).isNumberLiteral()) {
        return { type: "number", enum: [(type as any).value] };
      }
    } catch (_) {
      // Ignore errors from mock types
    }
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      // For boolean literals, we need to check if it's true or false
      // This is a simplified approach - in practice we'd need more context
      return { type: "boolean" };
    }

    // Fallback
    return { type: "string", enum: ["unknown"] };
  }
}
