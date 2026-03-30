import ts from "typescript";
import type {
  JSONSchemaMutable,
  JSONSchemaObjMutable,
} from "@commonfabric/api";
import type { GenerationContext, TypeFormatter } from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import {
  cloneSchemaDefinition,
  getNativeTypeSchema,
  TypeWithInternals,
} from "../type-utils.ts";
import { isRecord } from "@commonfabric/utils/types";

// Simple primitive schemas only have these keys (possibly just one)
const PRIMITIVE_SCHEMA_KEY_SET = new Set(["type", "enum"]);

export class UnionFormatter implements TypeFormatter {
  constructor(private schemaGenerator: SchemaGenerator) {}

  supportsType(type: ts.Type, _context: GenerationContext): boolean {
    return (type.flags & ts.TypeFlags.Union) !== 0;
  }

  formatType(
    type: ts.Type,
    context: GenerationContext,
  ): JSONSchemaMutable {
    const union = type as ts.UnionType;
    const members = union.types ?? [];

    if (members.length === 0) {
      throw new Error("UnionFormatter received empty union type");
    }

    // Detect presence of null
    const hasNull = members.some((m) => (m.flags & ts.TypeFlags.Null) !== 0);
    // nonNull excludes only null; undefined members are kept because undefined is
    // now represented explicitly as { type: "undefined" } rather than being stripped.
    const nonNull = members.filter((m) => (m.flags & ts.TypeFlags.Null) === 0);

    const generate = (
      t: ts.Type,
      typeNode?: ts.TypeNode,
    ): JSONSchemaMutable => {
      const native = getNativeTypeSchema(t, context.typeChecker);
      if (native !== undefined) {
        return cloneSchemaDefinition(native);
      }
      return this.schemaGenerator.formatChildType(t, context, typeNode);
    };

    // Case: exactly one non-null member + null => anyOf (nullable type).
    // Note: We use anyOf instead of oneOf for better consumer compatibility.
    // For nullable types (T | null), both work identically since a value is either
    // null OR the other type, never both. anyOf is more easily supported.
    // Note: if undefined is also present (T | null | undefined), nonNull.length > 1,
    // so we fall through to the anyOf path which emits { type: "undefined" } explicitly.
    if (hasNull && nonNull.length === 1) {
      const item = generate(nonNull[0]!);
      return { anyOf: [item, { type: "null" }] };
    }

    // Case: all non-null members are literals -> enum.
    // Note: undefined prevents this path since it doesn't match any literal flag,
    // intentionally falling through to the anyOf path which emits { type: "undefined" }.
    // Include null in the enum if present (null is a runtime value; undefined is
    // represented as a separate { type: "undefined" } schema member instead).
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
    const anyOf: JSONSchemaObjMutable[] = [];
    for (const option of unionOptions) {
      // mergePrimitiveSchemaIntoAnyOf mutates anyOf in place; returns true to short-circuit
      if (this.mergePrimitiveSchemaIntoAnyOf(anyOf, option)) {
        return true;
      }
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
    schemas: JSONSchemaMutable[],
  ): JSONSchemaMutable[] {
    if (schemas.length <= 1) return schemas;

    // Group schemas by their structure (ignoring enum values)
    const groups = new Map<string, JSONSchemaMutable[]>();

    for (const schema of schemas) {
      const normalized = this.normalizeSchemaForComparison(schema);
      const key = JSON.stringify(normalized);
      const group = groups.get(key) ?? [];
      group.push(schema);
      groups.set(key, group);
    }

    // For each group with multiple schemas, try to merge them
    const result: JSONSchemaMutable[] = [];
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
   * Merge `cur` into the `anyOf` accumulator array in place.
   * Returns true if the result is the permissive schema (short-circuit the caller).
   */
  private mergePrimitiveSchemaIntoAnyOf(
    anyOf: JSONSchemaObjMutable[],
    cur: JSONSchemaMutable,
  ): boolean {
    if (cur === true) {
      // One of our anyOf values was true, so return true to let our caller
      // know that they can skip the anyOf and just use `true` for the schema.
      return true;
    } else if (cur === false) {
      // One of our anyOf values was false. This has no effect on the anyOf,
      // so we don't need to add it to the list, and we can just return.
      return false;
    }
    const curStr = JSON.stringify(cur);
    if (anyOf.some((option) => JSON.stringify(option) === curStr)) {
      return false;
    }
    // See if we can merge into one of the anyOf options
    const matchingTypeIdx = anyOf.findIndex((option) =>
      isRecord(option) &&
      PRIMITIVE_SCHEMA_KEY_SET.isSupersetOf(new Set(Object.keys(option))) &&
      "type" in option && option.type === cur.type
    );
    const matchingType = matchingTypeIdx !== -1
      ? anyOf[matchingTypeIdx]
      : undefined;
    const isCurPrimitive = PRIMITIVE_SCHEMA_KEY_SET.isSupersetOf(
      new Set(Object.keys(cur)),
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
        // this collapse may allow us to combine with other options that have only a type,
        // but I'm not doing that currently.
        const { enum: _dropped, ...rest } = matchingType;
        anyOf[matchingTypeIdx] = rest;
      } else {
        anyOf[matchingTypeIdx] = {
          ...matchingType,
          enum: [...mergedEnum].toSorted(),
        };
      }
    } else if (isRecord(matchingType)) {
      // If either entry is missing an enum, we can have any value of that type, so clear enum
      const { enum: _dropped, ...rest } = matchingType;
      anyOf[matchingTypeIdx] = rest;
    } else if (
      isCurPrimitive && cur.enum === undefined && cur.type !== undefined
    ) {
      // If cur is a primitive non-enum with a known type, we can merge with any existing non-enum primitive
      const matchingNonEnumIdx = anyOf.findIndex((option) =>
        isRecord(option) &&
        PRIMITIVE_SCHEMA_KEY_SET.isSupersetOf(new Set(Object.keys(option))) &&
        option.enum === undefined
      );
      const matchingNonEnum = matchingNonEnumIdx !== -1
        ? anyOf[matchingNonEnumIdx]
        : undefined;
      if (isRecord(matchingNonEnum) && matchingNonEnumIdx !== -1) {
        const curTypes = Array.isArray(cur.type) ? cur.type : [cur.type];
        const matchingNonEnumTypes = matchingNonEnum.type === undefined
          ? []
          : Array.isArray(matchingNonEnum.type)
          ? matchingNonEnum.type
          : [matchingNonEnum.type];
        anyOf[matchingNonEnumIdx] = {
          ...matchingNonEnum,
          type: [...new Set([...curTypes, ...matchingNonEnumTypes])].toSorted(),
        };
      } else {
        anyOf.push(cur);
      }
    } else {
      anyOf.push(cur);
    }
    return false;
  }

  /**
   * Normalize a schema for structural comparison by removing enum values
   * and converting them to base types
   */
  private normalizeSchemaForComparison(
    schema: JSONSchemaMutable,
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
          value as JSONSchemaMutable,
        );
      }
      result.properties = props;
    }

    // Recursively normalize items
    if ("items" in schema && schema.items) {
      result.items = this.normalizeSchemaForComparison(
        schema.items as JSONSchemaMutable,
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
  private mergeSchemaGroup(
    schemas: JSONSchemaMutable[],
  ): JSONSchemaMutable {
    if (schemas.length === 0) {
      throw new Error("Cannot merge empty schema group");
    }

    const first = schemas[0]!;
    if (typeof first === "boolean") return first;

    const result: JSONSchemaObjMutable = {};

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
      const props: Record<string, JSONSchemaMutable> = {};
      for (const key of Object.keys(first.properties)) {
        const propSchemas = schemas
          .map((s) =>
            isRecord(s) && isRecord(s.properties)
              ? s.properties[key]
              : undefined
          )
          .filter((p): p is JSONSchemaMutable => p !== undefined);

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
        .filter((i): i is JSONSchemaMutable => i !== undefined);

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
