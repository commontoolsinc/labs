import type { Source } from "@commonfabric/js-compiler";
import { computeModuleIdentities } from "../sandbox/module-record-compiler.ts";
import { resolveModuleImports } from "./module-identity.ts";

// A fixed, arbitrary program id. `computeModuleIdentities` strips this prefix
// before hashing (see `stripIdentityPrefix`), so its exact value never reaches
// the hash — only the per-file relative paths and contents do. Using a constant
// (rather than the engine's content-hash id) is what makes this a pure function
// of `(main, files)` while still matching the engine's stored identity.
const ENTRY_ID = "cf-entry-id";

function prefixName(name: string): string {
  return `/${ENTRY_ID}${name}`;
}

/**
 * The entry-module content identity of `main` within `files`, computed WITHOUT
 * compiling — the same value `Engine.compileToRecordGraph` stores as
 * `patternIdentity.identity` for a same-build compile of the same source.
 *
 * `files` must include the entry's full internal import closure (a superset is
 * fine — unreachable files neither affect the entry's identity nor are they
 * validated). `.d.ts` files are ignored. `contents` must be the **authored**
 * (pre-transform) source: the engine hashes pristine authored bytes, restoring
 * them via `pristineModuleSources` after the helper-injection pretransform, so
 * hashing the injected form here would diverge (see
 * `test/module-identity-engine.test.ts` "CT-1740").
 *
 * The caller must have `await ensureCompilerStack()`-ed first: import scanning
 * (via `resolveModuleImports`) parses with the TS parser.
 *
 * Throws if, walking the entry's reachable closure, any module still has an
 * internal-looking dependency (`./`, `../`, `/`) that did not resolve to an
 * included file — the closure is incomplete and the identity would be silently
 * wrong. Also throws on a `cf:` fabric import, which the light path does not
 * model (fabric mounts fold the imported pattern's identity into the leaf; use
 * the full compile path for those).
 */
export function computeEntryIdentity(
  main: string,
  files: readonly Source[],
): string {
  const moduleFiles = files.filter((f) => !f.name.endsWith(".d.ts"));
  const prefixed = moduleFiles.map((f) => ({
    name: prefixName(f.name),
    contents: f.contents,
  }));
  const entryKey = prefixName(main);

  assertClosureComplete(main, entryKey, prefixed);

  const identities = computeModuleIdentities(prefixed, {
    idPrefix: `/${ENTRY_ID}`,
  });
  const entry = identities.get(entryKey);
  if (entry === undefined) {
    throw new Error(
      `entry '${main}' produced no identity (not present in the provided files?)`,
    );
  }
  return entry;
}

// Walk the entry's reachable import closure and fail loudly on any dangling
// internal import. Scoping the check to the reachable closure (rather than every
// file) is what makes passing a superset — e.g. every file under the patterns
// root — safe: an unrelated file's broken relative import does not concern this
// entry's identity.
function assertClosureComplete(
  main: string,
  entryKey: string,
  prefixed: readonly Source[],
): void {
  const edges = resolveModuleImports({ main: "", files: [...prefixed] });
  const seen = new Set<string>([entryKey]);
  const queue: string[] = [entryKey];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const edge = edges.get(current);
    if (!edge) {
      // Only reachable if `main` itself is absent; internal targets always
      // resolve to a present file by construction.
      throw new Error(
        `entry '${main}' produced no identity (not present in the provided files?)`,
      );
    }
    for (const specifier of edge.externalDeps) {
      if (
        specifier.startsWith("./") || specifier.startsWith("../") ||
        specifier.startsWith("/")
      ) {
        throw new Error(
          `incomplete closure: '${specifier}' imported by '${
            unprefix(current)
          }' did not resolve to an included file`,
        );
      }
      if (specifier.startsWith("cf:")) {
        throw new Error(
          `fabric import '${specifier}' in '${
            unprefix(current)
          }' is not supported by the light identity path`,
        );
      }
    }
    for (const { target } of edge.internalDeps) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
}

function unprefix(name: string): string {
  const p = `/${ENTRY_ID}`;
  return name.startsWith(`${p}/`) ? name.slice(p.length) : name;
}
