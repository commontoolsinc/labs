import ts from "typescript";
import { isOpaqueRefType, containsOpaqueRef, isSimpleOpaqueRefAccess } from "./types.ts";
import { 
  addCommonToolsImport, 
  hasCommonToolsImport 
} from "./imports.ts";
import { 
  checkTransformation, 
  createIfElseCall, 
  transformExpressionWithOpaqueRef,
  addGetCallsToOpaqueRefs
} from "./transforms.ts";
import { conditionalConsole } from "../conditional-console.ts";

/**
 * Options for the OpaqueRef transformer.
 */
export interface OpaqueRefTransformerOptions {
  /**
   * Mode of operation:
   * - 'transform': Transform the code (default)
   * - 'error': Report errors instead of transforming
   */
  mode?: 'transform' | 'error';
  
  /**
   * Enable debug logging.
   */
  debug?: boolean;
  
  /**
   * Custom logger function.
   */
  logger?: (message: string) => void;
}

/**
 * Transformation error that can be reported in error mode.
 */
export interface TransformationError {
  file: string;
  line: number;
  column: number;
  message: string;
  type: 'ternary' | 'jsx' | 'binary' | 'call' | 'element-access' | 'template' | 'spread';
}

/**
 * Creates a TypeScript transformer that handles OpaqueRef transformations.
 * 
 * Transformations:
 * 1. Ternary operators: `opaqueRef ? a : b` → `ifElse(opaqueRef, a, b)`
 * 2. JSX expressions: `{opaqueRef + 1}` → `{derive(opaqueRef, _v => _v + 1)}`
 * 3. Binary expressions: `opaqueRef + 1` → `derive(opaqueRef, _v => _v + 1)`
 */
export function createOpaqueRefTransformer(
  program: ts.Program,
  options: OpaqueRefTransformerOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
  const checker = program.getTypeChecker();
  const { mode = 'transform', debug = false, logger = conditionalConsole.log } = options;
  const errors: TransformationError[] = [];

  return (context) => {
    return (sourceFile) => {
      let needsIfElseImport = false;
      let needsDeriveImport = false;
      let needsToSchemaImport = false;
      let hasTransformed = false;

      const log = (message: string) => {
        if (debug) {
          logger(`[OpaqueRefTransformer] ${message}`);
        }
      };

      const reportError = (node: ts.Node, type: 'ternary' | 'jsx' | 'binary' | 'call' | 'element-access' | 'template', message: string) => {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        errors.push({
          file: sourceFile.fileName,
          line: line + 1,
          column: character + 1,
          message,
          type,
        });
      };

      const visit: ts.Visitor = (node) => {
        // Handle function calls with OpaqueRef arguments or method calls on OpaqueRef
        if (ts.isCallExpression(node)) {
          // Special case: handler with type arguments
          const functionName = getFunctionName(node);
          if (functionName === 'handler' && node.typeArguments && node.typeArguments.length >= 2) {
            // Transform handler<E,T>(fn) to handler(toSchema<E>(), toSchema<T>(), fn)
            if (debug) {
              log(`Found handler with type arguments at ${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
            }
            
            const [eventType, stateType] = node.typeArguments;
            const handlerArgs = node.arguments;
            
            // Create toSchema calls for the type arguments
            const toSchemaEventCall = context.factory.createCallExpression(
              context.factory.createIdentifier('toSchema'),
              [eventType],
              []
            );
            
            const toSchemaStateCall = context.factory.createCallExpression(
              context.factory.createIdentifier('toSchema'),
              [stateType],
              []
            );
            
            // Create new handler call without type arguments but with schema arguments
            const newHandlerCall = context.factory.createCallExpression(
              node.expression,
              undefined, // No type arguments
              [toSchemaEventCall, toSchemaStateCall, ...handlerArgs]
            );
            
            // Mark that we need toSchema import
            if (!hasCommonToolsImport(sourceFile, "toSchema")) {
              needsToSchemaImport = true;
            }
            
            hasTransformed = true;
            return ts.visitEachChild(newHandlerCall, visit, context);
          }
          
          // Check if this is a builder function call - these should not be transformed
          const builderFunctions = ['recipe', 'lift', 'handler', 'derive', 'compute', 'render', 'ifElse', 'str'];
          if (functionName && builderFunctions.includes(functionName)) {
            // Just visit children normally for builder function calls
            return ts.visitEachChild(node, visit, context);
          }
          
          // Check if this is a call to a ModuleFactory/HandlerFactory/RecipeFactory
          // These are functions returned by lift, handler, recipe, etc.
          const expressionType = checker.getTypeAtLocation(node.expression);
          const expressionTypeString = checker.typeToString(expressionType);
          
          if (debug) {
            log(`Call expression's function type: ${expressionTypeString}`);
          }
          
          // If we're calling a ModuleFactory, HandlerFactory, or RecipeFactory
          // these expect Opaque parameters
          if (expressionTypeString.includes('ModuleFactory<') || 
              expressionTypeString.includes('HandlerFactory<') ||
              expressionTypeString.includes('RecipeFactory<')) {
            if (debug) {
              log(`Calling a factory function that expects Opaque parameters, skipping transformation`);
            }
            return ts.visitEachChild(node, visit, context);
          }
          
          // Check if the function expects OpaqueRef parameters
          // If it does, we don't need to transform the arguments
          const functionSymbol = checker.getSymbolAtLocation(node.expression);
          if (functionSymbol) {
            const functionType = checker.getTypeOfSymbolAtLocation(functionSymbol, node.expression);
            const signatures = checker.getSignaturesOfType(functionType, ts.SignatureKind.Call);
            
            if (signatures.length > 0) {
              // Check the first signature (could be improved to check all overloads)
              const signature = signatures[0];
              const parameters = signature.getParameters();
              
              if (parameters.length > 0) {
                // Check if the first parameter expects an OpaqueRef or Opaque type
                const paramType = checker.getTypeOfSymbolAtLocation(parameters[0], node);
                const paramTypeString = checker.typeToString(paramType);
                
                if (debug) {
                  log(`Function ${getFunctionName(node)} parameter type: ${paramTypeString}`);
                }
                
                // If the function expects Opaque or OpaqueRef parameters, don't transform
                if (paramTypeString.includes('Opaque<') || paramTypeString.includes('OpaqueRef<')) {
                  if (debug) {
                    log(`Function expects Opaque/OpaqueRef parameters, skipping transformation`);
                  }
                  return ts.visitEachChild(node, visit, context);
                }
              }
            }
          }
          
          // Also check what the function call returns
          // If it returns a Stream or OpaqueRef, we shouldn't transform it
          const callType = checker.getTypeAtLocation(node);
          const callTypeString = checker.typeToString(callType);
          
          if (debug) {
            log(`Call expression type: ${callTypeString}`);
          }
          
          // If this call returns a Stream or OpaqueRef, don't transform it
          if (callTypeString.includes('Stream<') || 
              callTypeString.includes('OpaqueRef<') ||
              callTypeString.includes('ModuleFactory<')) {
            if (debug) {
              log(`Call returns Stream/OpaqueRef/ModuleFactory, skipping transformation`);
            }
            return ts.visitEachChild(node, visit, context);
          }
          
          // Check if the entire call expression contains OpaqueRef values
          // This handles both arguments and method calls on OpaqueRef objects
          if (containsOpaqueRef(node, checker)) {
            // log(`Found function call transformation at ${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
            hasTransformed = true;
            
            // Wrap the entire function call in derive
            const transformedCall = transformExpressionWithOpaqueRef(
              node,
              checker,
              context.factory,
              sourceFile,
              context
            );
            
            if (transformedCall !== node) {
              if (!hasCommonToolsImport(sourceFile, "derive")) {
                needsDeriveImport = true;
              }
              return transformedCall;
            }
          }
          
          // Otherwise, just visit children normally
          return ts.visitEachChild(node, visit, context);
        }
        
        // Handle property access expressions (e.g., person.name.length)
        // Skip if it's part of a larger expression that will handle it
        if (ts.isPropertyAccessExpression(node) && 
            node.parent &&
            !ts.isCallExpression(node.parent) &&
            !ts.isPropertyAccessExpression(node.parent)) {
          
          // Check if we're accessing a property on an OpaqueRef
          // For example: person.name is OpaqueRef<string>, and we're accessing .length
          const objectType = checker.getTypeAtLocation(node.expression);
          if (isOpaqueRefType(objectType, checker)) {
            // Check if this is just passing through the OpaqueRef (e.g., const x = person.name)
            // vs accessing a property on it (e.g., const x = person.name.length)
            const resultType = checker.getTypeAtLocation(node);
            const isPassThrough = isOpaqueRefType(resultType, checker);
            
            if (!isPassThrough) {
              // This is accessing a property on an OpaqueRef, transform it
              hasTransformed = true;
              const transformedExpression = transformExpressionWithOpaqueRef(
                node,
                checker,
                context.factory,
                sourceFile,
                context
              );
              
              if (transformedExpression !== node) {
                if (!hasCommonToolsImport(sourceFile, "derive")) {
                  needsDeriveImport = true;
                }
                return transformedExpression;
              }
            }
          }
        }
        
        // Handle element access (array indexing)
        if (ts.isElementAccessExpression(node) && node.argumentExpression) {
          if (containsOpaqueRef(node.argumentExpression, checker)) {
            log(`Found element access transformation at ${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
            hasTransformed = true;
            const transformedArgument = addGetCallsToOpaqueRefs(
              node.argumentExpression,
              checker,
              context.factory,
              context
            ) as ts.Expression;
            return context.factory.updateElementAccessExpression(
              node,
              ts.visitNode(node.expression, visit) as ts.Expression,
              transformedArgument
            );
          }
        }
        
        // Handle tagged template expressions (e.g., str`...`)
        if (ts.isTaggedTemplateExpression(node)) {
          // Check if this is the 'str' tagged template
          const tag = node.tag;
          if (ts.isIdentifier(tag) && tag.text === 'str') {
            // str is a builder function, don't transform it
            // Just visit children of the tag, not the template
            const visitedTag = ts.visitNode(node.tag, visit) as ts.Expression;
            return context.factory.updateTaggedTemplateExpression(
              node,
              visitedTag,
              node.typeArguments,
              node.template
            );
          }
          
          // For other tagged templates, check if they contain OpaqueRef
          const template = node.template;
          if (ts.isTemplateExpression(template) && containsOpaqueRef(template, checker)) {
            log(`Found tagged template expression transformation at ${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
            hasTransformed = true;
            
            // Transform the template part
            const transformedTemplate = transformExpressionWithOpaqueRef(
              template,
              checker,
              context.factory,
              sourceFile,
              context
            );
            
            if (transformedTemplate !== template) {
              if (!hasCommonToolsImport(sourceFile, "derive")) {
                needsDeriveImport = true;
              }
              return context.factory.updateTaggedTemplateExpression(
                node,
                node.tag,
                node.typeArguments,
                transformedTemplate as ts.TemplateLiteral
              );
            }
          }
        }
        
        // Handle template expressions
        if (ts.isTemplateExpression(node)) {
          // Check if any template span contains OpaqueRef
          if (containsOpaqueRef(node, checker)) {
            log(`Found template expression transformation at ${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
            hasTransformed = true;
            
            // Transform the entire template expression using derive
            const transformedExpression = transformExpressionWithOpaqueRef(
              node,
              checker,
              context.factory,
              sourceFile,
              context
            );
            
            if (transformedExpression !== node) {
              if (!hasCommonToolsImport(sourceFile, "derive")) {
                needsDeriveImport = true;
              }
              return transformedExpression;
            }
          }
        }
        
        // Handle object literal expressions with spread properties
        if (ts.isObjectLiteralExpression(node)) {
          // Check if any spread property contains OpaqueRef
          const spreadProperties = node.properties.filter(ts.isSpreadAssignment);
          let needsTransformation = false;
          
          for (const spread of spreadProperties) {
            const spreadType = checker.getTypeAtLocation(spread.expression);
            if (isOpaqueRefType(spreadType, checker)) {
              needsTransformation = true;
              break;
            }
          }
          
          if (needsTransformation) {
            log(`Found object spread transformation at ${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
            hasTransformed = true;
            
            // Transform spread properties to individual properties
            const newProperties: ts.ObjectLiteralElementLike[] = [];
            
            for (const prop of node.properties) {
              if (ts.isSpreadAssignment(prop)) {
                const spreadType = checker.getTypeAtLocation(prop.expression);
                if (isOpaqueRefType(spreadType, checker)) {
                  // Handle union types (e.g., OpaqueRef<T> | undefined)
                  let opaqueRefType = spreadType;
                  if (spreadType.flags & ts.TypeFlags.Union) {
                    const unionType = spreadType as ts.UnionType;
                    // Find the OpaqueRef type in the union
                    opaqueRefType = unionType.types.find(t => isOpaqueRefType(t, checker)) || spreadType;
                  }
                  
                  // For intersection types (which OpaqueRef is), we need to find the part with properties
                  if (opaqueRefType.flags & ts.TypeFlags.Intersection) {
                    const intersectionType = opaqueRefType as ts.IntersectionType;
                    
                    // Find the object type with properties in the intersection
                    for (const type of intersectionType.types) {
                      if (type.flags & ts.TypeFlags.Object) {
                        const properties = type.getProperties();
                        
                        // Create individual property assignments
                        for (const property of properties) {
                          const propName = property.getName();
                          // Skip internal OpaqueRef methods
                          if (propName === 'get' || propName === 'set' || propName === 'key' || propName === 'map' || 
                              propName === 'setDefault' || propName === 'setName' || propName === 'setSchema' || 
                              propName === 'equals' || propName === 'update' || propName === 'push' || propName === 'send') {
                            continue;
                          }
                          
                          // Create property access expression
                          const propertyAccess = context.factory.createPropertyAccessExpression(
                            prop.expression,
                            propName
                          );
                          
                          newProperties.push(
                            context.factory.createPropertyAssignment(
                              propName,
                              propertyAccess
                            )
                          );
                        }
                      }
                    }
                  }
                } else {
                  // Keep non-OpaqueRef spreads as-is
                  newProperties.push(prop);
                }
              } else {
                // Keep non-spread properties as-is
                newProperties.push(prop);
              }
            }
            
            return context.factory.updateObjectLiteralExpression(
              node,
              newProperties
            );
          }
        }
        
        // Special handling for ternary expressions
        if (ts.isConditionalExpression(node)) {
          // Check if condition contains OpaqueRef (before transformation)
          const originalConditionType = checker.getTypeAtLocation(node.condition);
          const conditionContainsOpaqueRef = containsOpaqueRef(node.condition, checker);
          const conditionIsOpaqueRef = isOpaqueRefType(originalConditionType, checker);
          
          // First, visit all children to transform them
          const visitedCondition = ts.visitNode(node.condition, visit) as ts.Expression;
          const visitedWhenTrue = ts.visitNode(node.whenTrue, visit) as ts.Expression;
          const visitedWhenFalse = ts.visitNode(node.whenFalse, visit) as ts.Expression;
          
          // Create updated node with transformed children
          const updatedNode = context.factory.updateConditionalExpression(
            node,
            visitedCondition,
            node.questionToken,
            visitedWhenTrue,
            node.colonToken,
            visitedWhenFalse
          );
          
          // If the condition was/contained an OpaqueRef, or if it got transformed to a derive call
          if (conditionIsOpaqueRef || conditionContainsOpaqueRef || visitedCondition !== node.condition) {
            log(`Found ternary transformation at ${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
            
            if (mode === 'error') {
              reportError(node, 'ternary', 'Ternary operator with OpaqueRef condition should use ifElse()');
              return updatedNode;
            }
            
            hasTransformed = true;
            if (!hasCommonToolsImport(sourceFile, "ifElse")) {
              needsIfElseImport = true;
            }
            
            return createIfElseCall(updatedNode, context.factory, sourceFile);
          }
          
          return updatedNode;
        }
        
        // For other node types, check transformation first
        const result = checkTransformation(node, checker);
        
        if (result.transformed) {
          log(`Found ${result.type} transformation at ${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
          
          if (mode === 'error') {
            // In error mode, report the error but don't transform
            let message = '';
            switch (result.type) {
              case 'jsx':
                message = 'JSX expression with OpaqueRef computation should use derive()';
                break;
              case 'binary':
                message = 'Binary expression with OpaqueRef should use derive()';
                break;
              case 'call':
                message = 'Function call with OpaqueRef arguments should use .get()';
                break;
              case 'element-access':
                message = 'Array/object access with OpaqueRef index should use .get()';
                break;
              case 'template':
                message = 'Template literal with OpaqueRef should use .get()';
                break;
            }
            reportError(node, result.type!, message);
            return ts.visitEachChild(node, visit, context);
          }
          
          // In transform mode, apply the transformation
          hasTransformed = true;
          
          switch (result.type) {
            case 'jsx': {
              const jsxNode = node as ts.JsxExpression;
              
              // Check if this JSX expression is in an event handler attribute
              const parent = jsxNode.parent;
              if (parent && ts.isJsxAttribute(parent)) {
                const attrName = parent.name.getText();
                // Event handlers like onClick expect functions, not derived values
                if (attrName.startsWith('on')) {
                  // Just visit children normally for event handlers
                  return ts.visitEachChild(node, visit, context);
                }
              }
              
              const transformedExpression = transformExpressionWithOpaqueRef(
                jsxNode.expression!,
                checker,
                context.factory,
                sourceFile,
                context,
              );
              if (transformedExpression !== jsxNode.expression) {
                if (!hasCommonToolsImport(sourceFile, "derive")) {
                  needsDeriveImport = true;
                }
                return context.factory.updateJsxExpression(
                  jsxNode,
                  transformedExpression,
                );
              }
              break;
            }
            
            case 'binary': {
              const transformed = transformExpressionWithOpaqueRef(
                node as ts.Expression, 
                checker, 
                context.factory, 
                sourceFile, 
                context
              );
              if (transformed !== node) {
                if (!hasCommonToolsImport(sourceFile, "derive")) {
                  needsDeriveImport = true;
                }
                return transformed;
              }
              break;
            }
            
          }
        }

        return ts.visitEachChild(node, visit, context);
      };

      const visited = ts.visitNode(sourceFile, visit) as ts.SourceFile;

      // In error mode, throw if we found errors
      if (mode === 'error' && errors.length > 0) {
        const errorMessage = errors
          .map(e => `${e.file}:${e.line}:${e.column} - ${e.message}`)
          .join('\n');
        throw new Error(`OpaqueRef transformation errors:\n${errorMessage}`);
      }

      // Add necessary imports
      let result = visited;
      if (hasTransformed && mode === 'transform') {
        if (needsIfElseImport) {
          result = addCommonToolsImport(result, context.factory, "ifElse");
        }
        if (needsDeriveImport) {
          result = addCommonToolsImport(result, context.factory, "derive");
        }
        if (needsToSchemaImport) {
          result = addCommonToolsImport(result, context.factory, "toSchema");
        }
        
        // Log the transformed source if debug is enabled
        if (debug) {
          const printer = ts.createPrinter();
          const transformedSource = printer.printFile(result);
          log(`\n=== TRANSFORMED SOURCE ===\n${transformedSource}\n=== END TRANSFORMED SOURCE ===`);
        }
      }

      return result;
    };
  };
}

/**
 * Get the name of the function being called in a CallExpression
 */
function getFunctionName(node: ts.CallExpression): string | undefined {
  const expr = node.expression;
  
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  
  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text;
  }
  
  return undefined;
}

/**
 * Gets the list of transformation errors from the last run.
 * Only populated when mode is 'error'.
 */
export function getTransformationErrors(): TransformationError[] {
  // This would need to be implemented with proper state management
  // For now, it's a placeholder
  return [];
}