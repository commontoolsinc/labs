import { dirname, join } from "@std/path";
import { parse } from "@std/jsonc";

/**
 * Infer the root directory for resolving a test pattern's relative imports:
 * the nearest ancestor of the entry file whose `deno.json`/`deno.jsonc`
 * declares a package `name`.
 *
 * The `name` field is the boundary test because a config file without one
 * commonly exists only to wire tasks for a directory — a workspace member
 * stub, a scratch config — and anchoring there would strand imports that
 * reach shared modules elsewhere in the package. A named config is what
 * declares "this directory is a package", which is the widest scope a
 * pattern's relative imports are expected to span.
 *
 * Returns undefined when no ancestor declares a name, leaving the caller its
 * default (the entry file's own directory).
 */
export function inferProgramRoot(entryPath: string): string | undefined {
  let dir = dirname(entryPath);
  while (true) {
    for (const file of ["deno.json", "deno.jsonc"]) {
      if (declaresPackageName(join(dir, file))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function declaresPackageName(configPath: string): boolean {
  let text: string;
  try {
    text = Deno.readTextFileSync(configPath);
  } catch {
    return false;
  }
  try {
    const config = parse(text);
    return config !== null && typeof config === "object" &&
      !Array.isArray(config) &&
      typeof (config as { name?: unknown }).name === "string";
  } catch {
    // An unparseable config cannot declare a name; the walk continues rather
    // than failing the run over a file the test never imports.
    return false;
  }
}
