import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { rewriteHelperOwnedExpressionSites } from "./expression-site-lowering.ts";

export class HelperOwnedExpressionSiteLoweringTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.ctHelpers.sourceHasHelpers();
  }

  transform(context: TransformationContext): ts.SourceFile {
    return rewriteHelperOwnedExpressionSites(context.sourceFile, context);
  }
}
