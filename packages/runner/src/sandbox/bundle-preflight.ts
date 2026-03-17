import { findBalancedRegion } from "./token-scanner.ts";

const AMD_LOADER_MARKER = "const { define, require } =";
const DEFINE_MARKER = "define(";

export function extractBundleRegion(bundleSource: string): string {
  const loaderIndex = bundleSource.indexOf(AMD_LOADER_MARKER);
  if (loaderIndex < 0) {
    throw new Error("Bundle is missing the trusted AMD loader prelude");
  }
  const firstDefineIndex = bundleSource.indexOf(DEFINE_MARKER, loaderIndex);
  if (firstDefineIndex < 0) {
    throw new Error("Bundle does not register any AMD modules");
  }
  const returnIndex = bundleSource.lastIndexOf("return require(");
  if (returnIndex < 0 || returnIndex < firstDefineIndex) {
    throw new Error("Bundle is missing the trusted return wrapper");
  }

  const prefixRegion = bundleSource.slice(0, firstDefineIndex);
  if (/(globalThis|window|document|console\.)/.test(prefixRegion)) {
    throw new Error("Bundle contains untrusted code before the first define() call");
  }

  const region = bundleSource.slice(firstDefineIndex, returnIndex);
  return region;
}

export function verifyBundlePreflight(bundleSource: string): void {
  extractBundleRegion(bundleSource);
  const region = extractTrustedRegion(bundleSource);
  const trimmed = region.trim();
  if (!trimmed.startsWith("define(")) {
    throw new Error("Bundle region must start with define()");
  }
  if (/(globalThis|window|document|console\.)/.test(region)) {
    throw new Error("Bundle region contains untrusted top-level side effects");
  }
}

function extractTrustedRegion(bundleSource: string): string {
  const firstDefineIndex = bundleSource.indexOf(DEFINE_MARKER);
  const returnIndex = bundleSource.lastIndexOf("return require(");
  if (firstDefineIndex < 0 || returnIndex < 0) {
    throw new Error("Bundle is missing the expected AMD wrapper structure");
  }
  return bundleSource.slice(firstDefineIndex, returnIndex);
}

export function extractFirstFactoryBody(defineSource: string): string {
  const factoryIndex = defineSource.indexOf("function");
  if (factoryIndex < 0) {
    throw new Error("AMD module is missing a factory function");
  }
  const bodyStart = defineSource.indexOf("{", factoryIndex);
  if (bodyStart < 0) {
    throw new Error("AMD factory is missing a body");
  }
  const { end } = findBalancedRegion(defineSource, bodyStart);
  return defineSource.slice(bodyStart + 1, end);
}
