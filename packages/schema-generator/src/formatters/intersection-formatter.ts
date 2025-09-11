import ts from "typescript";
import type {
  GenerationContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";

export class IntersectionFormatter implements TypeFormatter {
  constructor(private schemaGenerator: SchemaGenerator) {}

  supportsType(type: ts.Type, context: GenerationContext): boolean {
    return (type.flags & ts.TypeFlags.Intersection) !== 0;
  }

  formatType(type: ts.Type, context: GenerationContext): SchemaDefinition {
    const checker = context.typeChecker;
    const inter = type as ts.IntersectionType;
    const parts = inter.types ?? [];

    if (parts.length === 0) {
      throw new Error("IntersectionFormatter received empty intersection type");
    }

    // Validate constituents to ensure safe merging
    const failureReason = this.validateIntersectionParts(parts, checker);
    if (failureReason) {
      return {
        type: "object",
        additionalProperties: true,
        $comment: `Unsupported intersection pattern: ${failureReason}`,
      };
    }

    // Merge object-like constituents: combine properties and required arrays
    return this.mergeIntersectionParts(parts, context);
  }

  private validateIntersectionParts(
    parts: readonly ts.Type[],
    checker: ts.TypeChecker,
  ): string | null {
    for (const part of parts) {
      // Only support object-like types for safe merging
      if ((part.flags & ts.TypeFlags.Object) === 0) {
        return "non-object constituent";
      }

      try {
        // Reject types with index signatures as they can't be safely merged
        const stringIndex = checker.getIndexTypeOfType(
          part,
          ts.IndexKind.String,
        );
        const numberIndex = checker.getIndexTypeOfType(
          part,
          ts.IndexKind.Number,
        );
        if (stringIndex || numberIndex) {
          return "index signature on constituent";
        }

        // Note: Call/construct signatures are ignored (consistent with other formatters)
        // They cannot be represented in JSON Schema, so we just extract regular properties
      } catch (error) {
        return `checker error while validating intersection: ${error}`;
      }
    }

    return null; // All parts are valid
  }

  private mergeIntersectionParts(
    parts: readonly ts.Type[],
    context: GenerationContext,
  ): SchemaDefinition {
    const mergedProps: Record<string, SchemaDefinition> = {};
    const requiredSet: Set<string> = new Set();

    for (const part of parts) {
      const schema = this.schemaGenerator.formatChildType(part, context);

      const objSchema = this.resolveObjectSchema(schema, context);
      if (objSchema) {
        // Merge properties from this part
        if (objSchema.properties) {
          for (const [key, value] of Object.entries(objSchema.properties)) {
            if (mergedProps[key] && mergedProps[key] !== value) {
              // Property conflict - could improve this with more sophisticated merging
              console.warn(
                `Intersection property conflict for key '${key}' - using first definition`,
              );
            } else {
              mergedProps[key] = value;
            }
          }
        }

        // Merge required properties
        if (Array.isArray(objSchema.required)) {
          for (const req of objSchema.required) {
            if (typeof req === "string") {
              requiredSet.add(req);
            }
          }
        }
      }
    }

    const result: SchemaDefinition = {
      type: "object",
      properties: mergedProps,
    };

    if (requiredSet.size > 0) {
      result.required = Array.from(requiredSet);
    }

    return result;
  }

  private isObjectSchema(
    schema: SchemaDefinition,
  ): schema is SchemaDefinition & {
    properties?: Record<string, SchemaDefinition>;
    required?: string[];
  } {
    return (
      typeof schema === "object" &&
      schema !== null &&
      schema.type === "object"
    );
  }

  private resolveObjectSchema(
    schema: SchemaDefinition,
    context: GenerationContext,
  ):
    | (SchemaDefinition & {
      properties?: Record<string, SchemaDefinition>;
      required?: string[];
    })
    | undefined {
    if (this.isObjectSchema(schema)) return schema;
    if (
      typeof schema === "object" && schema !== null &&
      typeof (schema as any).$ref === "string"
    ) {
      const ref: string = (schema as any).$ref as string;
      const prefix = "#/definitions/";
      if (ref.startsWith(prefix)) {
        const name = ref.slice(prefix.length);
        const def = context.definitions[name];
        if (def && this.isObjectSchema(def)) return def as any;
      }
    }
    return undefined;
  }
}
