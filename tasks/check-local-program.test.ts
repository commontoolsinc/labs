import { assert, assertEquals, assertFalse } from "@std/assert";
import { ALLOWLIST, namesResolverInCode } from "./check-local-program.ts";

Deno.test("namesResolverInCode finds a direct construction", () => {
  assert(
    namesResolverInCode(
      `const program = await resolve(new FileSystemProgramResolver(main, root));`,
      "packages/foo/bar.ts",
    ),
  );
});

Deno.test("namesResolverInCode finds the import that an alias renames", () => {
  assert(
    namesResolverInCode(
      `import { FileSystemProgramResolver as Resolver } from "@commonfabric/js-compiler";
const program = await resolve(new Resolver(main, root));`,
      "packages/foo/bar.ts",
    ),
  );
});

Deno.test("namesResolverInCode finds a type-position reference", () => {
  assert(
    namesResolverInCode(
      `let resolver: FileSystemProgramResolver | undefined;`,
      "packages/foo/bar.ts",
    ),
  );
});

Deno.test("namesResolverInCode ignores a line comment", () => {
  assertFalse(
    namesResolverInCode(
      `// Do not reach for FileSystemProgramResolver here.\nexport const x = 1;`,
      "packages/foo/bar.ts",
    ),
  );
});

Deno.test("namesResolverInCode ignores a doc comment", () => {
  assertFalse(
    namesResolverInCode(
      `/**\n * Prefer this to a bare FileSystemProgramResolver.\n */\nexport const x = 1;`,
      "packages/foo/bar.ts",
    ),
  );
});

Deno.test("namesResolverInCode ignores a string literal", () => {
  assertFalse(
    namesResolverInCode(
      `throw new Error("Use resolveLocalProgram, not FileSystemProgramResolver.");`,
      "packages/foo/bar.ts",
    ),
  );
});

// A scan that blanked a line from its first `//` would stop reading here at the
// URL and never reach the construction that follows it.
Deno.test("namesResolverInCode reads past a comment marker inside a string", () => {
  assert(
    namesResolverInCode(
      `const docs = "https://example.com/x"; const r = new FileSystemProgramResolver(m);`,
      "packages/foo/bar.ts",
    ),
  );
});

// Likewise for a block-comment opener: taken literally it would swallow the
// rest of the file.
Deno.test("namesResolverInCode reads past a block-comment marker inside a string", () => {
  assert(
    namesResolverInCode(
      `const glob = "/*"; const r = new FileSystemProgramResolver(m);\nconst end = "*/";`,
      "packages/foo/bar.ts",
    ),
  );
});

Deno.test("namesResolverInCode parses markup in a .tsx file", () => {
  assert(
    namesResolverInCode(
      `const view = <div class="x">text</div>;\nconst r = new FileSystemProgramResolver(m);`,
      "packages/foo/bar.tsx",
    ),
  );
});

Deno.test("namesResolverInCode ignores a same-named property of another object", () => {
  // A property access still names the resolver, so it counts; a property whose
  // name merely resembles it does not.
  assertFalse(
    namesResolverInCode(
      `const x = { fileSystemProgramResolver: 1 };`,
      "packages/foo/bar.ts",
    ),
  );
});

Deno.test("every allowlisted file still names the resolver in code", async () => {
  for (const path of ALLOWLIST.keys()) {
    const source = await Deno.readTextFile(
      new URL(`../${path}`, import.meta.url),
    );
    assert(
      namesResolverInCode(source, path),
      `${path} no longer names the resolver, so its exemption is dead.`,
    );
  }
});

Deno.test("the allowlist records a reason for every exemption", () => {
  for (const [path, reason] of ALLOWLIST) {
    assertEquals(typeof reason, "string");
    assert(reason.length > 0, `${path} is exempt without a reason.`);
  }
});
