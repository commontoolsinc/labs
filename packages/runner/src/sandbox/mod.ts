export {
  BundlePreflightError,
  preflightCompiledBundle,
} from "./bundle-preflight.ts";
export {
  createCallbackCompartmentGlobals,
  createModuleCompartmentGlobals,
  createSafeConsoleGlobal,
} from "./compartment-globals.ts";
export { hardenVerifiedFunction } from "./function-hardening.ts";
export {
  ensureSESLockdown,
  evaluateCallbackSourceInSES,
  evaluateFunctionSourceInSES,
  SESIsolate,
  SESRuntime,
  type SESRuntimeOptions,
} from "./ses-runtime.ts";
export {
  ModuleVerificationError,
  verifyCompiledBundleModuleFactories,
  verifyProgramModuleScope,
} from "./module-verifier.ts";
export {
  assertPlainData,
  freezeVerifiedPlainData,
  type ModuleSafeValue,
  PlainDataValidationError,
} from "./plain-data.ts";
export type { RuntimeModuleIdentifier } from "./runtime-modules.ts";
export {
  getRuntimeModuleExports,
  getRuntimeModuleTypes,
  isRuntimeModuleIdentifier,
  RuntimeModuleIdentifiers,
} from "./runtime-modules.ts";
