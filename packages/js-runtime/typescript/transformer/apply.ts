import ts from "typescript";

import { createOpaqueRefTransformer, createSchemaTransformer } from "./mod.ts";
import { hasCtsEnableDirective } from "./utils.ts";

export interface ApplyCtsTransformOptions {
  readonly compilerOptions: ts.CompilerOptions;
  readonly showTransformed?: boolean;
  readonly logger?: (message: string) => void;
}

export interface ApplyCtsTransformResult {
  readonly changed: boolean;
  readonly printedSources: Map<string, string>;
}

export function applyCtsTransforms(
  program: ts.Program,
  options: ApplyCtsTransformOptions,
): ApplyCtsTransformResult {
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false,
  });
  const printedSources = new Map<string, string>();

  const factories: ts.TransformerFactory<ts.SourceFile>[] = [
    createOpaqueRefTransformer(program),
    createSchemaTransformer(program),
  ];

  let changed = false;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;

    if (!hasCtsEnableDirective(sourceFile)) {
      continue;
    }

    const transformResult = ts.transform(
      sourceFile,
      factories,
      options.compilerOptions,
    );
    const transformed = transformResult.transformed[0];
    transformResult.dispose();

    if (!transformed) {
      continue;
    }

    const printed = printer.printFile(transformed);
    printedSources.set(sourceFile.fileName, printed);

    if (!changed && printed !== sourceFile.getFullText()) {
      changed = true;
    }
  }

  if (options.showTransformed && options.logger) {
    for (const [fileName, contents] of printedSources) {
      options.logger(`\n=== TRANSFORMED SOURCE: ${fileName} ===`);
      options.logger(contents);
      options.logger(`=== END TRANSFORMED SOURCE ===`);
    }
  }

  return {
    changed,
    printedSources,
  };
}
