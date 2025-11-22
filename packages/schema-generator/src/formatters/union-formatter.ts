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
import { isRecord } from "@commontools/utils/types";

export class UnionFormatter implements TypeFormatter {
  constructor(private schemaGenerator: SchemaGenerator) {}

  supportsType(type: ts.Type, _context: GenerationContext): boolean {
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

    // Case: all non-null members are string/number/boolean literals -> enum
    // Include null in the enum if present (unlike undefined which is handled via required array)
    const allLiteral = nonNull.length > 0 &&
      nonNull.every((m) =>
        (m.flags & ts.TypeFlags.StringLiteral) !== 0 ||
        (m.flags & ts.TypeFlags.NumberLiteral) !== 0 ||
        (m.flags & ts.TypeFlags.BooleanLiteral) !== 0
      );

    if (allLiteral) {
      const values: Array<string | number | boolean | null> = nonNull.map(
        (m) => {
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
        },
      ).filter((v) => v !== undefined) as Array<string | number | boolean>;

      // Special case: union of both boolean literals {true, false} becomes type: "boolean"
      const boolValues = values.filter((v) => typeof v === "boolean");
      const nonBoolValues = values.filter((v) => typeof v !== "boolean");

      if (boolValues.length === 2 && nonBoolValues.length === 0) {
        // Union of true | false becomes regular boolean type
        return { type: "boolean" };
      }

      // Include null in enum values if present (null can be a runtime value, unlike undefined)
      if (hasNull) {
        values.push(null);
      }

      return { enum: values };
    }

    // Fallback: anyOf of member schemas (excluding null/undefined handled above)
    let anyOf = nonNull.map((m) => generate(m));
    if (hasNull) anyOf.push({ type: "null" });

    // When widenLiterals is true, try to merge structurally identical schemas
    // that only differ in literal enum values
    if (context.widenLiterals && anyOf.length > 1) {
      anyOf = this.mergeIdenticalSchemas(anyOf);
    }

    // If only one schema remains after filtering/merging, return it directly without anyOf wrapper
    if (anyOf.length === 1) {
      return anyOf[0]!;
    }

    return { anyOf };
  }

  /**
   * Merge schemas that are structurally identical except for literal enum values.
   * Used when widenLiterals is true to collapse unions like
   * {x: {enum: [10]}} | {x: {enum: [20]}} into {x: {type: "number"}}
   */
  private mergeIdenticalSchemas(
    schemas: SchemaDefinition[],
  ): SchemaDefinition[] {
    if (schemas.length <= 1) return schemas;

    // Group schemas by their structure (ignoring enum values)
    const groups = new Map<string, SchemaDefinition[]>();

    for (const schema of schemas) {
      const normalized = this.normalizeSchemaForComparison(schema);
      const key = JSON.stringify(normalized);
      const group = groups.get(key) ?? [];
      group.push(schema);
      groups.set(key, group);
    }

    // For each group with multiple schemas, try to merge them
    const result: SchemaDefinition[] = [];
    for (const group of groups.values()) {
      if (group.length === 1) {
        result.push(group[0]!);
      } else {
        // Multiple schemas with same structure - merge them
        result.push(this.mergeSchemaGroup(group));
      }
    }

    return result;
  }

  /**
   * Normalize a schema for structural comparison by removing enum values
   * and converting them to base types
   */
  private normalizeSchemaForComparison(
    schema: SchemaDefinition,
  ): Record<string, unknown> {
    if (typeof schema === "boolean") return { _bool: schema };

    const result: Record<string, unknown> = {};

    // Convert enum to base type for comparison
    if ("enum" in schema && schema.enum) {
      const firstValue = schema.enum[0];
      if (typeof firstValue === "string") {
        result.type = "string";
      } else if (typeof firstValue === "number") {
        result.type = "number";
      } else if (typeof firstValue === "boolean") {
        result.type = "boolean";
      }
    } else if ("type" in schema) {
      result.type = schema.type;
    }

    // Recursively normalize properties
    if ("properties" in schema && isRecord(schema.properties)) {
      const props: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        props[key] = this.normalizeSchemaForComparison(value as SchemaDefinition);
      }
      result.properties = props;
    }

    // Recursively normalize items
    if ("items" in schema && schema.items) {
      result.items = this.normalizeSchemaForComparison(
        schema.items as SchemaDefinition,
      );
    }

    // Copy other structural fields
    if ("required" in schema) result.required = schema.required;
    if ("additionalProperties" in schema) {
      result.additionalProperties = schema.additionalProperties;
    }

    return result;
  }

  /**
   * Merge a group of structurally identical schemas by widening their enums
   */
  private mergeSchemaGroup(schemas: SchemaDefinition[]): SchemaDefinition {
    if (schemas.length === 0) {
      throw new Error("Cannot merge empty schema group");
    }

    const first = schemas[0]!;
    if (typeof first === "boolean") return first;

    const result: SchemaDefinition = {};

    // Handle enum -> base type conversion
    if ("enum" in first && first.enum) {
      const firstValue = first.enum[0];
      if (typeof firstValue === "string") {
        result.type = "string";
      } else if (typeof firstValue === "number") {
        result.type = "number";
      } else if (typeof firstValue === "boolean") {
        result.type = "boolean";
      }
    } else if ("type" in first) {
      result.type = first.type;
    }

    // Recursively merge properties
    if ("properties" in first && isRecord(first.properties)) {
      const props: Record<string, SchemaDefinition> = {};
      for (const key of Object.keys(first.properties)) {
        const propSchemas = schemas
          .map((s) =>
            isRecord(s) && isRecord(s.properties) ? s.properties[key] : undefined
          )
          .filter((p): p is SchemaDefinition => p !== undefined);

        if (propSchemas.length > 0) {
          props[key] = this.mergeSchemaGroup(propSchemas);
        }
      }
      result.properties = props;
    }

    // Recursively merge items
    if ("items" in first && first.items) {
      const itemSchemas = schemas
        .map((s) =>
          isRecord(s) && "items" in s && s.items ? s.items : undefined
        )
        .filter((i): i is SchemaDefinition => i !== undefined);

      if (itemSchemas.length > 0) {
        result.items = this.mergeSchemaGroup(itemSchemas);
      }
    }

    // Copy other structural fields from first schema
    if ("required" in first) result.required = first.required;
    if ("additionalProperties" in first) {
      result.additionalProperties = first.additionalProperties;
    }

    return result;
  }
}
