/**
 * CommonTools transformer pipeline.
 *
 * CACHE_VERSION: Changes to this pipeline or any of its transformers affect compiled output.
 * Bump CACHE_VERSION in packages/runner/src/harness/compilation-cache.ts when:
 * - Adding, removing, or reordering transformers
 * - Modifying any transformer in this pipeline
 */
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
      new OpaqueRefJSXTransformer(ops),
      new ComputedTransformer(ops),
      new ClosureTransformer(ops),
      new SchemaInjectionTransformer(ops),
      new SchemaGeneratorTransformer(ops),
    ]);
  }
}
