import { assertEquals } from "@std/assert";
import ts from "typescript";

import { PatternStrategy } from "../src/closures/strategies/pattern-strategy.ts";
import type { TransformationContext } from "../src/core/mod.ts";
import { getCallbackBoundarySemantics } from "../src/policy/callback-boundary.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, parseModule } from "./transformed-ast.ts";
import { batchTypeCheckFixtures, transformSource } from "./utils.ts";

const SOURCE = `
import {
  pattern,
  patternTool,
  type PatternFactory,
} from "commonfabric";

interface Item {
  element: string;
}

export default pattern<{ items: Item[]; local: string }>(({ items, local }) => ({
  tool: patternTool(
    ((pattern(() => ({ local })) as PatternFactory<any, any>) satisfies PatternFactory<any, any>)!,
  ),
  rows: items.mapWithPattern(
    ((pattern(({ element }: Item) => ({ element, local })) as PatternFactory<any, any>) satisfies PatternFactory<any, any>)!,
    { local },
  ),
}));
`;

async function sourceProgram(): Promise<{
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
}> {
  const { program } = await batchTypeCheckFixtures(
    { "/test.tsx": SOURCE },
    { types: COMMONFABRIC_TYPES },
  );
  const sourceFile = program.getSourceFile("/test.tsx");
  if (!sourceFile) throw new Error("Expected source file");
  return { sourceFile, checker: program.getTypeChecker() };
}

function authoredPatternCalls(sourceFile: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "pattern"
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

Deno.test("legacy pattern carriers stay outside PatternStrategy through transparent wrappers and cloning", async () => {
  const { sourceFile, checker } = await sourceProgram();
  const [, patternToolPattern, withPatternPattern] = authoredPatternCalls(
    sourceFile,
  );
  if (!patternToolPattern || !withPatternPattern) {
    throw new Error("Expected both nested legacy pattern calls");
  }

  const context = { checker } as TransformationContext;
  const strategy = new PatternStrategy();
  for (const call of [patternToolPattern, withPatternPattern]) {
    assertEquals(strategy.canTransform(call, context), false);

    const clone = ts.factory.createCallExpression(
      call.expression,
      call.typeArguments,
      call.arguments,
    );
    ts.setOriginalNode(clone, call);
    assertEquals(
      strategy.canTransform(clone, context),
      false,
      "a detached clone must recover its legacy carrier from authored ancestry",
    );
  }
});

Deno.test("wrapped patternTool patterns retain the pattern-tool callback boundary", async () => {
  const { sourceFile, checker } = await sourceProgram();
  const [, patternToolPattern] = authoredPatternCalls(sourceFile);
  const callback = patternToolPattern?.arguments[0];
  if (!callback || !ts.isArrowFunction(callback)) {
    throw new Error("Expected wrapped patternTool pattern callback");
  }

  const decision = getCallbackBoundarySemantics(callback, checker).decision;
  assertEquals(
    decision.kind === "supported" ? decision.boundaryKind : decision.kind,
    "pattern-tool",
  );
});

Deno.test("legacy wrapped pattern carriers never emit compiler curry state", async () => {
  const output = await transformSource(SOURCE, {
    types: COMMONFABRIC_TYPES,
  });
  const root = parseModule(output);

  assertEquals(callsNamed(root, "withPatternParamsSchema").length, 0, output);
  assertEquals(callsNamed(root, "curry").length, 0, output);
  assertEquals(callsNamed(root, "patternTool").length, 1, output);
  assertEquals(callsNamed(root, "mapWithPattern").length, 1, output);
});
