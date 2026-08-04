import {
  AssertDiagnosticsTransformer,
  BuilderCallHoistingTransformer,
  CastValidationTransformer,
  CfcPolicyAuthoringTransformer,
  CfcPolicyOfValidationTransformer,
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
  VerbReturnValidationTransformer,
  WriteAuthorizedByValidationTransformer,
} from "./transformers/mod.ts";
import { ClosureTransformer } from "./closures/transformer.ts";
import ts from "typescript";
import { LiftLoweringTransformer } from "./lift/transformer.ts";
import {
  CrossStageState,
  TransformationDiagnostic,
  TransformationOptions,
  Transformer,
} from "./core/mod.ts";
import type { CfcPolicyCompilerManifestV1 } from "./core/runtime-contract.ts";

type TransformerStage = new (options: TransformationOptions) => Transformer;

const CFC_TRANSFORMER_STAGES: readonly TransformerStage[] = [
  CastValidationTransformer,
  EmptyArrayOfValidationTransformer,
  OpaqueGetValidationTransformer,
  PatternContextValidationTransformer,
  MergeablePushValidationTransformer,
  VerbReturnValidationTransformer,
  CfcPolicyAuthoringTransformer,
  CfcPolicyOfValidationTransformer,
  JsxExpressionSiteRouterTransformer,
  // Runs before lift lowering so it sees the authored expression: the operand
  // labels it records are the author's own source text, and the lowering that
  // follows rewrites the operands inside its capture calls as it would any
  // other reactive expression.
  AssertDiagnosticsTransformer,
  LiftLoweringTransformer,
  ClosureTransformer,
  PatternOwnedExpressionSiteLoweringTransformer,
  HelperOwnedExpressionSiteLoweringTransformer,
  WriteAuthorizedByValidationTransformer,
  PatternCallbackLoweringTransformer,
  SchemaInjectionTransformer,
  BuilderCallHoistingTransformer,
  SchemaGeneratorTransformer,
  ReactiveVariableForTransformer,
  ModuleScopeShadowingTransformer,
  ModuleScopeCfDataTransformer,
  // Coverage runs before function hardening. That keeps coverage counters out
  // of the hardening helper output. The transformer does no work unless
  // pattern coverage is enabled.
  PatternCoverageTransformer,
  ModuleScopeFunctionHardeningTransformer,
];

// The names come from the classes, so a stage rename reaches the spec-sync and
// pipeline-order tests without a second edit here.
export const CFC_TRANSFORMER_STAGE_NAMES: readonly string[] =
  CFC_TRANSFORMER_STAGES.map((stage) => stage.name);

export class CommonFabricTransformerPipeline {
  private readonly transformers: Transformer[];
  private readonly diagnosticsCollector: TransformationDiagnostic[];
  private readonly state: CrossStageState;

  constructor(options: TransformationOptions = {}) {
    const state = options.state ?? new CrossStageState();
    const ops: TransformationOptions = {
      ...options,
      state,
    };
    // Create a shared diagnostics collector
    const sharedOps: TransformationOptions = {
      ...ops,
      diagnosticsCollector: [],
    };
    this.transformers = CFC_TRANSFORMER_STAGES.map(
      (Stage) => new Stage(sharedOps),
    );

    // Store reference to shared collector
    // Note: We need to access it after construction, so we store the array reference
    this.diagnosticsCollector = sharedOps.diagnosticsCollector!;
    this.state = state;
  }

  toFactories(program: ts.Program): ts.TransformerFactory<ts.SourceFile>[] {
    return this.transformers.map((t) => t.toFactory(program));
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
