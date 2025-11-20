import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
  buildTypeElementsFromCaptureTree,
  expressionToTypeNode,
} from "../../ast/type-building.ts";
import {
  inferArrayElementType,
  registerTypeForNode,
  tryExplicitParameterType,
} from "../../ast/type-inference.ts";
import { isOptionalPropertyAccess } from "../../ast/mod.ts";

export class SchemaFactory {
  constructor(
    private context: TransformationContext,
    private factory: ts.NodeFactory = context.factory,
  ) { }

  /**
   * Build a TypeNode for a map callback parameter.
   * Returns: { element: T, index?: number, array?: T[], params: {...} }
   */
  createMapCallbackSchema(
    mapCall: ts.CallExpression,
    elemParam: ts.ParameterDeclaration | undefined,
    indexParam: ts.ParameterDeclaration | undefined,
    arrayParam: ts.ParameterDeclaration | undefined,
    captureTree: Map<string, CaptureTreeNode>,
  ): ts.TypeNode {
    // 1. Determine element type
    const elemTypeInfo = this.determineElementType(mapCall, elemParam);
    const elemTypeNode = elemTypeInfo.typeNode;

    // 2. Build callback parameter properties
    const callbackParamProperties: ts.TypeElement[] = [
      this.factory.createPropertySignature(
        undefined,
        this.factory.createIdentifier("element"),
        undefined,
        elemTypeNode,
      ),
    ];

    // 3. Add optional index property if present
    if (indexParam) {
      callbackParamProperties.push(
        this.factory.createPropertySignature(
          undefined,
          this.factory.createIdentifier("index"),
          this.factory.createToken(ts.SyntaxKind.QuestionToken),
          this.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
        ),
      );
    }

    // 4. Add optional array property if present
    if (arrayParam) {
      const arrayTypeNode = this.factory.createArrayTypeNode(elemTypeNode);
      callbackParamProperties.push(
        this.factory.createPropertySignature(
          undefined,
          this.factory.createIdentifier("array"),
          this.factory.createToken(ts.SyntaxKind.QuestionToken),
          arrayTypeNode,
        ),
      );
    }

    // 5. Build params object type with hierarchical captures
    const paramsProperties = buildTypeElementsFromCaptureTree(
      captureTree,
      this.context,
    );

    // 6. Add params property
    callbackParamProperties.push(
      this.factory.createPropertySignature(
        undefined,
        this.factory.createIdentifier("params"),
        undefined,
        this.factory.createTypeLiteralNode(paramsProperties),
      ),
    );

    return this.factory.createTypeLiteralNode(callbackParamProperties);
  }

  /**
   * Build a TypeNode for a handler state parameter.
   * Returns: { ...captures }
   */
  createHandlerStateSchema(
    captureTree: Map<string, CaptureTreeNode>,
    stateParam?: ts.ParameterDeclaration,
  ): ts.TypeNode {
    // Try explicit annotation first
    if (stateParam) {
      const explicit = tryExplicitParameterType(
        stateParam,
        this.context.checker,
        this.context.options.typeRegistry,
      );
      if (explicit) return explicit.typeNode;
    }

    // Fallback: build from captures
    const paramsProperties = buildTypeElementsFromCaptureTree(
      captureTree,
      this.context,
    );
    return this.factory.createTypeLiteralNode(paramsProperties);
  }

  /**
   * Build schema TypeNode for the merged input object.
   * Creates an object schema with properties for input and all captures.
   *
   * When hadZeroParameters is true, skip the input and only include captures.
   */
  createDeriveInputSchema(
    originalInputParamName: string,
    originalInput: ts.Expression,
    captureTree: Map<string, CaptureTreeNode>,
    captureNameMap: Map<string, string>,
    hadZeroParameters: boolean,
  ): ts.TypeNode {
    const { factory } = this.context;

    // Build type elements for the object schema
    const typeElements: ts.TypeElement[] = [];

    // Add type element for original input UNLESS callback had zero parameters
    if (!hadZeroParameters) {
      // Add type element for original input using the helper function
      const inputTypeNode = expressionToTypeNode(originalInput, this.context);

      // Check if the original input is an optional property access (e.g., config.multiplier where multiplier?: number)
      let questionToken: ts.QuestionToken | undefined = undefined;
      if (ts.isPropertyAccessExpression(originalInput)) {
        if (isOptionalPropertyAccess(originalInput, this.context.checker)) {
          questionToken = factory.createToken(ts.SyntaxKind.QuestionToken);
        }
      }

      typeElements.push(
        factory.createPropertySignature(
          undefined,
          factory.createIdentifier(originalInputParamName),
          questionToken,
          inputTypeNode,
        ),
      );
    }

    // Add type elements for captures using the existing helper
    const captureTypeElements = buildTypeElementsFromCaptureTree(
      captureTree,
      this.context,
    );

    // Rename the property signatures if there are collisions
    for (const typeElement of captureTypeElements) {
      if (
        ts.isPropertySignature(typeElement) && ts.isIdentifier(typeElement.name)
      ) {
        const originalName = typeElement.name.text;
        const renamedName = captureNameMap.get(originalName) ?? originalName;

        if (renamedName !== originalName) {
          // Create a new property signature with the renamed identifier
          typeElements.push(
            factory.createPropertySignature(
              typeElement.modifiers,
              factory.createIdentifier(renamedName),
              typeElement.questionToken,
              typeElement.type,
            ),
          );
        } else {
          // No renaming needed
          typeElements.push(typeElement);
        }
      } else {
        // Not a simple property signature, keep as-is
        typeElements.push(typeElement);
      }
    }

    // Create object type literal
    return factory.createTypeLiteralNode(typeElements);
  }

  /**
   * Build a TypeNode for the handler event parameter and register it in TypeRegistry.
   */
  createHandlerEventSchema(
    callback: ts.ArrowFunction | ts.FunctionExpression,
  ): ts.TypeNode {
    const { factory, checker } = this.context;
    const typeRegistry = this.context.options.typeRegistry;
    const eventParam = callback.parameters[0];

    // If no event parameter exists, use never type (will generate false schema)
    if (!eventParam) {
      const neverTypeNode = factory.createKeywordTypeNode(
        ts.SyntaxKind.NeverKeyword,
      );

      // Don't register a Type - the synthetic NeverKeyword TypeNode will be handled
      // by generateSchemaFromSyntheticTypeNode in the schema generator
      return neverTypeNode;
    }

    // Try explicit annotation
    const explicit = tryExplicitParameterType(
      eventParam,
      checker,
      typeRegistry,
    );
    if (explicit) return explicit.typeNode;

    // Infer from parameter location
    const type = checker.getTypeAtLocation(eventParam);

    // Try to convert Type to TypeNode
    const typeNode = checker.typeToTypeNode(
      type,
      this.context.sourceFile,
      ts.NodeBuilderFlags.NoTruncation |
      ts.NodeBuilderFlags.UseStructuralFallback,
    ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

    return registerTypeForNode(typeNode, type, typeRegistry);
  }

  /**
   * Helper to determine element type for map callback.
   */
  private determineElementType(
    mapCall: ts.CallExpression,
    elemParam: ts.ParameterDeclaration | undefined,
  ): { typeNode: ts.TypeNode; type?: ts.Type } {
    const { checker } = this.context;
    const typeRegistry = this.context.options.typeRegistry;

    // Try explicit annotation
    const explicit = tryExplicitParameterType(elemParam, checker, typeRegistry);
    if (explicit) return explicit;

    // Try inference from map call
    const inferred = inferArrayElementType(
      (mapCall.expression as ts.PropertyAccessExpression).expression,
      { ...this.context, typeRegistry },
    );
    if (inferred.type) {
      return {
        typeNode: registerTypeForNode(
          inferred.typeNode,
          inferred.type,
          typeRegistry,
        ),
        type: inferred.type,
      };
    }

    // Fallback: infer from the array expression itself
    // mapCall.expression is PropertyAccess (array.map), so .expression is the array
    const arrayExpr = (mapCall.expression as ts.PropertyAccessExpression).expression;
    const arrayType = checker.getTypeAtLocation(arrayExpr);

    // Try to extract element type from array type
    // This is a best-effort fallback if inferArrayElementType failed
    let elementType = arrayType;
    if (checker.isArrayType(arrayType)) {
      // @ts-ignore: Internal API but standard way to get element type
      elementType = (arrayType as any).typeArguments?.[0] ?? arrayType;
    } else if (arrayType.flags & ts.TypeFlags.Object) {
      // Handle OpaqueRef<T[]> or similar wrappers
      // This is complex without internal APIs, so we might just fallback to 'any' or 'unknown'
      // But let's try to see if it has a single type argument which is an array
      const typeRef = arrayType as ts.TypeReference;
      if (typeRef.typeArguments && typeRef.typeArguments.length > 0) {
        const inner = typeRef.typeArguments[0];
        if (inner && checker.isArrayType(inner)) {
          // @ts-ignore: Internal API
          elementType = (inner as any).typeArguments?.[0] ?? inner;
        }
      }
    }

    const typeNode = checker.typeToTypeNode(
      elementType,
      this.context.sourceFile,
      ts.NodeBuilderFlags.NoTruncation |
      ts.NodeBuilderFlags.UseStructuralFallback,
    ) ?? this.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

    return {
      typeNode: registerTypeForNode(typeNode, elementType, typeRegistry),
      type: elementType,
    };
  }
}
