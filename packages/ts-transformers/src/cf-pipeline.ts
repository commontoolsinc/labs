import {
  CastValidationTransformer,
  EmptyArrayOfValidationTransformer,
  HelperOwnedExpressionSiteLoweringTransformer,
  JsxExpressionSiteRouterTransformer,
  ModuleScopeCfDataTransformer,
  ModuleScopeFunctionHardeningTransformer,
  ModuleScopeShadowingTransformer,
  OpaqueGetValidationTransformer,
  PatternCallbackLoweringTransformer,
  PatternContextValidationTransformer,
  PatternOwnedExpressionSiteLoweringTransformer,
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

export class CommonFabricTransformerPipeline extends Pipeline {
  private readonly diagnosticsCollector: TransformationDiagnostic[] = [];

  constructor(options: TransformationOptions = {}) {
    const ops: TransformationOptions = {
      typeRegistry: new WeakMap(),
      mapCallbackRegistry: new WeakSet(),
      syntheticComputeCallbackRegistry: new WeakSet(),
      syntheticComputeOwnedNodeRegistry: new WeakSet(),
      syntheticReactiveCollectionRegistry: new WeakSet(),
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
      // PatternContextValidation still enforces placement/standalone/get-call
      // rules while skipping the old computation/optional heuristics that were
      // tied to the removed legacy path.
      new CastValidationTransformer(sharedOps),
      new EmptyArrayOfValidationTransformer(sharedOps),
      new OpaqueGetValidationTransformer(sharedOps),
      new PatternContextValidationTransformer(sharedOps),
    ];

    transformers.push(
      // Then the regular transformation pipeline
      new JsxExpressionSiteRouterTransformer(sharedOps),
      new ComputedTransformer(sharedOps),
      new ClosureTransformer(sharedOps),
      new PatternOwnedExpressionSiteLoweringTransformer(sharedOps),
      new HelperOwnedExpressionSiteLoweringTransformer(sharedOps),
    );

    transformers.push(new PatternCallbackLoweringTransformer(sharedOps));

    transformers.push(
      new SchemaInjectionTransformer(sharedOps),
      new SchemaGeneratorTransformer(sharedOps),
      new ModuleScopeShadowingTransformer(sharedOps),
      new ModuleScopeCfDataTransformer(sharedOps),
      new ModuleScopeFunctionHardeningTransformer(sharedOps),
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
