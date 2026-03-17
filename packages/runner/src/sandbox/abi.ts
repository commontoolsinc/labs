export const SES_WRAPPER_HELPERS = [
  "__ct_builder",
  "__ct_fn",
  "__ct_pure_fn",
  "__ct_data",
] as const;

export const SES_SENTINEL_PREFIX = "/*__CT_TOPLEVEL__:";

export const IMPLEMENTATION_REF_FIELD = "implementationRef";
export const ENCODED_DATA_KIND_FIELD = "__ctDataKind";
export const ENCODED_SET_KIND = "Set";
export const ENCODED_MAP_KIND = "Map";
export const ENCODED_REGEXP_KIND = "RegExp";

export const TRUSTED_RUNTIME_MODULES = new Set([
  "commontools",
  "commontools/schema",
  "turndown",
  "@commontools/html",
  "@commontools/builder",
  "@commontools/runner",
]);
