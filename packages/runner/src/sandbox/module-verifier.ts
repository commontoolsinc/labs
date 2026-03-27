import { verifyCompiledBundleModuleFactoriesWithParser } from "./compiled-bundle-verifier.ts";

export { ModuleVerificationError } from "./module-verification-error.ts";

export function verifyCompiledBundleModuleFactories(
  source: string,
  filename = "<bundle>",
): void {
  verifyCompiledBundleModuleFactoriesWithParser(source, filename);
}
