import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { rewritePatternOwnedExpressionSites } from "./expression-site-lowering.ts";

export class PatternOwnedExpressionSiteLoweringTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.ctHelpers.sourceHasHelpers();
  }

  transform(context: TransformationContext): ts.SourceFile {
    return rewritePatternOwnedExpressionSites(context.sourceFile, context);
  }
}
