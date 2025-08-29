import ts from "typescript";
import type {
  FormatterContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import { extractValueFromTypeNode, isDefaultTypeRef } from "../type-utils.ts";

/**
 * Formatter for Common Tools specific types (Cell<T>, Stream<T>, Default<T,V>)
 */
export class CommonToolsFormatter implements TypeFormatter {
  constructor(private schemaGenerator?: any) {}
  supportsType(type: ts.Type, context: FormatterContext): boolean {
    // Handle Common Tools wrapper types
    if (type.flags & ts.TypeFlags.Object) {
      const objectType = type as ts.ObjectType;

      // Check for type references (Cell<T>, Stream<T>, Default<T,V>)
      if (objectType.objectFlags & ts.ObjectFlags.Reference) {
        const typeRef = objectType as ts.TypeReference;
        const symbol = typeRef.target?.symbol;
        if (symbol) {
          const name = symbol.getName();
          return name === "Cell" || name === "Stream" || name === "Default";
        }
      }
    }

    return false;
  }

  formatType(type: ts.Type, context: FormatterContext): SchemaDefinition {
    const checker = context.typeChecker;
    const objectType = type as ts.ObjectType;
    const typeRef = objectType as ts.TypeReference;
    const symbol = typeRef.target?.symbol;

    if (!symbol) {
      return { type: "object", additionalProperties: true };
    }

    const name = symbol.getName();

    switch (name) {
      case "Cell":
        return this.formatCellType(typeRef, checker, context);
      case "Stream":
        return this.formatStreamType(typeRef, checker, context);
      case "Default":
        return this.formatDefaultType(typeRef, checker, context);
      default:
        return { type: "object", additionalProperties: true };
    }
  }

  private formatCellType(
    typeRef: ts.TypeReference,
    checker: ts.TypeChecker,
    context: FormatterContext,
  ): SchemaDefinition {
    // Get the typeNode from context (like the old system did)
    let innerTypeNode: ts.TypeNode | undefined;
    if (
      context.typeNode && ts.isTypeReferenceNode(context.typeNode) &&
      context.typeNode.typeArguments &&
      context.typeNode.typeArguments.length > 0
    ) {
      innerTypeNode = context.typeNode.typeArguments[0];
    }

    // Use the old system's approach: extract inner type AND pass typeNode for recursive processing
    const innerType = this.getTypeArgument(typeRef, 0) || typeRef;

    if (this.schemaGenerator) {
      // Check if this is an array element type
      if ((innerType as any).isArrayElementType) {
        // Generate schema for the element type
        const elementSchema = this.schemaGenerator.generateSchema(
          innerType,
          context.typeChecker,
          innerTypeNode,
        );

        // Return array schema
        return {
          type: "array",
          items: elementSchema,
          asCell: true,
        };
      }

      // Use recursive delegation with BOTH the type AND the typeNode (like the old system)
      const innerSchema = this.schemaGenerator.generateSchema(
        innerType,
        context.typeChecker,
        innerTypeNode, // ← This is the key! Pass the node for recursive processing
      );
      return { ...innerSchema, asCell: true };
    } else {
      // Fallback for when schemaGenerator is not available
      const innerSchema = this.createSimpleInnerSchema(
        innerType,
        context.typeChecker,
      );
      return { ...innerSchema, asCell: true };
    }
  }

  private formatStreamType(
    typeRef: ts.TypeReference,
    checker: ts.TypeChecker,
    context: FormatterContext,
  ): SchemaDefinition {
    // Mirror Cell<T> robustness: resolve via alias/resolved arguments and carry node
    let innerTypeNode: ts.TypeNode | undefined;
    if (
      context.typeNode && ts.isTypeReferenceNode(context.typeNode) &&
      context.typeNode.typeArguments &&
      context.typeNode.typeArguments.length > 0
    ) {
      innerTypeNode = context.typeNode.typeArguments[0];
    }

    const innerType = this.getTypeArgument(typeRef, 0) || typeRef;

    if (this.schemaGenerator) {
      if ((innerType as any).isArrayElementType) {
        const elementSchema = this.schemaGenerator.generateSchema(
          innerType,
          context.typeChecker,
          innerTypeNode,
        );
        return {
          type: "array",
          items: elementSchema,
          asStream: true,
        };
      }

      const innerSchema = this.schemaGenerator.generateSchema(
        innerType,
        context.typeChecker,
        innerTypeNode,
      );
      return { ...innerSchema, asStream: true };
    }

    const innerSchema = this.createSimpleInnerSchema(innerType, checker);
    return { ...innerSchema, asStream: true };
  }

  private formatDefaultType(
    typeRef: ts.TypeReference,
    checker: ts.TypeChecker,
    context: FormatterContext,
  ): SchemaDefinition {
    const typeArguments = typeRef.typeArguments;
    if (!typeArguments || typeArguments.length < 2) {
      return { type: "object", additionalProperties: true };
    }
    const valueType = typeArguments[0]!;
    const defaultType = typeArguments[1]!;

    // Attempt node-based extraction for defaults when possible
    let valueTypeNode: ts.TypeNode | undefined;
    let defaultTypeNode: ts.TypeNode | undefined;
    if (
      context.typeNode && ts.isTypeReferenceNode(context.typeNode) &&
      context.typeNode.typeArguments &&
      context.typeNode.typeArguments.length >= 2
    ) {
      valueTypeNode = context.typeNode.typeArguments[0];
      defaultTypeNode = context.typeNode.typeArguments[1];
    }

    let valueSchema: SchemaDefinition;
    if (this.schemaGenerator) {
      valueSchema = this.schemaGenerator.generateSchema(
        valueType,
        context.typeChecker,
        valueTypeNode,
      );
    } else {
      valueSchema = this.createSimpleInnerSchema(valueType, checker);
    }

    // Prefer extracting default from the node to support arrays/tuples/objects
    let extracted: any = undefined;
    if (defaultTypeNode) {
      extracted = extractValueFromTypeNode(defaultTypeNode, checker);
    }
    if (extracted === undefined) {
      extracted = this.extractValueFromType(defaultType, checker);
    }
    if (extracted !== undefined) {
      (valueSchema as any).default = extracted;
    }

    return valueSchema;
  }

  /**
   * Get type argument at the specified index, handling both typeArguments and resolvedTypeArguments
   * This is the same logic as the old system's getTypeArgument function
   */
  private getTypeArgument(type: ts.Type, index: number): ts.Type | undefined {
    const typeRef = type as ts.TypeReference;

    const aliasArgs = (type as any).aliasTypeArguments as ts.Type[] | undefined;
    const resolvedArgs = (type as any).resolvedTypeArguments as
      | ts.Type[]
      | undefined;
    const directArgs = typeRef.typeArguments as ts.Type[] | undefined;

    let chosen: ts.Type | undefined = undefined;
    if (aliasArgs && aliasArgs.length > index) chosen = aliasArgs[index];
    if (!chosen && resolvedArgs && resolvedArgs.length > index) {
      chosen = resolvedArgs[index];
    }
    if (!chosen && directArgs && directArgs.length > index) {
      chosen = directArgs[index];
    }

    if (!chosen) return undefined;

    // If the chosen argument is Array<Elem>, unwrap to element type
    const aliasSymbol = (chosen as any).aliasSymbol;
    if (aliasSymbol?.escapedName === "Array") {
      const elemArgs = (chosen as any).aliasTypeArguments as ts.Type[] | undefined;
      const elem = elemArgs?.[0];
      if (elem) {
        (elem as any).isArrayElementType = true;
        (elem as any).arrayType = chosen;
        return elem;
      }
    }

    return chosen;
  }

  private createSimpleInnerSchema(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): SchemaDefinition {
    // Simple fallback for inner types
    // In the full implementation, this would delegate to the main generator
    if (type.flags & ts.TypeFlags.String) {
      return { type: "string" };
    }
    if (type.flags & ts.TypeFlags.Number) {
      return { type: "number" };
    }
    if (type.flags & ts.TypeFlags.Boolean) {
      return { type: "boolean" };
    }
    if (type.flags & ts.TypeFlags.Null) {
      return { type: "null" };
    }
    if (type.flags & ts.TypeFlags.Undefined) {
      return { type: "string", enum: ["undefined"] };
    }

    // Default fallback
    return { type: "object", additionalProperties: true };
  }

  private createSimpleInnerSchemaFromNode(
    node: ts.TypeNode,
    checker: ts.TypeChecker,
  ): SchemaDefinition {
    // Simple fallback for inner types from TypeNode
    // In the full implementation, this would delegate to the main generator
    if (ts.isLiteralTypeNode(node)) {
      if (ts.isStringLiteral(node.literal)) {
        return { type: "string" };
      }
      if (ts.isNumericLiteral(node.literal)) {
        return { type: "number" };
      }
      if (
        node.literal.kind === ts.SyntaxKind.TrueKeyword ||
        node.literal.kind === ts.SyntaxKind.FalseKeyword
      ) {
        return { type: "boolean" };
      }
    }

    // Default fallback
    return { type: "object", additionalProperties: true };
  }

  private extractValueFromType(type: ts.Type, checker: ts.TypeChecker): any {
    // Simple extraction of literal values from types
    if (type.flags & ts.TypeFlags.StringLiteral) {
      return (type as ts.StringLiteralType).value;
    }
    if (type.flags & ts.TypeFlags.NumberLiteral) {
      return (type as ts.NumberLiteralType).value;
    }
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return (type as any).intrinsicName === "true";
    }

    // Default fallback
    return undefined;
  }
}
