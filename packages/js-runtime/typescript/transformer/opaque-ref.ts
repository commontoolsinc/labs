import ts from "typescript";
import { isOpaqueRefType } from "./types.ts";
import { 
  addDeriveImport, 
  addIfElseImport, 
  hasDeriveImport, 
  hasIfElseImport 
} from "./imports.ts";
import { 
  checkTransformation, 
  createIfElseCall, 
  transformExpressionWithOpaqueRef 
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
  type: 'ternary' | 'jsx' | 'binary';
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

      const reportError = (node: ts.Node, type: 'ternary' | 'jsx' | 'binary', message: string) => {
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
        const result = checkTransformation(node, checker);
        
        if (result.transformed) {
          log(`Found ${result.type} transformation at ${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
          
          if (mode === 'error') {
            // In error mode, report the error but don't transform
            let message = '';
            switch (result.type) {
              case 'ternary':
                message = 'Ternary operator with OpaqueRef condition should use ifElse()';
                break;
              case 'jsx':
                message = 'JSX expression with OpaqueRef computation should use derive()';
                break;
              case 'binary':
                message = 'Binary expression with OpaqueRef should use derive()';
                break;
            }
            reportError(node, result.type!, message);
            return ts.visitEachChild(node, visit, context);
          }
          
          // In transform mode, apply the transformation
          hasTransformed = true;
          
          switch (result.type) {
            case 'ternary': {
              if (!hasIfElseImport(sourceFile)) {
                needsIfElseImport = true;
              }
              return createIfElseCall(
                node as ts.ConditionalExpression, 
                context.factory, 
                sourceFile
              );
            }
            
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
                if (!hasDeriveImport(sourceFile)) {
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
                if (!hasDeriveImport(sourceFile)) {
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
          result = addIfElseImport(result, context.factory);
        }
        if (needsDeriveImport) {
          result = addDeriveImport(result, context.factory);
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