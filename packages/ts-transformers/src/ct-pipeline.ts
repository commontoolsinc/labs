import {
  OpaqueRefJSXTransformer,
  SchemaGeneratorTransformer,
  SchemaInjectionTransformer,
} from "./transformers/mod.ts";
import { ClosureTransformer } from "./closures/transformer.ts";
import { Pipeline, TransformationOptions, TypeRegistry } from "./core/mod.ts";

export class CommonToolsTransformerPipeline extends Pipeline {
  constructor(options: TransformationOptions = {}) {
    const ops = {
      typeRegistry: new WeakMap(),
      ...options,
    };
    super([
      new ClosureTransformer(ops),
      new SchemaInjectionTransformer(ops),
      new OpaqueRefJSXTransformer(ops),
      new SchemaGeneratorTransformer(ops),
    ]);
  }
}
