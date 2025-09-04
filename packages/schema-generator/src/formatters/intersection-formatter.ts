import ts from "typescript";
import type {
  FormatterContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";

export class IntersectionFormatter implements TypeFormatter {
  constructor(private schemaGenerator: SchemaGenerator) {}

  supportsType(type: ts.Type): boolean {
    return (type.flags & ts.TypeFlags.Intersection) !== 0;
  }

  formatType(type: ts.Type, context: FormatterContext): SchemaDefinition {
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
        const stringIndex = checker.getIndexTypeOfType(part, ts.IndexKind.String);
        const numberIndex = checker.getIndexTypeOfType(part, ts.IndexKind.Number);
        if (stringIndex || numberIndex) {
          return "index signature on constituent";
        }

        // Reject types with call/construct signatures as they're not object properties
        const callSigs = checker.getSignaturesOfType(part, ts.SignatureKind.Call);
        const constructSigs = checker.getSignaturesOfType(
          part,
          ts.SignatureKind.Construct,
        );
        if (callSigs.length > 0 || constructSigs.length > 0) {
          return "call/construct signatures on constituent";
        }
      } catch (error) {
        return `checker error while validating intersection: ${error}`;
      }
    }

    return null; // All parts are valid
  }

  private mergeIntersectionParts(
    parts: readonly ts.Type[],
    context: FormatterContext,
  ): SchemaDefinition {
    const mergedProps: Record<string, SchemaDefinition> = {};
    const requiredSet: Set<string> = new Set();

    for (const part of parts) {
      const schema = this.schemaGenerator.generateSchema(
        part,
        context.typeChecker,
        undefined, // No specific type node for intersection parts
      );

      if (this.isObjectSchema(schema)) {
        // Merge properties from this part
        if (schema.properties) {
          for (const [key, value] of Object.entries(schema.properties)) {
            if (mergedProps[key] && mergedProps[key] !== value) {
              // Property conflict - could improve this with more sophisticated merging
              console.warn(`Intersection property conflict for key '${key}' - using first definition`);
            } else {
              mergedProps[key] = value;
            }
          }
        }

        // Merge required properties
        if (Array.isArray(schema.required)) {
          for (const req of schema.required) {
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

  private isObjectSchema(schema: SchemaDefinition): schema is SchemaDefinition & { 
    properties?: Record<string, SchemaDefinition>;
    required?: string[];
  } {
    return (
      typeof schema === "object" &&
      schema !== null &&
      schema.type === "object"
    );
  }
}
