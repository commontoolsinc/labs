import ts from "typescript";
import { Transformer } from "../core/transformers.ts";
import type { TransformationContext } from "../core/mod.ts";
import { detectCallKind } from "../ast/call-kind.ts";

/**
 * Builder function names that should have __exportName annotations.
 */
const ANNOTATABLE_BUILDERS = new Set([
  "pattern",
  "recipe",
  "lift",
  "handler",
]);

/**
 * ExportAnnotationTransformer adds __exportName annotations to exported builders.
 *
 * This transformer adds property assignments after export declarations to mark
 * the export name on the value. This allows the SES CompartmentManager to
 * discover exported patterns/recipes/lifts/handlers by inspecting the
 * __exportName property.
 *
 * @example
 * Input:
 * ```typescript
 * export const MyPattern = pattern<Input, Output>((props) => { ... });
 * ```
 *
 * Output:
 * ```typescript
 * export const MyPattern = pattern<Input, Output>((props) => { ... });
 * MyPattern.__exportName = "MyPattern";
 * ```
 *
 * This transformer only runs when `sesValidation` is enabled in options.
 */
export class ExportAnnotationTransformer extends Transformer {
  /**
   * Filter: Only run when SES validation is enabled.
   */
  override filter(context: TransformationContext): boolean {
    return context.options.sesValidation === true;
  }

  override transform(context: TransformationContext): ts.SourceFile {
    const { sourceFile, factory, checker } = context;
    const annotations: ts.Statement[] = [];

    // Visit each statement and collect annotations
    for (const statement of sourceFile.statements) {
      const stmtAnnotations = this.processStatement(
        statement,
        context,
        factory,
        checker,
      );
      annotations.push(...stmtAnnotations);
    }

    // If no annotations were created, return the original source
    if (annotations.length === 0) {
      return sourceFile;
    }

    // Insert annotations after their corresponding declarations
    const newStatements = this.insertAnnotations(
      sourceFile.statements,
      annotations,
    );

    return factory.updateSourceFile(sourceFile, newStatements);
  }

  /**
   * Process a statement and return any annotations it needs.
   */
  private processStatement(
    statement: ts.Statement,
    context: TransformationContext,
    factory: ts.NodeFactory,
    checker: ts.TypeChecker,
  ): ts.Statement[] {
    const annotations: ts.Statement[] = [];

    // Handle export variable statements: export const MyPattern = pattern(...)
    if (ts.isVariableStatement(statement)) {
      const hasExportModifier = statement.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );

      if (hasExportModifier) {
        for (const decl of statement.declarationList.declarations) {
          const annotation = this.createAnnotationForDeclaration(
            decl,
            context,
            factory,
            checker,
          );
          if (annotation) {
            annotations.push(annotation);
          }
        }
      }
    }

    // Handle default exports: export default pattern(...)
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const annotation = this.createAnnotationForDefaultExport(
        statement,
        context,
        factory,
        checker,
      );
      if (annotation) {
        annotations.push(annotation);
      }
    }

    // Handle named exports: export { MyPattern }
    // These reference existing declarations which should already be annotated

    return annotations;
  }

  /**
   * Create an annotation for a variable declaration.
   */
  private createAnnotationForDeclaration(
    decl: ts.VariableDeclaration,
    context: TransformationContext,
    factory: ts.NodeFactory,
    checker: ts.TypeChecker,
  ): ts.Statement | undefined {
    // Only annotate identifier declarations (not destructuring)
    if (!ts.isIdentifier(decl.name)) {
      return undefined;
    }

    const name = decl.name.text;
    const initializer = decl.initializer;

    if (!initializer) {
      return undefined;
    }

    // Check if the initializer is a call to an annotatable builder
    if (this.isAnnotatableBuilder(initializer, context, checker)) {
      return this.createAnnotationStatement(name, factory);
    }

    // Check if it's an IIFE that returns a builder
    // e.g., export const MyPattern = pattern(...)() (curried builder)
    if (ts.isCallExpression(initializer)) {
      const callee = initializer.expression;
      if (ts.isCallExpression(callee)) {
        if (this.isAnnotatableBuilder(callee, context, checker)) {
          return this.createAnnotationStatement(name, factory);
        }
      }
    }

    return undefined;
  }

  /**
   * Create an annotation for a default export.
   * Note: Default exports of builder calls don't have a variable name to annotate,
   * so we skip them. They should be refactored to use named exports for SES compatibility.
   */
  private createAnnotationForDefaultExport(
    _statement: ts.ExportAssignment,
    _context: TransformationContext,
    _factory: ts.NodeFactory,
    _checker: ts.TypeChecker,
  ): ts.Statement | undefined {
    // Default exports don't have a name we can annotate in the same way.
    // The pattern should be: export const Default = pattern(...); export default Default;
    // We return undefined here - the pattern context validation transformer
    // could warn about default exports of builders.
    return undefined;
  }

  /**
   * Check if an expression is a call to an annotatable builder.
   */
  private isAnnotatableBuilder(
    expr: ts.Expression,
    _context: TransformationContext,
    checker: ts.TypeChecker,
  ): boolean {
    if (!ts.isCallExpression(expr)) {
      return false;
    }

    const callKind = detectCallKind(expr, checker);
    if (callKind?.kind === "builder") {
      return ANNOTATABLE_BUILDERS.has(callKind.builderName);
    }

    return false;
  }

  /**
   * Create the annotation statement: Name.__exportName = "Name";
   */
  private createAnnotationStatement(
    name: string,
    factory: ts.NodeFactory,
  ): ts.Statement {
    return factory.createExpressionStatement(
      factory.createBinaryExpression(
        factory.createPropertyAccessExpression(
          factory.createIdentifier(name),
          factory.createIdentifier("__exportName"),
        ),
        ts.SyntaxKind.EqualsToken,
        factory.createStringLiteral(name),
      ),
    );
  }

  /**
   * Insert annotations into the statement list after their corresponding declarations.
   */
  private insertAnnotations(
    statements: ts.NodeArray<ts.Statement>,
    annotations: ts.Statement[],
  ): ts.Statement[] {
    // For simplicity, append all annotations at the end of the file.
    // They just need to run after the declarations.
    return [...statements, ...annotations];
  }
}
