export const SES_WRAPPER_HELPERS = Object.freeze([
  "__ct_builder",
  "__ct_fn",
  "__ct_pure_fn",
  "__ct_data",
] as const);

export const SES_SENTINEL_PREFIX = "/*__CT_TOPLEVEL__:";

export const IMPLEMENTATION_REF_FIELD = "implementationRef";

// TODO(seefeldb): Remove these legacy entrypoints once authored/runtime-generated
// patterns consistently import through "commontools".
const LEGACY_RUNTIME_MODULES = Object.freeze([
  "@commontools/html",
  "@commontools/builder",
  "@commontools/runner",
] as const);

export const TRUSTED_RUNTIME_MODULES = Object.freeze([
  "commontools",
  "commontools/schema",
  "turndown",
  ...LEGACY_RUNTIME_MODULES,
] as const);

export type TrustedRuntimeModuleIdentifier =
  (typeof TRUSTED_RUNTIME_MODULES)[number];

const TRUSTED_RUNTIME_MODULE_SET = new Set<string>(TRUSTED_RUNTIME_MODULES);

export function isTrustedRuntimeModuleIdentifier(
  value: string,
): value is TrustedRuntimeModuleIdentifier {
  return TRUSTED_RUNTIME_MODULE_SET.has(value);
}
