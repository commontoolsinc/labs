/**
 * Indirect Builder Callback Validation Transformer
 *
 * Reports a compile-time error when a trusted builder receives its callback
 * through a reference the module verifier cannot follow: a property access
 * (`handler(schema, state, callbacks.save)`) or a binding imported from
 * another module.
 *
 * The rule is not this stage's to choose. `verifyTrustedBuilderCall`
 * (`runner/src/sandbox/compiled-bundle-verifier.ts`, normative per §17.6)
 * admits a trusted builder's callback in exactly two spellings — a function
 * written at the call, or a plain identifier bound to a function in the same
 * module — and refuses to load a module that uses any other. Without this
 * stage the author learns that at load, from a verifier message phrased in
 * terms the pattern source never mentions. The check exists to move that
 * refusal to the compile that produced the module, where the offending
 * argument can be pointed at.
 *
 * Deliberately narrow in both directions. Only the argument the verifier
 * treats as the callback is judged, mirroring its per-builder positions, so a
 * trusted-builder result passed in a data position is never mistaken for a
 * miswritten callback. And an argument is judged only once it is
 * function-bearing by the checker's call signatures, so a call that passes
 * something else entirely keeps whatever diagnostic already describes it
 * rather than collecting a second, less accurate one.
 */

import ts from "typescript";
import { isTrustedBuilder } from "@commonfabric/utils/sandbox-contract";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import {
  detectCallKind,
  isCallbackReference,
  resolveCallbackFunctionExpression,
} from "../ast/call-kind.ts";
import { visitEachChildWithJsx } from "../ast/utils.ts";
import { unwrapExpression } from "../utils/expression.ts";

export class IndirectBuilderCallbackValidationTransformer
  extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const checker = context.checker;

    const visit = (node: ts.Node): ts.Node => {
      if (ts.isCallExpression(node)) {
        const callKind = detectCallKind(node, checker);
        if (callKind?.kind === "builder") {
          validateCallbackArgument(node, callKind.builderName, context);
        }
      }
      // JSX-aware: the stock visitor skips `JsxExpression.expression`, which
      // would exempt a builder authored inline in a JSX attribute.
      return visitEachChildWithJsx(node, visit, context.tsContext);
    };

    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }
}

function validateCallbackArgument(
  call: ts.CallExpression,
  builderName: string,
  context: TransformationContext,
): void {
  if (!isTrustedBuilder(builderName)) return;
  const checker = context.checker;
  const callback = callbackArgument(call, builderName, checker);
  if (!callback) return;
  // Not function-bearing at all: a different mistake, already described by
  // whatever rejects it. Saying "callback" about it would misname the problem.
  if (!isCallbackReference(callback, checker)) return;
  if (resolvesToSameModuleFunction(callback, call.getSourceFile(), checker)) {
    return;
  }
  context.reportDiagnostic({
    severity: "error",
    type: "builder-callback:indirect-reference",
    message:
      `This ${builderName} reaches its callback ${
        reachDescription(callback)
      }, ` +
      `which the module verifier cannot follow — the module would be refused ` +
      `at load. Give the function a name in this module and pass that name ` +
      `(\`const onSave = (…) => {…}\` … \`${builderName}(…, onSave)\`), or ` +
      `write the function at the call.`,
    node: callback,
  });
}

/**
 * The argument the verifier treats as the callback, mirroring
 * `callbackIndexesForBuilder`. `multiUserTest` is absent there — its
 * arguments are builder results — so it is absent here.
 */
function callbackArgument(
  call: ts.CallExpression,
  builderName: string,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  const args = call.arguments;
  switch (builderName) {
    case "pattern":
    case "action":
    case "computed":
    case "lift":
      return args[0];
    case "handler":
      // Function-first when the leading argument carries the callback,
      // schema-first otherwise.
      if (args.length >= 1 && isCallbackReference(args[0]!, checker)) {
        return args[0];
      }
      return args.length >= 3 ? args[2] : args[0];
    case "derive":
      return args.length >= 4 ? args[3] : args[1];
    default:
      return undefined;
  }
}

/** Whether the callback resolves to a function declared in this module. */
function resolvesToSameModuleFunction(
  argument: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): boolean {
  const resolved = resolveCallbackFunctionExpression(argument, checker);
  if (resolved && resolved.getSourceFile().fileName === sourceFile.fileName) {
    return true;
  }
  return sameModuleFunctionDeclaration(argument, sourceFile, checker) !==
    undefined;
}

/**
 * The `function` declaration an identifier names in this module, if any.
 * Declarations hoist, so the declaration may follow the use.
 */
function sameModuleFunctionDeclaration(
  argument: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ts.FunctionDeclaration | undefined {
  const target = unwrapExpression(argument);
  if (!ts.isIdentifier(target)) return undefined;
  const symbol = checker.getSymbolAtLocation(target);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration || !ts.isFunctionDeclaration(declaration)) return undefined;
  return declaration.getSourceFile().fileName === sourceFile.fileName
    ? declaration
    : undefined;
}

/** How the callback is reached, for the diagnostic's first clause. */
function reachDescription(argument: ts.Expression): string {
  const target = unwrapExpression(argument);
  if (
    ts.isPropertyAccessExpression(target) ||
    ts.isElementAccessExpression(target)
  ) {
    return "through a property access";
  }
  return "through a binding this module does not declare";
}
