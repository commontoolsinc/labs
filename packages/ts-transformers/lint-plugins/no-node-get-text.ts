// Forbids bare `node.getText()` (called with no SourceFile argument) in the
// transformer source.
//
// `ts.Node.getText()` reads the node's source positions, which are absent on
// synthetic nodes the transformer creates — so it throws at runtime on them.
// Use `getNodeText()` / `getExpressionText()` from `src/ast/utils.ts`, which
// print synthetic nodes instead. The `getText(sourceFile)` form is left alone:
// that is the sanctioned wrapper's own call.
//
// Test files are exempt: they assert against source parsed in the test, whose
// nodes always carry real positions, so `getText()` is safe and idiomatic there.
export default {
  name: "cf-ts-transformers",
  rules: {
    "no-node-get-text": {
      create(context) {
        if (context.filename.includes("/test/")) {
          return {};
        }
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (
              callee.type === "MemberExpression" &&
              !callee.computed &&
              callee.property.type === "Identifier" &&
              callee.property.name === "getText" &&
              node.arguments.length === 0
            ) {
              context.report({
                node,
                message:
                  "Bare node.getText() throws on synthetic AST nodes. Use " +
                  "getNodeText()/getExpressionText() from ast/utils.ts, or pass " +
                  "a SourceFile.",
              });
            }
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
