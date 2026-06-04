#!/usr/bin/env -S deno run --allow-read
/**
 * Deterministic "tripwire" for the cf-review skill: a cheap, instant, zero-token
 * CI gate that fails if a package or repo path the skill cites stops existing.
 *
 * Scope is deliberately narrow — existence only, and NO hardcoded fact list
 * (that would just re-introduce the rot it guards against). Semantic drift — a
 * canonical home that moved or was renamed, advice that is now wrong, something
 * missing — is the job of the LLM audit (`docs/development/skill-audit.md`), the
 * appreciating half of the pair. Together they implement the "make load-bearing
 * facts testable" guidance in `docs/development/skill-authoring.md`.
 *
 * Run:  deno task check-skill-facts
 *   or: deno test --allow-read skills/cf-review/check-facts.ts
 */

const HERE = import.meta.dirname ?? Deno.cwd();
const ROOT = `${HERE}/../..`;

const read = (p: string): Promise<string> => Deno.readTextFile(`${ROOT}/${p}`);
const exists = (p: string): boolean => {
  try {
    Deno.statSync(`${ROOT}/${p}`);
    return true;
  } catch {
    return false;
  }
};

/** Existence facts in the cf-review skill that must resolve against the tree. */
export async function collectErrors(): Promise<string[]> {
  const errors: string[] = [];
  const skill = await read("skills/cf-review/SKILL.md");

  // Every `@commonfabric/<pkg>` the skill names is a real workspace package.
  const root = JSON.parse(await read("deno.json")) as { workspace?: string[] };
  const names = new Set<string>();
  for (const member of root.workspace ?? []) {
    try {
      const pkg = JSON.parse(
        await read(`${member.replace(/^\.\//, "")}/deno.json`),
      ) as { name?: string };
      if (pkg.name) names.add(pkg.name);
    } catch {
      // workspace member without a readable deno.json — skip
    }
  }
  for (const ref of new Set(skill.match(/@commonfabric\/[a-z0-9-]+/g) ?? [])) {
    if (!names.has(ref)) errors.push(`package not in workspace: ${ref}`);
  }

  // Every repo-root path the skill cites in backticks exists. Only tokens rooted
  // at a known top-level dir count as paths; placeholders are skipped.
  const placeholder = /[<>{}*]|\.\.\.|path\/to/;
  const paths = new Set(
    [...skill.matchAll(/`([^`\n]+)`/g)]
      .map((m) => m[1].trim())
      .filter((t) => /^(packages|docs|tasks|scripts)\//.test(t))
      .filter((t) => !placeholder.test(t)),
  );
  for (const p of paths) {
    if (!exists(p)) errors.push(`path does not exist: ${p}`);
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

Deno.test("cf-review skill: cited packages and paths resolve", async () => {
  const errors = await collectErrors();
  if (errors.length > 0) {
    throw new Error(`cf-review SKILL.md drift:\n  - ${errors.join("\n  - ")}`);
  }
});
