import ts from "typescript";
import type {
  FormatterContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";

export class IntersectionFormatter implements TypeFormatter {
  constructor(private schemaGenerator?: { generateSchema: Function }) {}

  supportsType(type: ts.Type): boolean {
    return (type.flags & ts.TypeFlags.Intersection) !== 0;
  }

  formatType(type: ts.Type, context: FormatterContext): SchemaDefinition {
    const inter = type as ts.IntersectionType;
    const parts = inter.types ?? [] as ts.Type[];
    const generate = (t: ts.Type): SchemaDefinition =>
      this.schemaGenerator
        ? (this.schemaGenerator as any).generateSchema(t, context.typeChecker)
        : { type: "object", additionalProperties: true };

    // Default: allOf of member schemas
    const allOf = parts.map((p) => generate(p));
    return { allOf } as unknown as SchemaDefinition;
  }
}
