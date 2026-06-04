#!/usr/bin/env -S deno run --allow-read
/**
 * Fact-check for the cf-review skill.
 *
 * The skill's anti-duplication map (the table of canonical homes) and its file
 * references are its highest-value *and* highest-rot content: the moment the
 * tree moves, an authoritative-looking line starts actively misleading — the
 * exact failure the skill exists to prevent. Per
 * `docs/development/skill-authoring.md` ("facts rot — make them testable"), this
 * turns those load-bearing facts into a test that fails loudly on drift.
 *
 * Run:  deno task check-skill-facts
 *   or: deno test --allow-read skills/cf-review/check-facts.ts
 *   or: deno run  --allow-read skills/cf-review/check-facts.ts
 */

const HERE = import.meta.dirname ?? Deno.cwd();
const ROOT = `${HERE}/../..`;

const read = (p: string): Promise<string> => Deno.readTextFile(`${ROOT}/${p}`);

const pathExists = (p: string): boolean => {
  try {
    Deno.statSync(`${ROOT}/${p}`);
    return true;
  } catch {
    return false;
  }
};

/** Every fact in the skill that must resolve against the tree. */
export async function collectErrors(): Promise<string[]> {
  const errors: string[] = [];
  const skill = await read("skills/cf-review/SKILL.md");

  // 1. Every `@commonfabric/<pkg>` the skill names is a workspace package.
  const root = JSON.parse(await read("deno.json")) as { workspace?: string[] };
  const workspaceNames = new Set<string>();
  for (const member of root.workspace ?? []) {
    const rel = member.replace(/^\.\//, "");
    try {
      const pkg = JSON.parse(await read(`${rel}/deno.json`)) as {
        name?: string;
      };
      if (pkg.name) workspaceNames.add(pkg.name);
    } catch {
      // workspace member without a readable deno.json — skip
    }
  }
  for (const ref of new Set(skill.match(/@commonfabric\/[a-z0-9-]+/g) ?? [])) {
    if (!workspaceNames.has(ref)) {
      errors.push(`package not in workspace: ${ref}`);
    }
  }

  // 2. Every repo-relative path cited in backticks exists. Only tokens rooted at
  //    a known top-level dir count as paths; placeholders (<…>, *, path/to/…)
  //    are skipped.
  const placeholder = /[<>*]|path\/to/;
  const paths = new Set(
    [...skill.matchAll(/`([^`\n]+)`/g)]
      .map((m) => m[1].trim())
      .filter((t) => /^(packages|docs|tasks|scripts)\//.test(t))
      .filter((t) => !placeholder.test(t)),
  );
  for (const p of paths) {
    if (!pathExists(p)) errors.push(`path does not exist: ${p}`);
  }

  // 3. The data-model subpath exports the anti-dup table leans on.
  const dataModel = JSON.parse(
    await read("packages/data-model/deno.json"),
  ) as { exports?: Record<string, string> };
  const exportsMap = dataModel.exports ?? {};
  for (const sub of ["value-hash", "schema-hash", "value-clone", "json-wire"]) {
    if (!(`./${sub}` in exportsMap)) {
      errors.push(`@commonfabric/data-model missing export ./${sub}`);
    }
  }

  // 4. The one symbol the table names directly.
  if (
    !/export function convertCellsToLinks\b/.test(
      await read(
        "packages/runner/src/cell.ts",
      ),
    )
  ) {
    errors.push(
      "convertCellsToLinks no longer exported from packages/runner/src/cell.ts",
    );
  }

  return errors;
}

if (import.meta.main) {
  const errors = await collectErrors();
  if (errors.length > 0) {
    console.error("cf-review skill facts FAILED:");
    for (const e of errors) console.error(`  - ${e}`);
    Deno.exit(1);
  }
  console.log("cf-review skill facts OK");
}

Deno.test("cf-review skill: cited facts resolve against the tree", async () => {
  const errors = await collectErrors();
  if (errors.length > 0) {
    throw new Error(
      `cf-review SKILL.md references that no longer resolve:\n  - ${
        errors.join("\n  - ")
      }`,
    );
  }
});
