import { assertStringIncludes } from "@std/assert";
import ts from "typescript";

import { createDeriveCall } from "../../src/transformers/builtins/derive.ts";
import { CTHelpers } from "../../src/core/ct-helpers.ts";

Deno.test("createDeriveCall keeps fallback refs synced when names collide", () => {
  const source = ts.createSourceFile(
    "test.tsx",
    "",
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );

  let printed: string | undefined;

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const { factory } = context;

    const ctHelpers = {
      getHelperExpr(name: string) {
        return factory.createPropertyAccessExpression(
          factory.createIdentifier("__ctHelpers"),
          name,
        );
      },
    } as unknown as CTHelpers;

    const rootIdentifier = factory.createIdentifier("_v1");
    const fallbackExpr = factory.createParenthesizedExpression(rootIdentifier);

    const derive = createDeriveCall(fallbackExpr, [
      rootIdentifier,
      fallbackExpr,
    ], {
      factory,
      tsContext: context,
      ctHelpers,
    });

    if (!derive) {
      throw new Error("expected derive call");
    }

    const printer = ts.createPrinter();
    printed = printer.printNode(ts.EmitHint.Unspecified, derive, source);

    return (file) => file;
  };

  ts.transform(source, [transformer]);

  if (!printed) {
    throw new Error("derive call not printed");
  }

  assertStringIncludes(printed, "=> _v1_1");
});
