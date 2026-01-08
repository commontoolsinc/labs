import {
  OpaqueRefJSXTransformer,
  SchemaGeneratorTransformer,
  SchemaInjectionTransformer,
} from "./transformers/mod.ts";
import { ClosureTransformer } from "./closures/transformer.ts";
import { ComputedTransformer } from "./computed/transformer.ts";
import { Pipeline, TransformationOptions } from "./core/mod.ts";

export class CommonToolsTransformerPipeline extends Pipeline {
  constructor(options: TransformationOptions = {}) {
    const ops = {
      typeRegistry: new WeakMap(),
      mapCallbackRegistry: new WeakSet(),
      schemaHints: new WeakMap(),
      ...options,
    };
    super([
      new OpaqueRefJSXTransformer(ops),
      new ComputedTransformer(ops),
      new ClosureTransformer(ops),
      new SchemaInjectionTransformer(ops),
      new SchemaGeneratorTransformer(ops),
    ]);
  }
}
