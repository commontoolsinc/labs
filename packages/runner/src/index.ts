export { Runtime } from "./runtime.ts";
export type {
  ConsoleHandler,
  ErrorHandler,
  ErrorWithContext as RuntimeErrorWithContext,
  ExperimentalOptions, // Space-model feature flags; see ExperimentalOptions in runtime.ts
  RuntimeFetch,
  RuntimeOptions,
  SpaceCellContents,
} from "./runtime.ts";
export {
  type BrowserWorkerPresetParams,
  type EnvReader,
  EXPERIMENTAL_ENV_VARS,
  experimentalOptionsFromEnv,
  type PatternTestPresetParams,
  type ProductionServerPresetParams,
  type RemoteClientPresetParams,
  RUNTIME_OPTION_KEYS,
  type RuntimeOptionKey,
  runtimePresets,
  type UnitTestPresetParams,
} from "./runtime-presets.ts";
export type {
  UnsafeHostTrust,
  UnsafeHostTrustOptions,
} from "./unsafe-host-trust.ts";
export * from "./interface.ts";
export { raw } from "./module.ts";
export type { Cell, Stream } from "./cell.ts";
export type { NormalizedLink } from "./link-types.ts";
export type { SigilLink, URI } from "./sigil-types.ts";
export {
  createRef,
  type EntityId,
  entityIdFrom,
  getEntityId,
} from "./create-ref.ts";
export type { CellResult as QueryResult } from "./query-result-proxy.ts";
export type {
  Action,
  ErrorWithContext,
  ReactivityLog,
  SettleStats,
} from "./scheduler.ts";
export * as StorageInspector from "./storage/inspector.ts";
export { StorageTelemetry } from "./storage/telemetry.ts";
export type {
  ChangeGroup,
  IExtendedStorageTransaction,
  MemorySpace,
} from "./storage/interface.ts";
export {
  debugTransactionWrites,
  formatTransactionSummary,
  summarizeTransaction,
  type TransactionSummary,
} from "./storage/transaction-summary.ts";
export {
  convertCellsToLinks,
  isCell,
  isReadableCell,
  isStream,
} from "./cell.ts";
export {
  getCellOrThrow,
  isCellResult,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
export { effect } from "./reactivity.ts";
export { type AddCancel, type Cancel, noOp, useCancelGroup } from "./cancel.ts";
export {
  computeEntryIdentity,
  Console,
  type ConsoleEvent,
  ConsoleMethod,
  Engine,
  resolveEntryIdentity,
  type RuntimeProgram,
  type TypeScriptHarnessProcessOptions,
} from "./harness/index.ts";
export {
  PATTERN_COVERAGE_INTEGRATION_TEST_NAME,
  PATTERN_COVERAGE_TEST_NAME,
  PatternCoverageCollector,
  type PatternCoverageData,
  type PatternCoverageFileReport,
  type PatternCoverageKind,
  patternCoverageOutputPath,
  type PatternCoverageReport,
  type PatternCoverageReportOptions,
  patternCoverageReportToLcov,
  type PatternCoverageSpan,
  writePatternCoverageLcov,
} from "./pattern-coverage.ts";
export { addCommonIDfromObjectID } from "./data-updating.ts";
export {
  type BlindStructuralTarget,
  isRendererInputTx,
  markRendererInputTx,
  markUiInputBlindWriteTx,
  setBlindStructuralTarget,
  unmarkUiInputBlindWriteTx,
} from "./storage/reactivity-log.ts";
export { classifyTelemetryWriteCounts } from "./scheduler/reactivity.ts";
export { resolveLink } from "./link-resolution.ts";
export {
  areLinksSame,
  getMetaLink,
  isCellLink as isLink,
  isWriteRedirectLink,
  KeepAsCell,
  parseLink,
  parseLinkOrThrow,
  parseLLMFriendlyLink,
  sanitizeSchemaForLinks,
} from "./link-utils.ts";
export * from "./pattern-manager.ts";
export {
  type PatternUpdateOutcome,
  PatternUpdater,
} from "./pattern-updater.ts";
export {
  asPatternIdentityRef,
  extractDefaultValues,
  getPatternIdentityRef,
  getPatternRepository,
  getPatternSource,
  mergeSchemaDefaults,
  patternIdentityKey,
  schemaAcceptsOpaqueCellValue,
  schemaHasDefaultValue,
  setPatternRepository,
  setPatternSource,
} from "./runner.ts";

// Builder functionality (migrated from @commonfabric/builder package)
export { createBuilder, type CreateBuilderOptions } from "./builder/factory.ts";
export type {
  BuilderFunctionsAndConstants as BuilderFunctions,
  BuilderRuntime,
} from "./builder/types.ts";

// Internal functions and exports needed by other packages
export {
  getPatternEnvironment,
  getPatternEnvironment as builderGetPatternEnvironment,
  type PatternEnvironment,
  setPatternEnvironment,
  setPatternEnvironment as builderSetPatternEnvironment,
} from "./builder/env.ts";
export {
  getTopFrame,
  patternFromFrame,
  popFrame,
  pushFrame,
  pushFrameFromCause,
} from "./builder/pattern.ts";
export {
  AuthSchema,
  type Cell as BuilderCell,
  CHIP_UI,
  type FactoryInput,
  type Frame,
  FS,
  type FsProjection,
  type HandlerFactory,
  ID,
  ID_FIELD,
  isModule,
  isPattern,
  isReactive,
  isStreamValue,
  type JSONObject,
  type JSONSchema,
  type JSONSchemaObjMutable,
  type JSONValue,
  type Module,
  type ModuleFactory,
  NAME,
  type NodeFactory,
  OAuth2TokenSchema,
  type Pattern,
  type PatternFactory,
  type Props,
  type Reactive,
  type RenderNode,
  type Schema,
  schema,
  type SchemaWithoutCell,
  type StreamValue,
  TILE_UI,
  type toJSON,
  TYPE,
  UI,
  type UnsafeBinding,
  type VNode,
  WebhookConfigSchema,
} from "./builder/types.ts";
export { createNodeFactory } from "./builder/module.ts";
export { reactive as cell } from "./builder/reactive.ts";
export {
  CFC_ATOM_TYPE,
  CFC_CONCEPT_KIND,
  CFC_FUSE_ATOM_CLASS,
  CFC_RUNTIME_SUBJECT,
  cfcAtom,
  ContextualFlowControl,
} from "./cfc.ts";
export type { Mutable } from "@commonfabric/utils/types";
export {
  type HostRuntimeTelemetryMarker,
  type HostSchedulerEventPreflightStats,
  RuntimeTelemetry,
  RuntimeTelemetryEvent,
  type RuntimeTelemetryMarker,
  type RuntimeTelemetryMarkerResult,
  type SchedulerEventPreflightStats,
  type SchedulerGraphEdge,
  type SchedulerGraphNode,
  type SchedulerGraphSnapshot,
} from "./telemetry.ts";
// Export the bridge TYPES from the barrel, but NOT its values. A static value
// re-export would pull telemetry-otel-bridge.ts -> @opentelemetry/api (whose node
// platform build does `require("perf_hooks")`) into every bundle that imports the
// runner barrel, including the browser web-worker — which breaks worker load.
// Consumers import the values via the dedicated subpath
// `@commonfabric/runner/telemetry-otel-bridge` (see deno.jsonc) so the OTel
// dependency only reaches hosts that actually set up a provider.
export type {
  OtelBridgeOptions,
  RuntimeTelemetryOtelBridge,
} from "./telemetry-otel-bridge.ts";

// Utility functions (split from utils.ts)
export { createJsonSchema } from "./builder/json-utils.ts";
export { deepEqual } from "@commonfabric/utils/deep-equal";
export { getValueAtPath, setValueAtPath } from "./path-utils.ts";
export { schemaToTypeString } from "./schema-format.ts";
export type { SchemaFormatOptions } from "./schema-format.ts";
export { ACLManager } from "./acl-manager.ts";
export {
  cellEntityIdString,
  type CellPath,
  compileAndSavePattern,
  parseCellPath,
  resolveCellPath,
} from "./piece-helpers.ts";
export type { ModuleByteCache } from "./runtime.ts";
export type { CompiledModuleArtifact } from "./harness/types.ts";
export {
  getCompileCacheRuntimeVersion,
} from "./compilation-cache/cell-cache.ts";
export {
  isSlugAddress,
  slugCause,
  slugIdForSpace,
  validateSlug,
} from "./slugs.ts";
export {
  type FabricChaseResult,
  resolveFabricRefToIdentity,
} from "./fabric-ref-resolution.ts";
export {
  type FabricRef,
  FabricRefError,
  formatFabricRef,
  isFabricImportSpecifier,
  parseFabricRef,
} from "./sandbox/fabric-import-specifier.ts";
export { type PinRewrite, rewriteFabricPins } from "./fabric-pin-rewrite.ts";
export {
  resolveSlugTargetCell,
  SlugResolutionError,
} from "./slug-resolution.ts";
