import * as ts from "typescript";
import { hasCtsEnableDirective } from "./cts-directive.ts";
import { createModularOpaqueRefTransformer } from "./opaque-ref/transformer.ts";
import { createSchemaTransformer } from "./schema/schema-transformer.ts";
import { TypeRegistry } from "./core/type-registry.ts";

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
    createModularOpaqueRefTransformer(program, { typeRegistry }),
    createSchemaTransformer(program, { typeRegistry }),
  ];
}
