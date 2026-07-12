import {
  BuilderCallHoistingTransformer,
  CastValidationTransformer,
  CfcPolicyAuthoringTransformer,
  EmptyArrayOfValidationTransformer,
  HelperOwnedExpressionSiteLoweringTransformer,
  JsxExpressionSiteRouterTransformer,
  MergeablePushValidationTransformer,
  ModuleScopeCfDataTransformer,
  ModuleScopeFunctionHardeningTransformer,
  ModuleScopeShadowingTransformer,
  OpaqueGetValidationTransformer,
  PatternCallbackLoweringTransformer,
  PatternContextValidationTransformer,
  PatternCoverageTransformer,
  PatternOwnedExpressionSiteLoweringTransformer,
  ReactiveVariableForTransformer,
  SchemaGeneratorTransformer,
  SchemaInjectionTransformer,
  WriteAuthorizedByValidationTransformer,
} from "./transformers/mod.ts";
import { ClosureTransformer } from "./closures/transformer.ts";
import { LiftLoweringTransformer } from "./lift/transformer.ts";
import {
  CrossStageState,
  Pipeline,
  TransformationDiagnostic,
  TransformationOptions,
  Transformer,
} from "./core/mod.ts";
import type { CfcPolicyCompilerManifestV1 } from "./core/runtime-contract.ts";

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
    name: "MergeablePushValidationTransformer",
    create: (options) => new MergeablePushValidationTransformer(options),
  },
  {
    name: "CfcPolicyAuthoringTransformer",
    create: (options) => new CfcPolicyAuthoringTransformer(options),
  },
  {
    name: "JsxExpressionSiteRouterTransformer",
    create: (options) => new JsxExpressionSiteRouterTransformer(options),
  },
  {
    name: "LiftLoweringTransformer",
    create: (options) => new LiftLoweringTransformer(options),
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
    name: "SchemaInjectionTransformer",
    create: (options) => new SchemaInjectionTransformer(options),
  },
  {
    name: "BuilderCallHoistingTransformer",
    create: (options) => new BuilderCallHoistingTransformer(options),
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
  // Coverage runs before function hardening. That keeps coverage counters out
  // of the hardening helper output. The transformer does no work unless
  // pattern coverage is enabled.
  {
    name: "PatternCoverageTransformer",
    create: (options) => new PatternCoverageTransformer(options),
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
  private readonly state: CrossStageState;

  constructor(options: TransformationOptions = {}) {
    const state = options.state ?? new CrossStageState();
    const ops: TransformationOptions = {
      state,
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
    this.state = state;
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

  getPolicyManifests(): ReadonlyMap<
    string,
    readonly CfcPolicyCompilerManifestV1[]
  > {
    return this.state.getPolicyManifests();
  }
}
