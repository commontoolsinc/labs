/**
 * Hoisting infrastructure for SES sandboxing.
 *
 * This module provides utilities for hoisting declarations to module scope,
 * which is required for SES compartment safety. By moving closures and
 * callbacks to module scope, we ensure they don't capture mutable state
 * that could leak between invocations.
 *
 * @module
 */

export {
  type HoistedDeclaration,
  type HoistedDeclarationType,
  HoistingContext,
  isSelfContainedCallback,
  type SourcePosition,
} from "./hoisting-context.ts";

export {
  extractHoistedType,
  isHoistedIdentifierPattern,
  type SerializedMapping,
  type SerializedSourceMap,
  type SourceMapping,
  SourceMapTracker,
} from "./source-map-tracker.ts";
