import ts from "typescript";

import { normaliseDataFlows } from "../normalise.ts";
import type {
  Emitter,
  EmitterContext,
  EmitterResult,
  RewriteParams,
} from "./types.ts";
import { emitPropertyAccess } from "./property-access.ts";
import { emitBinaryExpression } from "./binary-expression.ts";
import { emitCallExpression } from "./call-expression.ts";
import { emitTemplateExpression } from "./template-expression.ts";
import { emitConditionalExpression } from "./conditional-expression.ts";
import { emitElementAccessExpression } from "./element-access-expression.ts";
import { emitContainerExpression } from "./container-expression.ts";
import { emitPrefixUnaryExpression } from "./prefix-unary-expression.ts";
import type { OpaqueRefHelperName } from "../transforms.ts";

const EMITTERS: readonly Emitter[] = [
  emitPropertyAccess,
  emitBinaryExpression,
  emitCallExpression,
  emitTemplateExpression,
  emitConditionalExpression,
  emitElementAccessExpression,
  emitPrefixUnaryExpression,
  emitContainerExpression,
];

function rewriteChildExpressions(
  node: ts.Expression,
  context: RewriteParams["context"],
  helpers: Set<OpaqueRefHelperName>,
): ts.Expression {
  const visitor = (child: ts.Node): ts.Node => {
    if (ts.isExpression(child)) {
      const analysis = context.analyze(child);
      if (analysis.containsOpaqueRef && analysis.requiresRewrite) {
        const result = rewriteExpression({
          expression: child,
          analysis,
          context,
        });
        if (result) {
          for (const helper of result.helpers) helpers.add(helper);
          return result.expression;
        }
      }
    }
    return ts.visitEachChild(child, visitor, context.transformation);
  };

  return ts.visitEachChild(
    node,
    visitor,
    context.transformation,
  ) as ts.Expression;
}

export function rewriteExpression(
  params: RewriteParams,
): EmitterResult | undefined {
  // Log what we have before normalization
  console.log(`[REWRITE] Expression: "${params.expression.getText()}"`);
  console.log(`[REWRITE] DataFlows from analysis: ${params.analysis.dataFlows.length}`);
  for (const df of params.analysis.dataFlows) {
    console.log(`  - "${df.getText()}"`);
  }
  console.log(`[REWRITE] Graph nodes: ${params.analysis.graph.nodes.length}`);
  for (const node of params.analysis.graph.nodes) {
    console.log(`  - Node ${node.id}: "${node.expression.getText()}" (parent: ${node.parentId}, explicit: ${node.isExplicit})`);
  }

  const dataFlows = normaliseDataFlows(
    params.analysis.graph,
    params.analysis.dataFlows,
  );

  console.log(`[REWRITE] After normalization: ${dataFlows.all.length} flows`);
  for (const flow of dataFlows.all) {
    console.log(`  - "${flow.expression.getText()}"`);
  }

  const helperSet = new Set<OpaqueRefHelperName>();
  const emitterContext: EmitterContext = {
    ...params.context,
    rewriteChildren(node: ts.Expression): ts.Expression {
      return rewriteChildExpressions(node, params.context, helperSet);
    },
  };
  for (const emitter of EMITTERS) {
    const result = emitter({
      expression: params.expression,
      dataFlows,
      analysis: params.analysis,
      context: emitterContext,
    });
    if (result) {
      for (const helper of result.helpers) helperSet.add(helper);
      return {
        expression: result.expression,
        helpers: new Set(helperSet),
      };
    }
  }
  return undefined;
}
