import * as ts from "typescript";
import { hasCtsEnableDirective } from "./cts-directive.ts";
import { createModularOpaqueRefTransformer } from "./opaque-ref/transformer.ts";
import { createSchemaTransformer } from "./schema/schema-transformer.ts";

export function commonTypeScriptTransformer(
  program: ts.Program,
): ts.TransformerFactory<ts.SourceFile>[] {
  {
    const sourceFiles = program.getSourceFiles();
    if (!sourceFiles.some(hasCtsEnableDirective)) {
      return [];
    }
  }

  return [
    createModularOpaqueRefTransformer(program),
    createSchemaTransformer(program),
  ];
}
