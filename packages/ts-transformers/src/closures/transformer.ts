import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { visitEachChildWithJsx } from "../ast/mod.ts";
import { ActionStrategy } from "./strategies/action-strategy.ts";
import { MapStrategy } from "./strategies/map-strategy.ts";
import { DeriveStrategy } from "./strategies/derive-strategy.ts";
import { HandlerStrategy } from "./strategies/handler-strategy.ts";
import { PatternToolStrategy } from "./strategies/patternTool-strategy.ts";
import type { ClosureTransformationStrategy } from "./strategies/strategy.ts";

export class ClosureTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.ctHelpers.sourceHasHelpers();
  }

  transform(context: TransformationContext): ts.SourceFile {
    return transformClosures(context);
  }
}

function createClosureTransformVisitor(
  context: TransformationContext,
): ts.Visitor {
  const strategies: ClosureTransformationStrategy[] = [
    new HandlerStrategy(),
    new ActionStrategy(),
    new MapStrategy(),
    new PatternToolStrategy(),
    new DeriveStrategy(),
  ];

  const visit: ts.Visitor = (node: ts.Node) => {
    // Try to find a strategy that can transform this node
    for (const strategy of strategies) {
      if (strategy.canTransform(node, context)) {
        const transformed = strategy.transform(node, context, visit);
        if (transformed) {
          return transformed;
        }
      }
    }

    return visitEachChildWithJsx(node, visit, context.tsContext);
  };

  return visit;
}

function transformClosures(context: TransformationContext): ts.SourceFile {
  const { sourceFile } = context;

  const visitor = createClosureTransformVisitor(context);

  return ts.visitNode(sourceFile, visitor) as ts.SourceFile;
}
