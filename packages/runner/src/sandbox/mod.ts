/**
 * SES (Secure ECMAScript) Sandboxing for pattern execution.
 *
 * This module provides secure compartmentalized execution for patterns,
 * preventing closure state leakage, global pollution, and prototype tampering.
 *
 * @module
 */

// Core manager
export {
  CompartmentManager,
  getCompartmentManager,
  resetCompartmentManager,
} from "./compartment-manager.ts";

// Configuration
export {
  getDefaultLockdownOptions,
  getDefaultSandboxConfig,
  resolveSandboxConfig,
} from "./config.ts";

// Runtime globals
export {
  createMinimalGlobals,
  createRuntimeGlobals,
} from "./runtime-globals.ts";

// Console
export {
  createSandboxedConsole,
  createSilentConsole,
  type SandboxedConsoleOptions,
} from "./sandboxed-console.ts";

// Types
export {
  CompartmentInitializationError,
  type FrozenExport,
  type LockdownOptions,
  type PatternCompartment,
  type PatternCompartmentConfig,
  type RuntimeGlobals,
  type SandboxConfig,
  SandboxSecurityError,
} from "./types.ts";

// Execution wrapper
export {
  type ExecutionWrapperOptions,
  getErrorMessage,
  isPatternExecutionError,
  PatternExecutionError,
  type SourceLocation,
  wrapAsyncExecution,
  wrapExecution,
  type WrappedFunction,
} from "./execution-wrapper.ts";

// Frame classifier
export {
  type ClassifiedFrame,
  classifyFrame,
  classifyStack,
  filterFrames,
  formatFrames,
  type FrameType,
} from "./frame-classifier.ts";

// Error mapping
export {
  createErrorMapper,
  ErrorMapper,
  type ErrorMappingOptions,
  mapError,
  type MappedError,
} from "./error-mapping.ts";

// Error display
export {
  createErrorReport,
  type ErrorDisplayOptions,
  type ErrorReport,
  formatError,
  formatErrorForConsole,
  formatErrorForLog,
  formatUserMessage,
} from "./error-display.ts";

// Import hooks
export {
  createImportHook,
  createResolveHook,
  ESMCache,
  type ImportHookConfig,
  isExternalSpecifier,
  resetImportCounter,
} from "./import-hooks.ts";
