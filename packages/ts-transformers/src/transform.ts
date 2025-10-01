import * as ts from "typescript";
import { hasCtsEnableDirective } from "./core/cts-directive.ts";
import {
  createOpaqueRefJSXTransformer,
  createSchemaGeneratorTransformer,
  createSchemaInjectionTransformer,
} from "./transformers/mod.ts";

export function commonTypeScriptTransformer(
  program: ts.Program,
): ts.TransformerFactory<ts.SourceFile>[] {
  {
    const sourceFiles = program.getSourceFiles();
    if (!sourceFiles.some(hasCtsEnableDirective)) {
      return [];
    }
  }

  // Create a TypeRegistry scoped to this transformation pipeline
  // This allows schema-injection to pass Type information to schema-transformer
  const typeRegistry = new WeakMap<ts.Node, ts.Type>();

  return [
    createSchemaInjectionTransformer(program, { typeRegistry }),
    createOpaqueRefJSXTransformer(program, { typeRegistry }),
    createSchemaGeneratorTransformer(program, { typeRegistry }),
  ];
}
