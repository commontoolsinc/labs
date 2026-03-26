export const TRUSTED_BUILDERS = new Set([
  "action",
  "computed",
  "derive",
  "handler",
  "lift",
  "pattern",
]);

export const TRUSTED_DATA_HELPERS = new Set([
  "schema",
  "__ct_data",
  "nonPrivateRandom",
  "safeDateNow",
]);

export const SAFE_GLOBAL_IDENTIFIERS = new Set([
  "Array",
  "BigInt",
  "Boolean",
  "Date",
  "Error",
  "Headers",
  "Infinity",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "Request",
  "RegExp",
  "Response",
  "Set",
  "String",
  "Symbol",
  "TextDecoder",
  "TextEncoder",
  "Uint8Array",
  "URL",
  "URLSearchParams",
  "atob",
  "btoa",
  "console",
  "decodeURIComponent",
  "encodeURIComponent",
  "fetch",
  "globalThis",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "structuredClone",
  "undefined",
]);

export const TOP_LEVEL_CALL_RESULT_ERROR =
  "Top-level call results must be wrapped in __ct_data() in SES mode";

export function isTrustedSnapshotHelperName(
  name: string | undefined,
): name is "nonPrivateRandom" | "safeDateNow" {
  return name === "nonPrivateRandom" || name === "safeDateNow";
}
