#!/usr/bin/env -S deno run --allow-read
//
// Checks the shape and the coverage of docs/history/INDEX.md.
//
// That file is merged with git's `union` driver (see .gitattributes), so two
// branches that each archive a document combine without a conflict. The driver
// works a line at a time, which is what the shape rules protect: every entry
// occupies exactly one line, and the only prose is a single line above the
// first section heading. A line therefore belongs to exactly one entry, to one
// of the headings, or to that one prose line, and a union merge can neither
// splice two entries together nor keep two versions of a paragraph.
//
// Nothing else enforces this. `deno fmt` skips docs/, and a wrapped entry
// looks right until the day two branches archive documents at once.
//
// Coverage is the other half: a document nobody indexed is a document nobody
// finds. An entry may point at a directory, which covers every document
// beneath it.
//
// Usage: deno run --allow-read ./tasks/check-docs-history-index.ts

import { dirname, fromFileUrl, join, relative } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const HISTORY_DIR = "docs/history";
const INDEX_PATH = `${HISTORY_DIR}/INDEX.md`;

/** A link target as written in an entry, and the entry it came from. */
export interface IndexEntry {
  /** 1-based line number in the index. */
  readonly lineNumber: number;
  /** Link targets on that line, relative to docs/history/. */
  readonly targets: readonly string[];
}

export interface IndexProblem {
  readonly lineNumber?: number;
  readonly message: string;
}

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** Link targets inside docs/history/, with any fragment dropped. */
const targetsOf = (line: string): string[] => {
  const targets: string[] = [];
  for (const match of line.matchAll(LINK)) {
    const target = match[1].split("#")[0];
    if (target === "" || /^[a-z]+:/.test(target)) continue;
    if (target.startsWith("../")) continue;
    targets.push(target);
  }
  return targets;
};

/**
 * The shape rules. Line 1 is the title, line 3 is the one prose line, and
 * everything past the first section heading is a heading, an entry, or blank.
 */
export function checkShape(
  text: string,
): { problems: IndexProblem[]; entries: IndexEntry[] } {
  const problems: IndexProblem[] = [];
  const entries: IndexEntry[] = [];
  const lines = text.split("\n");

  if (lines[0] !== "# Index of historical documents") {
    problems.push({
      lineNumber: 1,
      message: "the first line must be `# Index of historical documents`",
    });
  }

  const firstSection = lines.findIndex((line) => line.startsWith("## "));
  if (firstSection === -1) {
    problems.push({ message: "the index has no `## ` section heading" });
    return { problems, entries };
  }

  const preamble = lines.slice(1, firstSection).filter((line) =>
    line.trim() !== ""
  );
  if (preamble.length !== 1) {
    problems.push({
      lineNumber: 2,
      message:
        `expected exactly one line of prose between the title and the first ` +
        `section heading, found ${preamble.length}. Prose here cannot be ` +
        `merged safely; put it in ${HISTORY_DIR}/README.md instead`,
    });
  }

  for (let index = firstSection; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (line.trim() === "" || line.startsWith("## ")) continue;
    if (!line.startsWith("- ")) {
      problems.push({
        lineNumber,
        message: line.startsWith(" ")
          ? "an entry is one line, never wrapped; join this onto the entry above"
          : "expected a section heading or an entry starting with `- `",
      });
      continue;
    }
    const targets = targetsOf(line);
    if (targets.length === 0) {
      problems.push({ lineNumber, message: "this entry links nothing" });
      continue;
    }
    entries.push({ lineNumber, targets });
  }

  const seen = new Map<string, number>();
  for (const entry of entries) {
    for (const target of entry.targets) {
      const first = seen.get(target);
      if (first === undefined) {
        seen.set(target, entry.lineNumber);
        continue;
      }
      problems.push({
        lineNumber: entry.lineNumber,
        message: `${target} is already indexed on line ${first}. A union ` +
          `merge keeps both sides of an entry two branches each rewrote; ` +
          `delete whichever line is stale`,
      });
    }
  }

  return { problems, entries };
}

/** Documents an entry covers: itself, or everything under it if a directory. */
export function coversPath(target: string, documentPath: string): boolean {
  if (target.endsWith("/")) return documentPath.startsWith(target);
  return target === documentPath;
}

async function markdownFilesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(join(REPO_ROOT, directory))) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) {
      found.push(...await markdownFilesUnder(path));
    } else if (entry.name.endsWith(".md")) {
      found.push(path);
    }
  }
  return found;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(join(REPO_ROOT, path));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const text = await Deno.readTextFile(join(REPO_ROOT, INDEX_PATH));
  const { problems, entries } = checkShape(text);

  const targets = entries.flatMap((entry) =>
    entry.targets.map((target) => ({ target, lineNumber: entry.lineNumber }))
  );
  for (const { target, lineNumber } of targets) {
    if (await exists(`${HISTORY_DIR}/${target}`)) continue;
    problems.push({
      lineNumber,
      message: `${target} does not exist`,
    });
  }

  const documents = (await markdownFilesUnder(HISTORY_DIR))
    .map((path) => relative(HISTORY_DIR, path))
    .filter((path) => path !== "README.md" && path !== "INDEX.md")
    .sort();
  const unindexed = documents.filter((document) =>
    !targets.some(({ target }) => coversPath(target, document))
  );
  for (const document of unindexed) {
    problems.push({
      message: `${HISTORY_DIR}/${document} is missing from the index`,
    });
  }

  if (problems.length === 0) {
    console.log(
      `${INDEX_PATH}: ${entries.length} entries covering ` +
        `${documents.length} documents.`,
    );
    return;
  }

  console.error(`${INDEX_PATH} needs fixing:\n`);
  for (const problem of problems) {
    const where = problem.lineNumber === undefined
      ? ""
      : `line ${problem.lineNumber}: `;
    console.error(`  ${where}${problem.message}`);
  }
  console.error(
    `\nThe rules, and why they are what they are, are in ` +
      `${HISTORY_DIR}/README.md under "Index".`,
  );
  Deno.exit(1);
}

if (import.meta.main) await main();
