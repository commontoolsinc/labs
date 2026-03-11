import {
  CapabilityLoweringTransformer,
  CastValidationTransformer,
  EmptyArrayOfValidationTransformer,
  OpaqueGetValidationTransformer,
  OpaqueRefJSXTransformer,
  PatternContextValidationTransformer,
  SchemaGeneratorTransformer,
  SchemaInjectionTransformer,
} from "./transformers/mod.ts";
import { ClosureTransformer } from "./closures/transformer.ts";
import { ComputedTransformer } from "./computed/transformer.ts";
import {
  Pipeline,
  TransformationDiagnostic,
  TransformationOptions,
  Transformer,
} from "./core/mod.ts";

export class CommonToolsTransformerPipeline extends Pipeline {
  private readonly diagnosticsCollector: TransformationDiagnostic[] = [];

  constructor(options: TransformationOptions = {}) {
    const ops: TransformationOptions = {
      typeRegistry: new WeakMap(),
      mapCallbackRegistry: new WeakSet(),
      reactiveContextOverrideRegistry: new WeakMap(),
      schemaHints: new WeakMap(),
      capabilitySummaryRegistry: new WeakMap(),
      ...options,
    };
    // Create a shared diagnostics collector
    const sharedOps: TransformationOptions = {
      ...ops,
      diagnosticsCollector: [],
    };

    const transformers: Transformer[] = [
      // Validation transformers run first to catch errors early.
      // PatternContextValidation runs in both modes. In capability-first mode
      // it still enforces placement/standalone/get-call rules while skipping
      // legacy computation/optional heuristics.
      new CastValidationTransformer(sharedOps),
      new EmptyArrayOfValidationTransformer(sharedOps),
      new OpaqueGetValidationTransformer(sharedOps),
      new PatternContextValidationTransformer(sharedOps),
    ];

    transformers.push(
      // Then the regular transformation pipeline
      new OpaqueRefJSXTransformer(sharedOps),
      new ComputedTransformer(sharedOps),
      new ClosureTransformer(sharedOps),
    );

    transformers.push(new CapabilityLoweringTransformer(sharedOps));

    transformers.push(
      new SchemaInjectionTransformer(sharedOps),
      new SchemaGeneratorTransformer(sharedOps),
    );

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
