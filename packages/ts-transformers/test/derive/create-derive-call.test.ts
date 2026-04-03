import { assertStringIncludes } from "@std/assert";
import ts from "typescript";

import { createDeriveCall } from "../../src/transformers/builtins/derive.ts";
import { CFHelpers } from "../../src/core/cf-helpers.ts";

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

    const cfHelpers = {
      getHelperExpr(name: string) {
        return factory.createPropertyAccessExpression(
          factory.createIdentifier("__cfHelpers"),
          name,
        );
      },
      createHelperCall(
        name: string,
        _originalNode: ts.Node,
        typeArguments: readonly ts.TypeNode[] | undefined,
        argumentsArray: readonly ts.Expression[],
      ) {
        return factory.createCallExpression(
          factory.createPropertyAccessExpression(
            factory.createIdentifier("__cfHelpers"),
            name,
          ),
          typeArguments,
          argumentsArray,
        );
      },
    } as unknown as CFHelpers;

    // Create a minimal program for type checking
    const program = ts.createProgram(["test.tsx"], {
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
    });
    const checker = program.getTypeChecker();

    const transformContext = {
      factory,
      tsContext: context,
      checker,
      sourceFile: source,
      cfHelpers,
      options: {
        typeRegistry: new WeakMap(),
      },
    } as any;

    const rootIdentifier = factory.createIdentifier("_v1");
    const fallbackExpr = factory.createParenthesizedExpression(rootIdentifier);

    const derive = createDeriveCall(fallbackExpr, [
      rootIdentifier,
      fallbackExpr,
    ], {
      factory,
      tsContext: context,
      cfHelpers,
      context: transformContext,
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
