import {
  SES_SENTINEL_PREFIX,
  SES_WRAPPER_HELPERS,
  TRUSTED_RUNTIME_MODULES,
} from "./abi.ts";

export interface VerifyAMDFactoryOptions {
  moduleId: string;
  dependencies: string[];
  registeredModuleIds: ReadonlySet<string>;
  factorySource: string;
}

export function verifyAMDFactory(options: VerifyAMDFactoryOptions): void {
  verifyDependencies(options.dependencies, options.registeredModuleIds);
  verifyFactorySource(options.factorySource);
}

function verifyDependencies(
  dependencies: string[],
  registeredModuleIds: ReadonlySet<string>,
): void {
  for (const dependency of dependencies) {
    if (
      dependency === "exports" || dependency === "require" ||
      dependency === "module"
    ) {
      continue;
    }
    if (
      TRUSTED_RUNTIME_MODULES.has(dependency) ||
      registeredModuleIds.has(dependency)
    ) {
      continue;
    }
    throw new Error(`Untrusted AMD dependency: ${dependency}`);
  }
}

function verifyFactorySource(source: string): void {
  if (!source.includes(SES_SENTINEL_PREFIX)) {
    throw new Error("Factory is missing SES top-level sentinels");
  }
  if (/require\s*\(\s*\[/.test(source)) {
    throw new Error("AMD async require() is not allowed in verified factories");
  }
  if (/__importStar|__importDefault/.test(source)) {
    throw new Error("Lowered dynamic import helpers are not allowed");
  }
  if (!SES_WRAPPER_HELPERS.some((helper) => source.includes(helper))) {
    throw new Error("Factory does not use the canonical SES wrapper helpers");
  }
  if (/suspicious\s*\(/.test(source)) {
    throw new Error("Factory uses an unrecognized wrapper helper");
  }
}
