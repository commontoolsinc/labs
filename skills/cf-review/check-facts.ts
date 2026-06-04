#!/usr/bin/env -S deno run --allow-read
/**
 * Deterministic "tripwire" for the cf-review skill: a cheap, instant, zero-token
 * CI gate that fails if an import specifier or repo path the skill cites does not
 * resolve against the tree.
 *
 * It checks two things, and deliberately hardcodes no fact list (that would just
 * re-introduce the rot it guards):
 *   1. Every `@commonfabric/...` specifier resolves — a bare package reference
 *      needs a root (".") export; a subpath needs that subpath in `exports`.
 *      (A bare reference to a subpath-only package is the bug this caught.)
 *   2. Every repo-root path cited in backticks exists.
 *
 * Semantic drift — a canonical home that moved or was renamed, advice that is now
 * wrong, something missing — is the job of the LLM audit
 * (`docs/development/skill-audit.md`), the appreciating half of the pair.
 * Together they implement "make load-bearing facts testable" from
 * `docs/development/skill-authoring.md`.
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

/** Does `key` ("." or "./sub") resolve against a deno.json `exports` value? */
function resolves(exp: unknown, key: string): boolean {
  if (typeof exp === "string") return key === "."; // string = root export only
  if (exp !== null && typeof exp === "object") {
    return key in (exp as Record<string, unknown>);
  }
  return false;
}

/** Facts in the cf-review skill that must resolve against the tree. */
export async function collectErrors(): Promise<string[]> {
  const errors: string[] = [];
  const skill = await read("skills/cf-review/SKILL.md");

  // Build a name -> exports map for every workspace package.
  const root = JSON.parse(await read("deno.json")) as { workspace?: string[] };
  const exportsByName = new Map<string, unknown>();
  for (const member of root.workspace ?? []) {
    try {
      const pkg = JSON.parse(
        await read(`${member.replace(/^\.\//, "")}/deno.json`),
      ) as { name?: string; exports?: unknown };
      if (pkg.name) exportsByName.set(pkg.name, pkg.exports);
    } catch {
      // workspace member without a readable deno.json — skip
    }
  }

  // Every `@commonfabric/...` specifier the skill names must resolve.
  const specifiers = new Set(
    skill.match(/@commonfabric\/[a-z0-9-]+(?:\/[a-z0-9-]+)*/g) ?? [],
  );
  for (const spec of specifiers) {
    const m = spec.match(/^(@commonfabric\/[a-z0-9-]+)(?:\/(.+))?$/);
    if (!m) continue;
    const base = m[1];
    const sub = m[2];
    if (!exportsByName.has(base)) {
      errors.push(`package not in workspace: ${base}`);
      continue;
    }
    const key = sub ? `./${sub}` : ".";
    if (!resolves(exportsByName.get(base), key)) {
      errors.push(
        sub
          ? `${base} has no export "${key}" — specifier "${spec}" won't resolve`
          : `${base} has no root export — bare "${spec}" won't resolve; cite a subpath`,
      );
    }
  }

  // Every repo-root path cited in backticks exists. Only tokens rooted at a known
  // top-level dir count as paths; placeholders are skipped.
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

Deno.test("cf-review skill: cited specifiers and paths resolve", async () => {
  const errors = await collectErrors();
  if (errors.length > 0) {
    throw new Error(`cf-review SKILL.md drift:\n  - ${errors.join("\n  - ")}`);
  }
});
