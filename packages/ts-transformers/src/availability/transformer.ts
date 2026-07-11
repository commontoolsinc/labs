import ts from "typescript";

import {
  detectCallKind,
  getLiftAppliedInputAndCallback,
} from "../ast/call-kind.ts";
import { HelpersOnlyTransformer } from "../core/transformers.ts";
import type { TransformationContext } from "../core/context.ts";
import {
  guardOperandExposesAvailability,
  parseAvailabilityObservation,
  resolveAvailabilityObservation,
} from "./analysis.ts";

function bindingPropertyName(
  element: ts.BindingElement,
): string | undefined {
  const name = element.propertyName ?? element.name;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ||
      ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function resolveCompositeInput(
  expression: ts.Expression,
  context: TransformationContext,
  seen: Set<ts.Symbol> = new Set(),
): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return current;
  const symbol = context.checker.getSymbolAtLocation(current);
  if (!symbol || seen.has(symbol)) return current;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return declaration && ts.isVariableDeclaration(declaration) &&
      declaration.initializer
    ? resolveCompositeInput(declaration.initializer, context, seen)
    : current;
}

function objectInputProperty(
  input: ts.Expression,
  propertyName: string,
  context: TransformationContext,
): ts.Expression | undefined {
  const target = resolveCompositeInput(input, context);
  if (!ts.isObjectLiteralExpression(target)) return undefined;
  for (const property of target.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === propertyName) return property.name;
      continue;
    }
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    if (
      (ts.isIdentifier(name) || ts.isStringLiteralLike(name) ||
        ts.isNumericLiteral(name)) && name.text === propertyName
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

function recordBindingObservation(
  binding: ts.BindingName,
  input: ts.Expression,
  context: TransformationContext,
): void {
  if (ts.isIdentifier(binding)) {
    const observation = resolveAvailabilityObservation(input, context);
    const symbol = context.checker.getSymbolAtLocation(binding);
    if (observation && symbol) {
      context.recordAvailabilityObservation(symbol, observation);
    }
    return;
  }

  if (ts.isObjectBindingPattern(binding)) {
    for (const element of binding.elements) {
      if (element.dotDotDotToken) continue;
      const propertyName = bindingPropertyName(element);
      if (!propertyName) continue;
      const propertyInput = objectInputProperty(input, propertyName, context);
      if (propertyInput) {
        recordBindingObservation(element.name, propertyInput, context);
      }
    }
    return;
  }

  const target = resolveCompositeInput(input, context);
  if (!ts.isArrayLiteralExpression(target)) return;
  binding.elements.forEach((element, index) => {
    if (!ts.isBindingElement(element)) return;
    const elementInput = target.elements[index];
    if (elementInput && ts.isExpression(elementInput)) {
      recordBindingObservation(element.name, elementInput, context);
    }
  });
}

function recordLiftAppliedParameterObservations(
  call: ts.CallExpression,
  context: TransformationContext,
): void {
  const resolved = getLiftAppliedInputAndCallback(call, context.checker);
  const parameter = resolved?.callback.parameters[0];
  if (!resolved || !parameter) return;
  recordBindingObservation(parameter.name, resolved.input, context);
}

export class AvailabilityAnalysisTransformer extends HelpersOnlyTransformer {
  override transform(context: TransformationContext): ts.SourceFile {
    const declarations: ts.VariableDeclaration[] = [];
    const liftAppliedCalls: ts.CallExpression[] = [];

    const collect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callKind = detectCallKind(node, context.checker);
        if (callKind?.kind === "lift-applied") {
          liftAppliedCalls.push(node);
        }
        if (callKind?.kind === "availability-observer") {
          const observation = parseAvailabilityObservation(node, context, true);
          if (observation) {
            context.recordAvailabilityObservation(node, observation);
          }
        } else if (callKind?.kind === "availability-guard") {
          // Explicit computations bypass direct guard-capture collection, so
          // retain the predicate's semantic variant type while the authored
          // call and signature are still available.
          const signature = context.checker.getResolvedSignature(node);
          const predicateType = signature
            ? context.checker.getTypePredicateOfSignature(signature)?.type
            : undefined;
          if (predicateType) {
            context.recordAvailabilityVariantType(
              callKind.variantTypeName,
              predicateType,
            );
          }
        }
      } else if (ts.isVariableDeclaration(node)) {
        declarations.push(node);
      }
      ts.forEachChild(node, collect);
    };
    collect(context.sourceFile);

    const propagateVariableObservations = (): void => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const declaration of declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
            continue;
          }
          const symbol = context.checker.getSymbolAtLocation(declaration.name);
          if (!symbol || context.lookupAvailabilityObservation(symbol)) {
            continue;
          }
          const observation = resolveAvailabilityObservation(
            declaration.initializer,
            context,
          );
          if (observation) {
            context.recordAvailabilityObservation(symbol, observation);
            changed = true;
          }
        }
      }
    };
    propagateVariableObservations();
    for (const call of liftAppliedCalls) {
      recordLiftAppliedParameterObservations(call, context);
    }
    // Parameter observation can unlock aliases declared inside the callback.
    propagateVariableObservations();

    const diagnose = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callKind = detectCallKind(node, context.checker);
        const reactiveContext = context.getReactiveContext(node);
        if (
          callKind?.kind === "availability-observer" &&
          reactiveContext.kind === "compute"
        ) {
          context.reportDiagnosticOnce({
            type: "availability:observation-inside-compute",
            message:
              "observeAvailability() must be outside the computed() or lift() callback whose input boundary it widens.",
            node,
          });
        } else if (
          callKind?.kind === "availability-guard" &&
          reactiveContext.kind === "compute"
        ) {
          const operand = node.arguments[0];
          const observation = operand
            ? resolveAvailabilityObservation(operand, context)
            : undefined;
          const variantType = context.lookupAvailabilityVariantType(
            callKind.variantTypeName,
          );
          const visible = operand
            ? guardOperandExposesAvailability(operand, variantType, context)
            : false;
          if (
            !visible && !observation?.reasons.includes(callKind.reason)
          ) {
            context.reportDiagnosticOnce({
              type: "availability:unobserved-compute-guard",
              message:
                `${callKind.variantTypeName} observation inside a compute requires an AsyncResult containing that variant. Guard the original AsyncResult, or call ` +
                `observeAvailability(value, "${callKind.reason}") outside that compute and capture the widened alias.`,
              node,
            });
          }
        }
      }
      ts.forEachChild(node, diagnose);
    };
    diagnose(context.sourceFile);

    return context.sourceFile;
  }
}
