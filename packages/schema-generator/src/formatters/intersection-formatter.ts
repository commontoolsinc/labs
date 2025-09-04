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
    // Check if it's an intersection type OR if we have an intersection type node
    if (type.flags & ts.TypeFlags.Intersection) {
      return true;
    }
    
    // Also support intersection via TypeNode when the resolved type might be flattened
    if (context.typeNode && ts.isIntersectionTypeNode(context.typeNode)) {
      return true;
    }
    
    return false;
  }

  formatType(type: ts.Type, context: GenerationContext): SchemaDefinition {
    const checker = context.typeChecker;
    
    // Determine intersection parts from either the resolved type or the TypeNode
    let parts: readonly ts.Type[];
    
    if (type.flags & ts.TypeFlags.Intersection) {
      // Standard intersection type case
      const inter = type as ts.IntersectionType;
      parts = inter.types ?? [];
    } else if (context.typeNode && ts.isIntersectionTypeNode(context.typeNode)) {
      // TypeNode intersection case (when resolved type is flattened)
      // Get types from individual intersection parts
      parts = context.typeNode.types.map(typeNode => 
        checker.getTypeFromTypeNode(typeNode)
      );
      
      // If the parts are also flattened/invalid, try to get the declared types from symbols
      if (parts.some(part => (part.flags & ts.TypeFlags.Any) !== 0 || checker.getPropertiesOfType(part).length === 0)) {
        const validParts: ts.Type[] = [];
        
        for (const partTypeNode of context.typeNode.types) {
          if (ts.isTypeReferenceNode(partTypeNode) && ts.isIdentifier(partTypeNode.typeName)) {
            const symbol = checker.getSymbolAtLocation(partTypeNode.typeName);
            if (symbol) {
              const declaredType = checker.getDeclaredTypeOfSymbol(symbol);
              const props = checker.getPropertiesOfType(declaredType);
              if (declaredType.flags & ts.TypeFlags.Object && props.length > 0) {
                validParts.push(declaredType);
              }
            }
          }
        }
        if (validParts.length > 0) {
          parts = validParts;
        }
      }
    } else {
      throw new Error("IntersectionFormatter called but no intersection found");
    }
    
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
        return `non-object constituent (flags: ${part.flags}, name: ${part.symbol?.name})`;
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
    context: GenerationContext,
  ): SchemaDefinition {
    const mergedProps: Record<string, SchemaDefinition> = {};
    const requiredSet: Set<string> = new Set();

    for (const part of parts) {
      // Create a context without the intersection typeNode to prevent recursive formatting
      // Each intersection part should be processed independently
      const { typeNode, ...restContext } = context;
      const partContext: GenerationContext = restContext;
      
      const schema = this.schemaGenerator.formatChildType(
        part,
        partContext,
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
      } else {
        // Part is not an object schema (might be $ref or other type)
        // This is unexpected for intersection parts that passed validation
        console.warn(`Intersection part produced non-object schema:`, schema);
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
