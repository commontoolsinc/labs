import {
  BuilderCallbackHoistingTransformer,
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
  ReactiveVariableForTransformer,
  SchemaGeneratorTransformer,
  SchemaInjectionTransformer,
  WriteAuthorizedByValidationTransformer,
} from "./transformers/mod.ts";
import { ClosureTransformer } from "./closures/transformer.ts";
import { ComputedTransformer } from "./computed/transformer.ts";
import {
  Pipeline,
  TransformationDiagnostic,
  TransformationOptions,
  Transformer,
} from "./core/mod.ts";

type TransformerStageSpec = {
  readonly name: string;
  readonly create: (options: TransformationOptions) => Transformer;
};

const CFC_TRANSFORMER_STAGE_SPECS: readonly TransformerStageSpec[] = [
  {
    name: "CastValidationTransformer",
    create: (options) => new CastValidationTransformer(options),
  },
  {
    name: "EmptyArrayOfValidationTransformer",
    create: (options) => new EmptyArrayOfValidationTransformer(options),
  },
  {
    name: "OpaqueGetValidationTransformer",
    create: (options) => new OpaqueGetValidationTransformer(options),
  },
  {
    name: "PatternContextValidationTransformer",
    create: (options) => new PatternContextValidationTransformer(options),
  },
  {
    name: "JsxExpressionSiteRouterTransformer",
    create: (options) => new JsxExpressionSiteRouterTransformer(options),
  },
  {
    name: "ComputedTransformer",
    create: (options) => new ComputedTransformer(options),
  },
  {
    name: "ClosureTransformer",
    create: (options) => new ClosureTransformer(options),
  },
  {
    name: "PatternOwnedExpressionSiteLoweringTransformer",
    create: (options) =>
      new PatternOwnedExpressionSiteLoweringTransformer(options),
  },
  {
    name: "HelperOwnedExpressionSiteLoweringTransformer",
    create: (options) =>
      new HelperOwnedExpressionSiteLoweringTransformer(options),
  },
  {
    name: "WriteAuthorizedByValidationTransformer",
    create: (options) => new WriteAuthorizedByValidationTransformer(options),
  },
  {
    name: "PatternCallbackLoweringTransformer",
    create: (options) => new PatternCallbackLoweringTransformer(options),
  },
  {
    name: "BuilderCallbackHoistingTransformer",
    create: (options) => new BuilderCallbackHoistingTransformer(options),
  },
  {
    name: "SchemaInjectionTransformer",
    create: (options) => new SchemaInjectionTransformer(options),
  },
  {
    name: "SchemaGeneratorTransformer",
    create: (options) => new SchemaGeneratorTransformer(options),
  },
  {
    name: "ReactiveVariableForTransformer",
    create: (options) => new ReactiveVariableForTransformer(options),
  },
  {
    name: "ModuleScopeShadowingTransformer",
    create: (options) => new ModuleScopeShadowingTransformer(options),
  },
  {
    name: "ModuleScopeCfDataTransformer",
    create: (options) => new ModuleScopeCfDataTransformer(options),
  },
  {
    name: "ModuleScopeFunctionHardeningTransformer",
    create: (options) => new ModuleScopeFunctionHardeningTransformer(options),
  },
] as const;

export const CFC_TRANSFORMER_STAGE_NAMES = CFC_TRANSFORMER_STAGE_SPECS.map(
  (spec) => spec.name,
) as readonly string[];

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
    const transformers: Transformer[] = CFC_TRANSFORMER_STAGE_SPECS.map(
      (stage) => stage.create(sharedOps),
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
