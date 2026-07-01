export type { CfcLabelView, CfcLabelViewEntry } from "./label-view.ts";
export {
  type CfcCellLinkRefPayload,
  linkCfcLabelView,
  setLinkCfcLabelView,
} from "./link-label-view.ts";
export {
  cfcLabelViewForCell,
  cfcLabelViewForDereference,
  cfcLabelViewForDereferenceTraces,
  cfcLabelViewFromMetadata,
  cloneCfcLabelView,
  getCarriedCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
  redactCaveatSourcesForDisplay,
} from "./label-view.ts";
export type {
  AttemptedWrite,
  CfcAddress,
  CfcDereferenceTrace,
  CfcEnforcementMode,
  CfcFlowLabelsMode,
  CfcMetadata,
  CfcPrepareState,
  CfcSandboxDiagnostic,
  CfcSandboxExitCodeObservation,
  CfcSandboxJsonValue,
  CfcSandboxOutputPolicy,
  CfcSandboxResult,
  CfcStreamChannel,
  CfcStreamObservation,
  CfcStreamSegment,
  CfcTxState,
  ConsumedRead,
  EntityDocumentWithCfc,
  IFCLabel,
  ImplementationIdentity,
  PostCommitSideEffect,
  PreparedDigestInput,
  TrustSnapshot,
  WritePolicyInput,
} from "./types.ts";
export {
  CFC_ENFORCEMENT_MODES,
  CFC_ENFORCING_STRICTNESS,
  cfcEnforcementStrictness,
  DEFAULT_CFC_ENFORCEMENT_MODE,
  DEFAULT_CFC_FLOW_LABELS_MODE,
  isCfcEnforcementMode,
} from "./types.ts";
export {
  canonicalizeCfcMetadata,
  canonicalizeDereferenceTrace,
  canonicalizeLogicalPath,
  canonicalizePreparedDigestInput,
  canonicalizeWritePolicyInput,
  logicalPathToPointer,
  preparedDigestFor,
} from "./canonical.ts";
export {
  flowLabelWorkExists,
  flowReadExcluded,
  gatedSinkRequestExists,
  prepareBoundaryCommit,
} from "./prepare.ts";
export {
  createSinkRequestPolicyInput,
  recordSinkRequestPolicyInput,
  verifySinkRequestRelease,
} from "./sink-request.ts";
export type {
  HarnessPromptSlotLike,
  HarnessPromptSlotRole,
  HarnessWriteFileAuthorizationDecision,
  HarnessWriteFileAuthorizationRequest,
} from "./harness-write-policy.ts";
export { evaluateHarnessWriteFileAuthorization } from "./harness-write-policy.ts";
export {
  type CfcExternalIngestMeta,
  externalIngestStamp,
  stampExternalIngest,
} from "./external-ingest.ts";
export {
  DEFAULT_SINK_MAX_CONFIDENTIALITY,
  INITIAL_SINK_INVENTORY,
  isInitialSinkInventoryName,
} from "./sink-inventory.ts";
export type { SinkMaxConfidentiality } from "./sink-inventory.ts";
export { markRendererTrustedEvent } from "./ui-contract.ts";
export {
  cfcObjectSchemaIsClosed,
  INJECTION_SAFE_ATOM,
  isPrimitiveJsonValue,
  isPromptInjectionMaterialRiskAtom,
  resolveSchemaForValidation,
  schemaWithInjectionSafeAnnotations,
  validateAgainstSchema,
} from "./schema-sanitization.ts";
export {
  CFC_LABEL_READ_FAILED_ATOM,
  cfcConfidentialityForObservationNode,
  cfcJsonPointerForPath,
  cfcObservationFitsCeiling,
  type CfcObservationMaxConfidentiality,
  type CfcObservationResult,
  type CfcObservedConfidentiality,
  type CfcOpaqueLink,
  cfcOpaqueLinkForPath,
  joinCfcObservedConfidentiality,
  uniqueCfcAtoms,
} from "./observation.ts";
export {
  cfcSchemaIsFalse,
  cfcSchemaIsInternalKey,
  cfcSchemaIsTrue,
  cfcSchemaToObject,
  findCfcSchemaRefs,
  isEmbeddedCfcSchemaRef,
  resolveCfcSchemaRef,
  resolveCfcSchemaRefs,
  resolveCfcSchemaRefsOrThrow,
} from "./schema-refs.ts";
export {
  type SchemaOpaqueLinkSanitizationResult,
  validateAndSanitizeSchemaValueWithOpaqueLinks,
  validateAndSanitizeStructuredResultValue,
  validateStructuredResultValue,
} from "./structured-result.ts";
