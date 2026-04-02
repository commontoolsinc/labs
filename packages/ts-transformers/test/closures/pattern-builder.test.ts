import { assertEquals } from "@std/assert";
import ts from "typescript";

import { TransformationContext } from "../../src/core/mod.ts";
import type { CaptureTreeNode } from "../../src/utils/capture-tree.ts";
import { buildCallbackWithTopLevelCaptures } from "../../src/closures/utils/pattern-builder.ts";

function createProgramAndContext(source: string): {
  sourceFile: ts.SourceFile;
  context: TransformationContext;
} {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
  );

  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? source : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";

  const program = ts.createProgram([fileName], compilerOptions, host);
  const context = new TransformationContext({
    program,
    sourceFile,
    tsContext: { factory: ts.factory } as ts.TransformationContext,
    options: {
      typeRegistry: new WeakMap(),
      mapCallbackRegistry: new WeakSet(),
      syntheticComputeCallbackRegistry: new WeakSet(),
      syntheticComputeOwnedNodeRegistry: new WeakSet(),
      schemaHints: new WeakMap(),
      capabilitySummaryRegistry: new WeakMap(),
    },
  });

  return { sourceFile, context };
}

function findFirstNode<T extends ts.Node>(
  sourceFile: ts.SourceFile,
  predicate: (node: ts.Node) => node is T,
): T {
  let found: T | undefined;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!found) {
    throw new Error("Expected node not found");
  }

  return found;
}

Deno.test("buildCallbackWithTopLevelCaptures keeps rest bindings last", () => {
  const { sourceFile, context } = createProgramAndContext(`
    const callback = ({ item, ...rest }) => item;
  `);
  const originalCallback = findFirstNode(sourceFile, ts.isArrowFunction);
  const captureTree = new Map<string, CaptureTreeNode>([
    ["extra", { properties: new Map(), path: [] }],
  ]);

  const rebuilt = buildCallbackWithTopLevelCaptures(
    originalCallback,
    originalCallback.body,
    captureTree,
    context,
  );

  const paramName = rebuilt.parameters[0]?.name;
  if (!paramName || !ts.isObjectBindingPattern(paramName)) {
    throw new Error("Expected object binding parameter");
  }

  assertEquals(
    paramName.elements.map((element) =>
      ts.isIdentifier(element.name)
        ? `${element.dotDotDotToken ? "..." : ""}${element.name.text}`
        : element.getText(sourceFile)
    ),
    ["item", "extra", "...rest"],
  );
});
