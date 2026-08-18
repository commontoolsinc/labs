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

/**
 * Whether a relative import climbs above the program root.
 *
 * Source names inside a program are grounded absolute paths (`/main.tsx`), and
 * a posix join against an absolute base drops any `..` segments that would
 * climb past `/`. {@link resolveImportSpecifier} therefore maps an escaping
 * import to an in-root identifier that names a file the author never wrote.
 * This predicate answers whether that clamping would occur, by rejoining
 * against the importer's directory made relative: a relative base preserves
 * leading `..` segments, so an escape survives as a leading `..` in the
 * result.
 *
 * Only grounded importers can be judged: for a source whose name carries no
 * leading `/` there is no root to escape, and the answer is `false`.
 *
 * Kept separate from {@link resolveImportSpecifier}, which stays total: the
 * identity paths (module and entry identity, the worker's module-record
 * compiler) must keep producing the same identifier for every input the
 * compile path accepted, so refusing an escape is the graph resolver's call,
 * not this module's.
 */
export function importEscapesProgramRoot(
  specifier: string,
  from: Source,
): boolean {
  if (
    specifier.substring(0, 2) !== "./" && specifier.substring(0, 3) !== "../"
  ) {
    return false;
  }
  if (from.name.substring(0, 1) !== "/") return false;
  // Every leading slash: an HTTP-derived name preserves its URL pathname,
  // which may begin "//...", and a base left absolute would clamp again.
  const relativeDir = dirname(from.name).replace(/^\/+/, "");
  const joined = join(relativeDir, specifier);
  return joined === ".." || joined.substring(0, 3) === "../";
}
