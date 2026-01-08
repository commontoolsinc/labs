/**
 * Cast Validation Transformer
 *
 * Validates type assertions (casts) and reports diagnostics for problematic patterns:
 * - `as unknown as X` (double-cast): ERROR - bypasses type safety
 * - `as OpaqueRef<...>`: ERROR - framework handles OpaqueRef wrapping automatically
 * - `as Cell<...>` and other cell-like types: WARNING - prefer proper type annotations
 */
import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";

/**
 * Cell-like types that should trigger a warning when cast to.
 * These types have special reactive semantics that casts can bypass.
 */
const CELL_LIKE_TYPE_NAMES = new Set([
  "Cell",
  "OpaqueCell",
  "Stream",
  "ComparableCell",
  "ReadonlyCell",
  "WriteonlyCell",
  "Writable",
  "CellTypeConstructor",
]);

/**
 * Types that should trigger an error when cast to.
 * Casting to these types is never allowed.
 */
const FORBIDDEN_CAST_TYPE_NAMES = new Set(["OpaqueRef"]);

export class CastValidationTransformer extends Transformer {
  transform(context: TransformationContext): ts.SourceFile {
    const visit = (node: ts.Node): ts.Node => {
      // Check for type assertions (both `as X` and `<X>` syntax)
      if (ts.isAsExpression(node)) {
        this.validateAsExpression(node, context);
      } else if (ts.isTypeAssertionExpression(node)) {
        this.validateTypeAssertion(node, context);
      }

      return ts.visitEachChild(node, visit, context.tsContext);
    };

    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }

  private validateAsExpression(
    node: ts.AsExpression,
    context: TransformationContext,
  ): void {
    // Check for double-cast pattern: `as unknown as X`
    if (this.isDoubleUnknownCast(node)) {
      context.reportDiagnostic({
        severity: "error",
        type: "cast-validation:double-unknown",
        message: "Double-casting via 'as unknown as' is not allowed. " +
          "Casts bypass reactive tracking and type safety.",
        node,
      });
      return;
    }

    // Check the target type of the cast
    this.validateCastTargetType(node.type, node, context);
  }

  private validateTypeAssertion(
    node: ts.TypeAssertion,
    context: TransformationContext,
  ): void {
    // Check for double-cast pattern with angle bracket syntax: `<X><unknown>expr`
    if (this.isDoubleUnknownTypeAssertion(node)) {
      context.reportDiagnostic({
        severity: "error",
        type: "cast-validation:double-unknown",
        message: "Double-casting via '<unknown>' is not allowed. " +
          "Casts bypass reactive tracking and type safety.",
        node,
      });
      return;
    }

    // Check the target type of the cast
    this.validateCastTargetType(node.type, node, context);
  }

  /**
   * Checks if this is a double-cast pattern: `expr as unknown as X`
   */
  private isDoubleUnknownCast(node: ts.AsExpression): boolean {
    // Check if inner expression is also an `as` expression casting to `unknown`
    if (ts.isAsExpression(node.expression)) {
      const innerType = node.expression.type;
      return this.isUnknownType(innerType);
    }
    return false;
  }

  /**
   * Checks if this is a double-cast with angle bracket syntax: `<X><unknown>expr`
   */
  private isDoubleUnknownTypeAssertion(
    node: ts.TypeAssertion,
  ): boolean {
    if (ts.isTypeAssertionExpression(node.expression)) {
      const innerType = node.expression.type;
      return this.isUnknownType(innerType);
    }
    return false;
  }

  /**
   * Checks if a type node represents the `unknown` type
   */
  private isUnknownType(typeNode: ts.TypeNode): boolean {
    return (
      typeNode.kind === ts.SyntaxKind.UnknownKeyword ||
      (ts.isTypeReferenceNode(typeNode) &&
        ts.isIdentifier(typeNode.typeName) &&
        typeNode.typeName.text === "unknown")
    );
  }

  /**
   * Validates the target type of a cast and reports appropriate diagnostics
   */
  private validateCastTargetType(
    typeNode: ts.TypeNode,
    castNode: ts.Node,
    context: TransformationContext,
  ): void {
    const typeName = this.extractTypeName(typeNode);
    if (!typeName) return;

    // Check for forbidden cast targets (ERROR)
    if (FORBIDDEN_CAST_TYPE_NAMES.has(typeName)) {
      context.reportDiagnostic({
        severity: "error",
        type: "cast-validation:forbidden-cast",
        message: `Casting to '${typeName}<>' is not allowed. ` +
          "The framework handles this type conversion automatically.",
        node: castNode,
      });
      return;
    }

    // Check for cell-like cast targets (WARNING)
    if (CELL_LIKE_TYPE_NAMES.has(typeName)) {
      context.reportDiagnostic({
        severity: "warning",
        type: "cast-validation:cell-cast",
        message: `Casting to '${typeName}<>' is discouraged. ` +
          "Consider using proper type annotations instead.",
        node: castNode,
      });
    }
  }

  /**
   * Extracts the base type name from a type node.
   * For example, `Cell<number>` returns "Cell", `OpaqueRef<Foo>` returns "OpaqueRef".
   */
  private extractTypeName(typeNode: ts.TypeNode): string | undefined {
    if (ts.isTypeReferenceNode(typeNode)) {
      const typeName = typeNode.typeName;
      if (ts.isIdentifier(typeName)) {
        return typeName.text;
      }
      // Handle qualified names like `Foo.Bar`
      if (ts.isQualifiedName(typeName)) {
        return typeName.right.text;
      }
    }
    return undefined;
  }
}
