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
import { isObject, isRecord } from "@commontools/utils/types";

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

    // Detect presence of null
    const hasNull = members.some((m) => (m.flags & ts.TypeFlags.Null) !== 0);
    const nonNull = members.filter((m) => (m.flags & ts.TypeFlags.Null) === 0);

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
    let unionOptions = members.map((m) => generate(m));
    // When widenLiterals is true, try to merge structurally identical schemas
    // that only differ in literal enum values
    if (context.widenLiterals && unionOptions.length > 1) {
      unionOptions = this.mergeIdenticalSchemas(unionOptions);
    }
    let unionSchema: SchemaDefinition & { anyOf: SchemaDefinition[] } = {
      anyOf: [],
    };
    for (const option of unionOptions) {
      console.log("merging", option, unionSchema);
      const merged = this.mergePrimitiveSchemaToAnyOf(
        unionSchema.anyOf,
        option,
      );
      if (merged === true) {
        return true;
      }
      unionSchema = merged;
      console.log("merged", option, unionSchema);
    }

    // If only one schema remains after filtering/merging, return it directly without anyOf wrapper
    if (unionSchema.anyOf.length === 1) {
      return unionSchema.anyOf[0]!;
    }

    return unionSchema;
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
   * Add a new schema option that is either boolean, or has only a `type`
   * field and possibly an `enum` field.
   *
   * This is used to merge multiple primitive types into a single schema definition.
   */
  // private mergePrimitiveSchemaOption(
  //   acc: SchemaDefinition,
  //   cur: SchemaDefinition,
  // ): SchemaDefinition {
  //   if (cur === true || acc === true) {
  //     return true;
  //   } else if (cur == false) {
  //     return acc;
  //   } else if (acc === false) {
  //     return cur;
  //   } else if (acc.anyOf !== undefined) {
  //     // If we're not already in the anyOf list, add this new option there
  //     const curStr = JSON.stringify(cur);
  //     if (!(acc.anyOf.some((option) => JSON.stringify(option) === curStr))) {
  //       // See if we can merge into one of the anyOf options
  //       const allPrimitive = acc.anyOf.every((schema) =>
  //         typeof schema === "boolean" ||
  //         primitiveSchemaKeys.isSupersetOf(new Set(Object.keys(schema)))
  //       );
  //       acc.anyOf.push(cur);
  //     }
  //     return acc;
  //   } else if (acc.type === cur.type && acc.type !== undefined) {
  //     if (acc.enum !== undefined || cur.enum !== undefined) {
  //       const merged = new Set([...(acc.enum ?? []), ...(cur.enum ?? [])]);
  //       return { type: acc.type, enum: [...merged] };
  //     } else {
  //       return acc;
  //     }
  //   } else if (acc.enum === undefined && cur.enum === undefined) {
  //     const accTypes = Array.isArray(acc.type) ? acc.type : [acc.type!];
  //     const curTypes = Array.isArray(cur.type) ? cur.type : [cur.type!];
  //     const mergedSet = new Set([...accTypes, ...curTypes]);
  //     const merged = mergedSet.size === 1 ? [...mergedSet][0]! : [...mergedSet];
  //     return { type: merged };
  //   } else {
  //     // have to promote to anyOf
  //     return { anyOf: [acc, cur] };
  //   }
  // }

  private mergePrimitiveSchemaToAnyOf(
    anyOf: SchemaDefinition[],
    cur: SchemaDefinition,
  ): SchemaDefinition & { anyOf: SchemaDefinition[] } | true {
    if (cur === true) {
      return true;
    } else if (cur === false) {
      return { anyOf };
    }
    const curStr = JSON.stringify(cur);
    if ((anyOf.some((option) => JSON.stringify(option) === curStr))) {
      return { anyOf };
    }
    const primitiveSchemaKeys = new Set(["type", "enum"]);
    // See if we can merge into one of the anyOf options
    const primitiveSchemas = anyOf.filter((schema) =>
      typeof schema === "boolean" ||
      primitiveSchemaKeys.isSupersetOf(new Set(Object.keys(schema)))
    );
    const matchingType = primitiveSchemas.find((option) =>
      isObject(option) && "type" in option && option.type === cur.type
    );
    if (
      isRecord(cur) && Array.isArray(cur.enum) && isRecord(matchingType) &&
      Array.isArray(matchingType.enum)
    ) {
      // Add our enum values to their enum values, and keep the same type
      const mergedEnum = new Set([
        ...matchingType.enum,
        ...cur.enum,
      ]);
      // Special case for boolean with all options
      if (
        cur.type === "boolean" && mergedEnum.has(true) &&
        mergedEnum.has(false)
      ) {
        delete matchingType.enum;
        // this collapse may allow us to combine with other options that have only a type,
        // but I'm not doing that currently.
      } else {
        matchingType.enum = [...mergedEnum].toSorted();
      }
    } else if (isRecord(matchingType)) {
      // If either entry is missing an enum, we can have any value of that type, so clear enum
      delete matchingType.enum;
    } else if (cur.enum === undefined) {
      // If we have a non-enum, we can merge with any existing non-enum of any type
      const matchingNonEnum = primitiveSchemas.find((option) =>
        isRecord(option) && option.enum === undefined
      );
      if (isObject(matchingNonEnum)) {
        const curTypes = Array.isArray(cur.type) ? cur.type : [cur.type!];
        const matchingNonEnumTypes = Array.isArray(matchingNonEnum.type)
          ? matchingNonEnum.type
          : [matchingNonEnum.type!];
        matchingNonEnum.type = [
          ...new Set([...curTypes, ...matchingNonEnumTypes]),
        ].toSorted();
      } else {
        // no matching type to merge with, add as new anyOf option
        anyOf.push(cur);
      }
    } else {
      // no matching type to merge with, add as new anyOf option
      anyOf.push(cur);
    }
    return { anyOf };
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
        props[key] = this.normalizeSchemaForComparison(
          value as SchemaDefinition,
        );
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
            isRecord(s) && isRecord(s.properties)
              ? s.properties[key]
              : undefined
          )
          .filter((p): p is Exclude<SchemaDefinition, undefined> =>
            p !== undefined
          );

        if (propSchemas.length > 0) {
          props[key] = this.mergeSchemaGroup(propSchemas);
        }
      }
      result.properties = props;
    }

    // Recursively merge items
    if ("items" in first && first.items !== undefined) {
      const itemSchemas = schemas
        .map((s) =>
          isRecord(s) && "items" in s && s.items !== undefined
            ? s.items
            : undefined
        )
        .filter((i): i is Exclude<SchemaDefinition, undefined> =>
          i !== undefined
        );

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
