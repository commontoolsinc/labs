/**
 * HoistingTransformer: Hoists builder calls that reference module-scope
 * symbols to module scope for SES compartment safety.
 *
 * This transformer runs AFTER the ClosureTransformer (which makes local
 * closures into explicit params) and BEFORE SchemaInjectionTransformer.
 *
 * It finds derive/lift/handler/action calls that are NOT already at module
 * scope and whose callbacks reference module-scope symbols (imports,
 * module-scope consts, module-scope functions). These calls are hoisted
 * to module scope as const declarations.
 *
 * Example:
 *   // Before (inside a pattern/recipe body):
 *   const doubled = derive(props.value, (v) => someUtil(v) * CONFIG.factor);
 *
 *   // After hoisting:
 *   const __derive_0 = derive;  // hoisted call reference
 *   // ... and the HoistingContext records the full call for later prepending
 */
import ts from "typescript";
import { detectCallKind } from "../ast/call-kind.ts";
import { isFunctionLikeExpression } from "../ast/function-predicates.ts";
import {
  type TransformationOptions,
  Transformer,
} from "../core/transformers.ts";
import type { TransformationContext } from "../core/context.ts";
import { referencesModuleScopeSymbols } from "./hoisting-context.ts";

/**
 * Set of builder names whose calls can be hoisted.
 */
const HOISTABLE_BUILDERS = new Set([
  "derive",
  "lift",
  "handler",
  "action",
  "computed",
]);

/**
 * Map builder names to hoisted declaration types.
 */
function builderToHoistType(
  builderName: string,
): "lift" | "handler" | "derive" {
  switch (builderName) {
    case "handler":
    case "action":
      return "handler";
    case "lift":
      return "lift";
    default:
      return "derive";
  }
}

export class HoistingTransformer extends Transformer {
  constructor(options: TransformationOptions = {}) {
    super(options);
  }

  override filter(context: TransformationContext): boolean {
    // Run when hoistingContext exists (always initialized now)
    return !!context.hoistingContext;
  }

  override transform(context: TransformationContext): ts.SourceFile {
    const { sourceFile, factory, checker } = context;
    const hoistingContext = context.hoistingContext!;

    // Collect hoisted declarations
    const hoistedStatements: ts.Statement[] = [];

    const visitor: ts.Visitor = (node: ts.Node): ts.Node => {
      // Skip module-scope statements — those are already at module scope
      if (ts.isSourceFile(node)) {
        return ts.visitEachChild(node, visitor, context.tsContext);
      }

      // Look for call expressions that are builder calls
      if (!ts.isCallExpression(node)) {
        return ts.visitEachChild(node, visitor, context.tsContext);
      }

      const callKind = detectCallKind(node, checker);
      if (!callKind) {
        return ts.visitEachChild(node, visitor, context.tsContext);
      }

      // Skip synthetic nodes created by other transformers (pos === -1)
      if (node.pos === -1) {
        return ts.visitEachChild(node, visitor, context.tsContext);
      }

      // Check if this is a hoistable builder call
      const builderName = callKind.kind === "builder"
        ? callKind.builderName
        : callKind.kind === "derive"
        ? "derive"
        : undefined;

      if (!builderName || !HOISTABLE_BUILDERS.has(builderName)) {
        return ts.visitEachChild(node, visitor, context.tsContext);
      }

      // Check if this call is already at module scope
      if (isAtModuleScope(node)) {
        return ts.visitEachChild(node, visitor, context.tsContext);
      }

      // Find the callback argument
      const callback = findCallbackArg(node);
      if (!callback) {
        return ts.visitEachChild(node, visitor, context.tsContext);
      }

      // Check if callback references module-scope symbols
      if (!referencesModuleScopeSymbols(callback, checker)) {
        return ts.visitEachChild(node, visitor, context.tsContext);
      }

      // First, visit children so nested hoistable calls are processed
      const visited = ts.visitEachChild(
        node,
        visitor,
        context.tsContext,
      ) as ts.CallExpression;

      // Hoist this call: create a module-scope const declaration
      const hoistType = builderToHoistType(builderName);
      const hoistedName = hoistingContext.generateUniqueName(hoistType);

      // Create: const __derive_0 = <the full call expression>;
      const hoistedDecl = factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [
            factory.createVariableDeclaration(
              factory.createIdentifier(hoistedName),
              undefined,
              undefined,
              visited,
            ),
          ],
          ts.NodeFlags.Const,
        ),
      );

      hoistedStatements.push(hoistedDecl);

      // Register in hoisting context for tracking
      hoistingContext.registerHoistedDeclaration(
        hoistedDecl,
        hoistType,
        node,
      );

      // Replace the original call with just the hoisted identifier
      return factory.createIdentifier(hoistedName);
    };

    // Run the visitor
    const transformed = ts.visitNode(sourceFile, visitor) as ts.SourceFile;

    // If no hoisting happened, return as-is
    if (hoistedStatements.length === 0) {
      return transformed;
    }

    // Prepend hoisted statements to the file
    return factory.updateSourceFile(transformed, [
      ...hoistedStatements,
      ...transformed.statements,
    ]);
  }
}

/**
 * Check if a node is at module scope.
 * Uses the depth tracking from the visitor rather than parent pointers,
 * since parent pointers may be stale after earlier transforms.
 */
function isAtModuleScope(node: ts.Node): boolean {
  // Walk up the parent chain. If we hit a function-like node before
  // reaching SourceFile, we're NOT at module scope.
  // If parents are broken (null), fall back to assuming not at module scope
  // (safer to skip hoisting than to hoist incorrectly).
  let current = node.parent;
  let depth = 0;
  while (current) {
    if (ts.isSourceFile(current)) {
      return true;
    }
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    ) {
      return false;
    }
    current = current.parent;
    depth++;
    // Safety: if we've walked too deep without finding SourceFile, bail
    if (depth > 50) return false;
  }
  // Parent chain broken — conservatively assume module scope
  // (skip hoisting rather than incorrectly hoisting module-level code)
  return true;
}

/**
 * Find the callback (function-like) argument in a builder call.
 * Different builders put the callback at different positions.
 */
function findCallbackArg(
  call: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  // Search arguments for the last function-like expression
  for (let i = call.arguments.length - 1; i >= 0; i--) {
    const arg = call.arguments[i];
    if (arg && isFunctionLikeExpression(arg)) {
      return arg as ts.ArrowFunction | ts.FunctionExpression;
    }
  }
  return undefined;
}
