import {
  CastValidationTransformer,
  HtmlCommentValidationTransformer,
  ModuleScopeValidationTransformer,
  OpaqueGetValidationTransformer,
  OpaqueRefJSXTransformer,
  PatternContextValidationTransformer,
  SchemaGeneratorTransformer,
  SchemaInjectionTransformer,
} from "./transformers/mod.ts";
import { ClosureTransformer } from "./closures/transformer.ts";
import { ComputedTransformer } from "./computed/transformer.ts";
import { HoistingTransformer } from "./hoisting/mod.ts";
import {
  Pipeline,
  TransformationDiagnostic,
  TransformationOptions,
} from "./core/mod.ts";

export class CommonToolsTransformerPipeline extends Pipeline {
  private readonly diagnosticsCollector: TransformationDiagnostic[] = [];

  constructor(options: TransformationOptions = {}) {
    const ops: TransformationOptions = {
      typeRegistry: new WeakMap(),
      mapCallbackRegistry: new WeakSet(),
      schemaHints: new WeakMap(),
      ...options,
    };

    // Create a shared diagnostics collector
    const sharedOps: TransformationOptions = {
      ...ops,
      diagnosticsCollector: [],
    };

    // Build the transformer list based on options
    const transformers = [
      // Validation transformers run first to catch errors early
      new CastValidationTransformer(sharedOps),
      new OpaqueGetValidationTransformer(sharedOps),
      new PatternContextValidationTransformer(sharedOps),
      // SES validation
      new HtmlCommentValidationTransformer(sharedOps),
      new ModuleScopeValidationTransformer(sharedOps),
      // Then the regular transformation pipeline
      new OpaqueRefJSXTransformer(sharedOps),
      new ComputedTransformer(sharedOps),
      new ClosureTransformer(sharedOps),
      new SchemaInjectionTransformer(sharedOps),
      new SchemaGeneratorTransformer(sharedOps),
      // Hoisting: moves builder calls referencing module-scope symbols to module scope
      // Runs after all schema transformers so schemas are already injected
      new HoistingTransformer(sharedOps),
    ];

    super(transformers);

    // Store reference to shared collector
    // Note: We need to access it after construction, so we store the array reference
    this.diagnosticsCollector = sharedOps.diagnosticsCollector!;
  }

  /**
   * Returns all diagnostics collected during transformation.
   * Call this after running the pipeline to get errors and warnings.
   */
  getDiagnostics(): readonly TransformationDiagnostic[] {
    return this.diagnosticsCollector;
  }

  /**
   * Clears accumulated diagnostics.
   * Call this if reusing the pipeline for multiple files.
   */
  clearDiagnostics(): void {
    this.diagnosticsCollector.length = 0;
  }
}
