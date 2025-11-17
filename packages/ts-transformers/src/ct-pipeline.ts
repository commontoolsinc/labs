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
      ...options,
    };
    super([
      new ComputedTransformer(ops),
      new ClosureTransformer(ops),
      new OpaqueRefJSXTransformer(ops),
      new SchemaInjectionTransformer(ops),
      new SchemaGeneratorTransformer(ops),
    ]);
  }
}
