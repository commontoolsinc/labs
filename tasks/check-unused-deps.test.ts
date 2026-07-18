import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  ALLOWLIST,
  importsAlias,
  main,
  owningMember,
  parseImportMap,
  parseWorkspaceMembers,
  scan,
} from "./check-unused-deps.ts";

// --- importsAlias: the specifier shapes that count as an import ---

Deno.test("importsAlias matches a static import", () => {
  assert(importsAlias('import { x } from "zod";', "zod"));
});

Deno.test("importsAlias matches a type-only import", () => {
  assert(importsAlias('import type { X } from "pino";', "pino"));
});

Deno.test("importsAlias matches a re-export", () => {
  assert(importsAlias('export { x } from "zod";', "zod"));
  assert(importsAlias('export * from "zod";', "zod"));
});

Deno.test("importsAlias matches a side-effect import", () => {
  assert(importsAlias('import "ses";', "ses"));
});

Deno.test("importsAlias matches a dynamic import", () => {
  assert(importsAlias('await import("dagre");', "dagre"));
});

// These next few pin the specifier shapes that the matcher must keep handling:
// dropping the `\s*` or an alternative from the lead would reintroduce a false
// positive on ordinary code, yet leave the happy-path tests above green.

Deno.test("importsAlias matches an import broken across lines", () => {
  const source = [
    "import {",
    "  scaleBand,",
    "  scaleLinear,",
    '} from "d3-scale";',
  ].join("\n");
  assert(importsAlias(source, "d3-scale"));
});

Deno.test("importsAlias matches a dynamic import with surrounding whitespace", () => {
  assert(importsAlias('await import(\n  "dagre",\n);', "dagre"));
});

Deno.test("importsAlias matches a require call", () => {
  assert(importsAlias('const x = require("left-pad");', "left-pad"));
});

Deno.test("importsAlias matches an export * as namespace", () => {
  assert(importsAlias('export * as z from "zod";', "zod"));
});

Deno.test("importsAlias matches an import with an import attribute", () => {
  assert(
    importsAlias(
      'import ports from "@commonfabric/ports" with { type: "json" };',
      "@commonfabric/ports",
    ),
  );
});

Deno.test("importsAlias matches @deno-types in single quotes", () => {
  assert(importsAlias("// @deno-types='@types/leaflet'", "@types/leaflet"));
});

Deno.test("importsAlias matches @deno-types with spaces around the equals", () => {
  assert(
    importsAlias('// @deno-types = "@types/d3-scale"', "@types/d3-scale"),
  );
});

Deno.test("importsAlias matches a @deno-types companion comment", () => {
  const source = [
    '// @deno-types="@types/d3-scale"',
    'import { scaleBand } from "d3-scale";',
  ].join("\n");
  assert(importsAlias(source, "@types/d3-scale"));
});

Deno.test("importsAlias matches a subpath import of a bare alias", () => {
  assert(
    importsAlias(
      'import { serveDir } from "@std/http/file-server";',
      "@std/http",
    ),
  );
});

Deno.test("importsAlias does not treat a longer alias as importing a shorter sibling by name only", () => {
  // "@std/http-extras" is not "@std/http": the slash boundary in the subpath
  // rule is what separates them, so a bare "@std/http" must not match here.
  assertEquals(
    importsAlias('import x from "@std/http-extras";', "@std/http"),
    false,
  );
});

Deno.test("importsAlias matches any specifier under a slash-terminated alias", () => {
  assert(importsAlias('import env from "@/env.ts";', "@/"));
  assert(importsAlias('import app from "@/app.ts";', "@/"));
});

Deno.test("importsAlias ignores a slash-terminated alias with nothing after it", () => {
  // "@/" maps a prefix; a specifier that is only the prefix imports no module.
  assertEquals(importsAlias('const s = "@/";', "@/"), false);
});

Deno.test("importsAlias ignores a bare identifier that is not an import", () => {
  assertEquals(importsAlias("const zod = 1; zod.parse();", "zod"), false);
});

Deno.test("importsAlias ignores a substring of a different specifier", () => {
  // "notesEntry" contains "sentry" but imports nothing named sentry.
  assertEquals(
    importsAlias('import { notesEntry } from "./notes.ts";', "sentry"),
    false,
  );
});

// The loose matching is deliberate: an occurrence inside a comment or string
// counts as used. That can only ever hide a dead alias, never flag a live one,
// so the check does not misfire on a real dependency.
Deno.test("importsAlias counts a commented-out import as used", () => {
  assert(importsAlias('// import { x } from "zod";', "zod"));
});

// --- owningMember: longest-prefix attribution, including nesting ---

Deno.test("owningMember attributes a file to its member", () => {
  const members = ["packages/memory", "packages/runner"];
  assertEquals(
    owningMember("packages/memory/lib.ts", members),
    "packages/memory",
  );
});

Deno.test("owningMember prefers the nested member over its container", () => {
  const members = ["packages/patterns", "packages/patterns/auth"];
  assertEquals(
    owningMember("packages/patterns/auth/mod.ts", members),
    "packages/patterns/auth",
  );
  assertEquals(
    owningMember("packages/patterns/other.ts", members),
    "packages/patterns",
  );
});

Deno.test("owningMember returns undefined for a file under no member", () => {
  assertEquals(owningMember("tasks/check.ts", ["packages/memory"]), undefined);
});

Deno.test("owningMember does not match a member that is only a path-segment prefix", () => {
  // "packages/mem" must not own a file under "packages/memory".
  assertEquals(
    owningMember("packages/memory/lib.ts", ["packages/mem"]),
    undefined,
  );
});

// --- parsing ---

Deno.test("parseImportMap returns the imports block", () => {
  const text = `{
    // a comment
    "imports": { "zod": "npm:zod@^3", "ses": "npm:ses@^1" }
  }`;
  assertEquals(parseImportMap(text), {
    zod: "npm:zod@^3",
    ses: "npm:ses@^1",
  });
});

Deno.test("parseImportMap tolerates a missing imports block", () => {
  assertEquals(parseImportMap(`{ "name": "x" }`), {});
});

Deno.test("parseWorkspaceMembers normalises leading ./ and trailing /", () => {
  const text = `{ "workspace": ["./packages/a", "packages/b/"] }`;
  assertEquals(parseWorkspaceMembers(text), ["packages/a", "packages/b"]);
});

// --- scan over the real repository tree ---

Deno.test("no unused import map entries in the repository", async () => {
  const { unused } = await scan();
  assertEquals(
    unused,
    [],
    "Import map entries with no in-scope import were found. Remove the alias " +
      "from its `imports` block (and run `deno install`), or, for a deliberate " +
      "exception, add it to ALLOWLIST in tasks/check-unused-deps.ts.",
  );
});

Deno.test("ALLOWLIST has no stale entries", async () => {
  const { allowlisted } = await scan();
  const live = new Set(
    allowlisted.map((entry) => `${entry.config}\t${entry.alias}`),
  );
  const stale = [...ALLOWLIST.keys()].filter((key) => !live.has(key)).sort();
  assertEquals(
    stale,
    [],
    "ALLOWLIST entries in tasks/check-unused-deps.ts no longer name an unused " +
      "import map entry (the alias is now imported, or no longer declared). " +
      "Remove them from the allowlist.",
  );
});

// --- main over a temp fixture tree ---

// Builds a minimal workspace under a fresh temp dir: a root deno.jsonc naming
// one member, that member's deno.jsonc with the given imports, and one source
// file. Returns the root; the caller removes it.
async function fixtureTree(
  memberImports: Record<string, string>,
  sourceContent: string,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-unused-deps-" });
  await Deno.writeTextFile(
    join(root, "deno.jsonc"),
    JSON.stringify({ workspace: ["./packages/foo"], imports: {} }, null, 2),
  );
  const member = join(root, "packages", "foo");
  await Deno.mkdir(member, { recursive: true });
  await Deno.writeTextFile(
    join(member, "deno.jsonc"),
    JSON.stringify({ imports: memberImports }, null, 2),
  );
  await Deno.writeTextFile(join(member, "mod.ts"), sourceContent);
  return root;
}

async function captureConsole(
  body: () => Promise<void>,
): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    await body();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

Deno.test("main returns 0 and reports success on a clean tree", async () => {
  const root = await fixtureTree(
    { zod: "npm:zod@^3" },
    'import { z } from "zod";\n',
  );
  try {
    let code = -1;
    const { out } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 0);
    assert(out.includes("No unused import map entries"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main returns 1 and names the offender on an unused entry", async () => {
  const root = await fixtureTree(
    { zod: "npm:zod@^3", "left-pad": "npm:left-pad@^1" },
    'import { z } from "zod";\n',
  );
  try {
    let code = -1;
    const { err } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 1);
    assert(err.includes("packages/foo/deno.jsonc: left-pad"));
    assert(!err.includes(": zod"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main flags a member alias imported only by another member", async () => {
  // The alias is imported, but under a different member, so the declaring
  // member's entry is still unused: its own files never reach it.
  const root = await Deno.makeTempDir({ prefix: "check-unused-deps-" });
  try {
    await Deno.writeTextFile(
      join(root, "deno.jsonc"),
      JSON.stringify(
        { workspace: ["./packages/a", "./packages/b"], imports: {} },
        null,
        2,
      ),
    );
    const a = join(root, "packages", "a");
    const b = join(root, "packages", "b");
    await Deno.mkdir(a, { recursive: true });
    await Deno.mkdir(b, { recursive: true });
    // Member "a" declares the alias but never imports it.
    await Deno.writeTextFile(
      join(a, "deno.jsonc"),
      JSON.stringify({ imports: { shared: "npm:shared@^1" } }, null, 2),
    );
    await Deno.writeTextFile(join(a, "mod.ts"), "export const x = 1;\n");
    // Member "b" imports it, but has no declaration of its own.
    await Deno.writeTextFile(
      join(b, "deno.jsonc"),
      JSON.stringify({ imports: {} }, null, 2),
    );
    await Deno.writeTextFile(join(b, "mod.ts"), 'import "shared";\n');

    let code = -1;
    const { err } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 1);
    assert(err.includes("packages/a/deno.jsonc: shared"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main counts an importer under an output-named directory", async () => {
  // A file under a directory named `build` is authored source, not generated
  // output: the scan must read it, or its imports' aliases look unused.
  const root = await Deno.makeTempDir({ prefix: "check-unused-deps-" });
  try {
    await Deno.writeTextFile(
      join(root, "deno.jsonc"),
      JSON.stringify({ workspace: ["./packages/foo"], imports: {} }, null, 2),
    );
    const member = join(root, "packages", "foo");
    await Deno.mkdir(join(member, "build"), { recursive: true });
    await Deno.writeTextFile(
      join(member, "deno.jsonc"),
      JSON.stringify({ imports: { zod: "npm:zod@^3" } }, null, 2),
    );
    await Deno.writeTextFile(
      join(member, "build", "gen.ts"),
      'import { z } from "zod";\n',
    );

    let code = -1;
    await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main treats a root alias as used when any member imports it", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-unused-deps-" });
  try {
    await Deno.writeTextFile(
      join(root, "deno.jsonc"),
      JSON.stringify(
        { workspace: ["./packages/a"], imports: { shared: "npm:shared@^1" } },
        null,
        2,
      ),
    );
    const a = join(root, "packages", "a");
    await Deno.mkdir(a, { recursive: true });
    await Deno.writeTextFile(
      join(a, "deno.jsonc"),
      JSON.stringify({ imports: {} }, null, 2),
    );
    await Deno.writeTextFile(join(a, "mod.ts"), 'import "shared";\n');

    let code = -1;
    await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
