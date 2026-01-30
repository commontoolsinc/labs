import ts from "typescript";
import { Transformer } from "../core/transformers.ts";
import type { TransformationContext } from "../core/mod.ts";

/**
 * HtmlCommentValidationTransformer reports a diagnostic when source code
 * contains `<!--` or `-->` sequences.
 *
 * SES unconditionally rejects any source evaluated via `Compartment.evaluate()`
 * that contains HTML comment tokens, even inside string literals. This
 * transformer warns at compile time so authors can fix the source before it
 * reaches the runtime.
 */
export class HtmlCommentValidationTransformer extends Transformer {
  override transform(context: TransformationContext): ts.SourceFile {
    const { sourceFile } = context;
    const text = sourceFile.getFullText();

    // Quick bail-out: if neither marker appears in the full text there is
    // nothing to report.
    if (!text.includes("<!--") && !text.includes("-->")) {
      return sourceFile;
    }

    const visit = (node: ts.Node): ts.Node => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        this.checkText(node.text, node, context);
      } else if (ts.isTemplateExpression(node)) {
        // Check head and each template span's literal text
        this.checkText(node.head.text, node.head, context);
        for (const span of node.templateSpans) {
          this.checkText(span.literal.text, span.literal, context);
        }
      }
      return ts.visitEachChild(node, visit, context.tsContext);
    };

    return ts.visitNode(sourceFile, visit) as ts.SourceFile;
  }

  private checkText(
    value: string,
    node: ts.Node,
    context: TransformationContext,
  ): void {
    if (value.includes("<!--") || value.includes("-->")) {
      context.reportDiagnostic({
        node,
        type: "ses-html-comment",
        severity: "error",
        message:
          `String contains an HTML comment sequence ('<!--' or '-->') which SES will reject at runtime (SES_HTML_COMMENT_REJECTED). ` +
          `Split the literal to avoid the sequence, e.g. '<' + '!--'.`,
      });
    }
  }
}
