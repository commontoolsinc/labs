export type RuntimeModuleIdentifier =
  | "commonfabric"
  | "commonfabric/schema"
  | "commontools"
  | "commontools/schema"
  | "turndown"
  | "@commontools/html"
  | "@commontools/builder"
  | "@commontools/runner";

export const RuntimeModuleIdentifiers = [
  "commonfabric",
  "commonfabric/schema",
  "commontools",
  "commontools/schema",
  "turndown",
  // backwards compat
  "@commontools/html",
  // backwards compat
  "@commontools/builder",
  // backwards compat, for supporting { type Cell } from "@commontools/runner"
  // from older patterns
  "@commontools/runner",
] as const satisfies readonly RuntimeModuleIdentifier[];

const RuntimeModuleIdentifierSet = new Set<string>(RuntimeModuleIdentifiers);
const ALLOWED_LOCAL_IMPORT_PREFIXES = ["./", "../", "/"] as const;
const ALLOWED_COMPILED_FACTORY_DEPENDENCIES = new Set<string>([
  "require",
  "exports",
]);

export function isRuntimeModuleIdentifier(
  value: unknown,
): value is RuntimeModuleIdentifier {
  return typeof value === "string" && RuntimeModuleIdentifierSet.has(value);
}

export function isAllowedAuthoredImportSpecifier(specifier: string): boolean {
  return isRuntimeModuleIdentifier(specifier) ||
    ALLOWED_LOCAL_IMPORT_PREFIXES.some((prefix) =>
      specifier.startsWith(prefix)
    );
}

export function isAllowedCompiledDependencySpecifier(
  specifier: string,
): boolean {
  return ALLOWED_COMPILED_FACTORY_DEPENDENCIES.has(specifier) ||
    isAllowedAuthoredImportSpecifier(specifier);
}
