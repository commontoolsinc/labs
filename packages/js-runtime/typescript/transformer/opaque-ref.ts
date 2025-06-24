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
  type: 'ternary' | 'jsx' | 'binary' | 'call' | 'element-access' | 'template';
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
  const { mode = 'transform', debug = false, logger = console.log } = options;
  const errors: TransformationError[] = [];

  return (context) => {
    return (sourceFile) => {
      let needsIfElseImport = false;
      let needsDeriveImport = false;
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
        // Handle function calls with OpaqueRef expressions in arguments
        if (ts.isCallExpression(node)) {
          // Check if any argument contains OpaqueRef expressions (not just simple refs)
          let hasOpaqueRefExpressions = false;
          for (const arg of node.arguments) {
            // Skip simple OpaqueRef identifiers or property accesses
            if (isSimpleOpaqueRefAccess(arg, checker)) {
              continue;
            }
            if (containsOpaqueRef(arg, checker)) {
              hasOpaqueRefExpressions = true;
              break;
            }
          }
          
          if (hasOpaqueRefExpressions) {
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
        
        // Handle template expressions
        if (ts.isTemplateExpression(node)) {
          let hasTransformedSpans = false;
          const transformedSpans = node.templateSpans.map(span => {
            if (containsOpaqueRef(span.expression, checker)) {
              hasTransformedSpans = true;
              const transformedExpression = addGetCallsToOpaqueRefs(
                span.expression,
                checker,
                context.factory,
                context
              ) as ts.Expression;
              return context.factory.updateTemplateSpan(
                span,
                transformedExpression,
                span.literal
              );
            }
            return span;
          });
          
          if (hasTransformedSpans) {
            log(`Found template expression transformation at ${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
            hasTransformed = true;
            return context.factory.updateTemplateExpression(
              node,
              node.head,
              transformedSpans
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
 * Gets the list of transformation errors from the last run.
 * Only populated when mode is 'error'.
 */
export function getTransformationErrors(): TransformationError[] {
  // This would need to be implemented with proper state management
  // For now, it's a placeholder
  return [];
}