/**
 * /!\ Shared between client and runtime threads.
 * /!\ Take care in only importing lightweight types,
 * /!\ interfaces and utilities.
 */

export {
  isAliasBinding,
  isSigilLink,
  type NormalizedFullLink,
  parseLLMFriendlyLink,
} from "./link-types.ts";
export {
  isLinkRef,
  type LinkRef,
  linkRefFrom,
  linkRefPayload,
  linkRefPayloadFromString,
  linkRefPayloadToString,
  type WireLinkRefPayload,
} from "@commonfabric/data-model/cell-rep";
export {
  assertWebhookCellLinkRefPayload,
  LINK_V1_TAG,
  type SigilLink,
  type URI,
  type WebhookCellLinkRefPayload,
} from "./sigil-types.ts";
export {
  CHIP_UI,
  ID,
  type JSONSchema,
  type JSONValue,
  NAME,
  type Schema,
  TILE_UI,
  TYPE,
  UI,
} from "./builder/types.ts";
export { type Cancel, useCancelGroup } from "./cancel.ts";
export type {
  CycleReport,
  HostRuntimeTelemetryMarker,
  HostSchedulerActionInfo,
  NonIdempotentReport,
  RuntimeTelemetry,
  RuntimeTelemetryEvent,
  RuntimeTelemetryMarkerResult,
  SchedulerActionInfo,
  SchedulerDiagnosisResult,
  SchedulerGraphEdge,
  SchedulerGraphNode,
  SchedulerGraphSnapshot,
} from "./telemetry.ts";
export type {
  ActionRunTraceEntry,
  SettleIterationStats,
  SettleStats,
  SettleStatsHistoryEntry,
  TriggerTraceActionRecord,
  TriggerTraceEntry,
  TriggerTraceValueKind,
  TriggerTraceValueSummary,
} from "./scheduler.ts";
export type {
  WriteStackTraceEntry,
  WriteStackTraceMatcher,
  WriteStackTraceMatchMode,
} from "./storage/write-stack-trace.ts";
// Type-only: the plain-JSON shape the worker returns for a pattern-coverage
// dump. No runtime import (the module's value exports never load here).
export type {
  PatternCoverageData,
  PatternCoverageKind,
  PatternCoverageSpan,
} from "./pattern-coverage.ts";
