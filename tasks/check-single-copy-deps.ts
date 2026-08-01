#!/usr/bin/env -S deno run --allow-read
//
// Verifies that deno.lock resolves a single copy of each package that only
// works when the whole process shares one copy of it.
//
// Most packages tolerate being resolved twice: two copies of an HTTP client
// each do their own work and nobody notices. The packages listed below do not,
// because a value produced by one copy is read by the other:
//
// - `ai` and `@ai-sdk/provider-utils` produce the telemetry spans that
//   `@arizeai/openinference-vercel` translates. Two copies means one copy
//   emits spans while the other's translator reads them, against a span shape
//   it was not built for.
// - `@arizeai/openinference-semantic-conventions` defines the attribute names
//   that the same package's span processor reads back. Two copies means names
//   are written from one set of constants and read from the other.
//
// Nothing fails when this goes wrong. The spans are still produced and still
// exported; they arrive carrying the wrong attributes, or none. That is why
// this is a check rather than something left to a test to notice.
//
// The arrangement that satisfies this is not structural, so it needs checking
// on every change: `@ai-sdk/otel` depends on `ai` with an exact pin rather
// than a peer range, so it resolves its own copy the moment its pin and the
// range toolshed asks for stop agreeing. Rolling `ai` on its own is enough to
// do it.
//
// Usage: deno run --allow-read ./tasks/check-single-copy-deps.ts

import { dirname, fromFileUrl, join } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

const LOCKFILE = "deno.lock";

// The packages that must resolve to exactly one copy, each with what breaks
// when they do not.
export const SINGLE_COPY_PACKAGES: Record<string, string> = {
  "ai": "the AI SDK emitting spans that the OpenInference processor translates",
  "@ai-sdk/provider-utils": "shared by the AI SDK and its providers",
  "@arizeai/openinference-semantic-conventions":
    "the attribute names OpenInference writes and reads back",
};

/**
 * Extracts the package name from a deno.lock npm entry key.
 *
 * Keys are `name@version` with an optional `_peer@version` suffix, and the
 * name may itself be scoped: `ai@7.0.30_zod@3.25.76` and
 * `@ai-sdk/provider-utils@5.0.10_zod@3.25.76` both appear. The separator is
 * therefore the first `@` after a leading scope `@`, not the first or last one
 * in the key.
 */
export function packageNameOf(key: string): string {
  const separator = key.indexOf("@", key.startsWith("@") ? 1 : 0);
  return separator === -1 ? key : key.slice(0, separator);
}

/** The npm entry keys in `lockfile` that resolve `name`. */
export function copiesOf(lockfile: { npm?: Record<string, unknown> }): Map<
  string,
  string[]
> {
  const copies = new Map<string, string[]>();
  for (const key of Object.keys(lockfile.npm ?? {})) {
    const name = packageNameOf(key);
    const existing = copies.get(name);
    if (existing) existing.push(key);
    else copies.set(name, [key]);
  }
  return copies;
}

/**
 * Checks each package in `packages` against `lockfile`, returning a
 * description of every one that does not resolve to exactly one copy. An empty
 * result means they all do.
 */
export function findProblems(
  lockfile: { npm?: Record<string, unknown> },
  packages: Record<string, string> = SINGLE_COPY_PACKAGES,
): string[] {
  const problems: string[] = [];
  const copies = copiesOf(lockfile);

  for (const [name, reason] of Object.entries(packages)) {
    const resolved = copies.get(name) ?? [];
    if (resolved.length === 0) {
      problems.push(
        `${name}: not in ${LOCKFILE} at all, so this check no longer covers ` +
          `it (${reason})`,
      );
    } else if (resolved.length > 1) {
      problems.push(
        `${name}: resolved ${resolved.length} times, must be 1 — ${reason}\n` +
          resolved.map((key) => `      ${key}`).join("\n"),
      );
    }
  }

  return problems;
}

export async function main(root: string = REPO_ROOT): Promise<number> {
  const lockfile = JSON.parse(await Deno.readTextFile(join(root, LOCKFILE)));

  const problems = findProblems(lockfile);
  if (problems.length > 0) {
    console.error(
      `${LOCKFILE} resolves more than one copy of a package that needs one:`,
    );
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    console.error(
      "\nRoll the AI SDK, its providers, and the @arizeai/openinference-*\n" +
        "packages as one set so they agree on a single copy.",
    );
    return 1;
  }

  console.log(
    `Single-copy packages resolve once each: ${
      Object.keys(SINGLE_COPY_PACKAGES).join(", ")
    }`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(await main());
