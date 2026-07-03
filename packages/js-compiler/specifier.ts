import { dirname, join } from "@std/path/posix";
import type { Source } from "./interface.ts";

/**
 * Resolve an import specifier relative to the importing source's path.
 * Relative specifiers (`./`, `../`) are joined against the importer's
 * directory; bare specifiers (e.g. `commonfabric`) are returned unchanged.
 *
 * Lives outside `typescript/resolver.ts` so runtime consumers (the worker's
 * module-record path) can import it without a static edge into the TypeScript
 * compiler — this module must stay free of `typescript` value imports.
 */
export function resolveImportSpecifier(
  specifier: string,
  from: Source,
): string {
  if (
    specifier.substring(0, 2) === "./" || specifier.substring(0, 3) === "../"
  ) {
    return join(dirname(from.name), specifier);
  }
  return specifier;
}
