import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
  buildCaptureTypeElements,
  buildTypeElementsFromCaptureTree,
  createRegisteredTypeLiteral,
  expressionToTypeNode,
  typeToTypeNodeWithRegistry,
} from "../../ast/type-building.ts";
import {
  inferArrayElementType,
  registerTypeForNode,
  tryExplicitParameterType,
} from "../../ast/type-inference.ts";
import { isOptionalMemberSymbol } from "../../ast/mod.ts";

export class SchemaFactory {
  constructor(
    private context: TransformationContext,
    private factory: ts.NodeFactory = context.factory,
  ) {}

  /**
   * Build the public TypeNode for an array method callback.
   * Returns: { element: T, index?: number, array?: T[] }
   * Closure captures have a separate private schema and never appear here.
   */
  createArrayMethodCallbackSchema(
    methodCall: ts.CallExpression,
    elemParam: ts.ParameterDeclaration | undefined,
    indexParam: ts.ParameterDeclaration | undefined,
    arrayParam: ts.ParameterDeclaration | undefined,
  ): ts.TypeNode {
    const { checker } = this.context;
    const typeRegistry = this.context.options.state?.typeRegistry;

    // 1. Determine element type
    let elemTypeNode: ts.TypeNode;

    // Try explicit annotation
    const explicit = tryExplicitParameterType(elemParam, checker, typeRegistry);
    if (explicit) {
      elemTypeNode = explicit.typeNode;
    } else {
      // Infer from map call
      const inferred = inferArrayElementType(
        (methodCall.expression as ts.PropertyAccessExpression).expression,
        { ...this.context, typeRegistry },
      );

      elemTypeNode = inferred.typeNode;

      // Register the inferred type if available
      if (inferred.type) {
        registerTypeForNode(elemTypeNode, inferred.type, typeRegistry);
      }
    }

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

    return createRegisteredTypeLiteral(
      callbackParamProperties,
      { factory: this.factory, checker, typeRegistry },
    );
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
        this.context.options.state?.typeRegistry,
      );
      if (explicit) return explicit.typeNode;
    }

    // Fallback: build from captures
    const paramsProperties = buildTypeElementsFromCaptureTree(
      captureTree,
      this.context,
    );
    return createRegisteredTypeLiteral(
      paramsProperties,
      {
        factory: this.factory,
        checker: this.context.checker,
        typeRegistry: this.context.options.state?.typeRegistry,
      },
    );
  }

  /**
   * Build schema TypeNode for the merged input object.
   * Creates an object schema with properties for input and all captures.
   *
   * When hadZeroParameters is true, skip the input and only include captures.
   */
  createLiftAppliedInputSchema(
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
        if (isOptionalMemberSymbol(originalInput, this.context.checker)) {
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
    const captureTypeElements = buildCaptureTypeElements(
      captureTree,
      this.context,
      captureNameMap,
    );
    typeElements.push(...captureTypeElements);

    // Create object type literal
    return createRegisteredTypeLiteral(
      typeElements,
      {
        factory,
        checker: this.context.checker,
        typeRegistry: this.context.options.state?.typeRegistry,
      },
    );
  }

  /**
   * Build a TypeNode for action's event parameter.
   *
   * Actions don't use the event parameter, so we return `never` type
   * which generates `false` in JSON Schema (no valid value).
   */
  createActionEventSchema(): ts.TypeNode {
    const { factory } = this.context;
    return factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
  }

  /**
   * Build a TypeNode for the handler event parameter and register it in TypeRegistry.
   */
  createHandlerEventSchema(
    callback: ts.ArrowFunction | ts.FunctionExpression,
  ): ts.TypeNode {
    const { factory, checker } = this.context;
    const typeRegistry = this.context.options.state?.typeRegistry;
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

    // Convert via the canonical chokepoint: normalizes commonfabric refs to
    // `__cfHelpers.X`, registers the node for schema generation, and falls back
    // to `unknown` if conversion fails.
    return typeToTypeNodeWithRegistry(
      type,
      { checker, factory, sourceFile: this.context.sourceFile },
      typeRegistry,
    );
  }
}
