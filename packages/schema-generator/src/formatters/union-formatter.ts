import ts from "typescript";
import type {
  FormatterContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";

export class UnionFormatter implements TypeFormatter {
  constructor(private schemaGenerator?: { generateSchema: Function }) {}

  supportsType(type: ts.Type): boolean {
    return (type.flags & ts.TypeFlags.Union) !== 0;
  }

  formatType(type: ts.Type, context: FormatterContext): SchemaDefinition {
    const union = type as ts.UnionType;
    const members = union.types ?? [] as ts.Type[];

    // Filter out undefined from unions; schema handles optionality via required array
    const filtered = members.filter((m) =>
      (m.flags & ts.TypeFlags.Undefined) === 0
    );

    // Detect presence of null
    const hasNull = filtered.some((m) => (m.flags & ts.TypeFlags.Null) !== 0);
    const nonNull = filtered.filter((m) => (m.flags & ts.TypeFlags.Null) === 0);

    const generate = (t: ts.Type): SchemaDefinition =>
      this.schemaGenerator
        ? (this.schemaGenerator as any).generateSchema(t, context.typeChecker)
        : { type: "object", additionalProperties: true };

    // Case: exactly one non-null member + null => oneOf
    if (hasNull && nonNull.length === 1) {
      const item = generate(nonNull[0]!);
      return { oneOf: [item, { type: "null" }] } as unknown as SchemaDefinition;
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
          return (m as any).intrinsicName === "true";
        }
        return undefined;
      }).filter((v) => v !== undefined);
      // Special-case boolean union {true,false} => type: "boolean"
      const boolSet = new Set(values.filter((v) => typeof v === "boolean"));
      const nonBoolCount = values.filter((v) => typeof v !== "boolean").length;
      if (boolSet.size === 2 && nonBoolCount === 0) {
        return { type: "boolean" } as unknown as SchemaDefinition;
      }
      return { enum: values as any[] } as unknown as SchemaDefinition;
    }

    // Fallback: anyOf of member schemas (excluding null/undefined handled above)
    const anyOf = nonNull.map((m) => generate(m));
    if (hasNull) anyOf.push({ type: "null" });
    return { anyOf } as unknown as SchemaDefinition;
  }
}
