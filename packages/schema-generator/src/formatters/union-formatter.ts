import ts from "typescript";
import type {
  GenerationContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import {
  cloneSchemaDefinition,
  getNativeTypeSchema,
  TypeWithInternals,
} from "../type-utils.ts";

export class UnionFormatter implements TypeFormatter {
  constructor(private schemaGenerator: SchemaGenerator) {}

  supportsType(type: ts.Type, context: GenerationContext): boolean {
    return (type.flags & ts.TypeFlags.Union) !== 0;
  }

  formatType(type: ts.Type, context: GenerationContext): SchemaDefinition {
    const union = type as ts.UnionType;
    const members = union.types ?? [];

    if (members.length === 0) {
      throw new Error("UnionFormatter received empty union type");
    }

    // Filter out undefined from unions; schema handles optionality via required array
    const filtered = members.filter((m) =>
      (m.flags & ts.TypeFlags.Undefined) === 0
    );

    // Detect presence of null
    const hasNull = filtered.some((m) => (m.flags & ts.TypeFlags.Null) !== 0);
    const nonNull = filtered.filter((m) => (m.flags & ts.TypeFlags.Null) === 0);

    const generate = (t: ts.Type, typeNode?: ts.TypeNode): SchemaDefinition => {
      const native = getNativeTypeSchema(t, context.typeChecker);
      if (native !== undefined) {
        return cloneSchemaDefinition(native);
      }
      return this.schemaGenerator.formatChildType(t, context, typeNode);
    };

    // Case: exactly one non-null member + null => anyOf (nullable type)
    // Note: We use anyOf instead of oneOf for better consumer compatibility.
    // For nullable types (T | null), both work identically since a value is either
    // null OR the other type, never both. anyOf is more easily supported.
    if (hasNull && nonNull.length === 1) {
      const item = generate(nonNull[0]!);
      return { anyOf: [item, { type: "null" }] };
    }

    // Case: all members are string/number/boolean literals -> enum
    const allLiteral = nonNull.length > 0 &&
      nonNull.every((m) =>
        (m.flags & ts.TypeFlags.StringLiteral) !== 0 ||
        (m.flags & ts.TypeFlags.NumberLiteral) !== 0 ||
        (m.flags & ts.TypeFlags.BooleanLiteral) !== 0
      );

    if (allLiteral) {
      const values = nonNull.map((m) => {
        if (m.flags & ts.TypeFlags.StringLiteral) {
          return (m as ts.StringLiteralType).value;
        }
        if (m.flags & ts.TypeFlags.NumberLiteral) {
          return (m as ts.NumberLiteralType).value;
        }
        if (m.flags & ts.TypeFlags.BooleanLiteral) {
          return (m as TypeWithInternals).intrinsicName === "true";
        }
        return undefined;
      }).filter((v) => v !== undefined);

      // Special case: union of both boolean literals {true, false} becomes type: "boolean"
      const boolValues = values.filter((v) => typeof v === "boolean");
      const nonBoolValues = values.filter((v) => typeof v !== "boolean");

      if (boolValues.length === 2 && nonBoolValues.length === 0) {
        // Union of true | false becomes regular boolean type
        return { type: "boolean" };
      }

      return { enum: values };
    }

    // Fallback: anyOf of member schemas (excluding null/undefined handled above)
    const anyOf = nonNull.map((m) => generate(m));
    if (hasNull) anyOf.push({ type: "null" });
    return { anyOf };
  }
}
