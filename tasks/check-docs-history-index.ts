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

import { dirname, fromFileUrl, join } from "@std/path";

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

/** The tree the index describes, as paths relative to docs/history/. */
export interface HistoryTree {
  /** Every archived document, excluding README.md and INDEX.md. */
  readonly documents: readonly string[];
  /** Every path an entry may point at: those documents and every directory. */
  readonly paths: ReadonlySet<string>;
}

/** Everything wrong with an index, given the tree it is supposed to describe. */
export function checkIndex(
  text: string,
  tree: HistoryTree,
): { problems: IndexProblem[]; entryCount: number } {
  const { problems, entries } = checkShape(text);
  const targets = entries.flatMap((entry) =>
    entry.targets.map((target) => ({ target, lineNumber: entry.lineNumber }))
  );

  for (const { target, lineNumber } of targets) {
    if (tree.paths.has(target)) continue;
    problems.push({ lineNumber, message: `${target} does not exist` });
  }

  for (const document of tree.documents) {
    if (targets.some(({ target }) => coversPath(target, document))) continue;
    problems.push({
      message: `${HISTORY_DIR}/${document} is missing from the index`,
    });
  }

  return { problems, entryCount: entries.length };
}

/** The lines a run prints, so that reporting is decided without printing. */
export function report(
  problems: readonly IndexProblem[],
  entryCount: number,
  documentCount: number,
): string[] {
  if (problems.length === 0) {
    return [
      `${INDEX_PATH}: ${entryCount} entries covering ${documentCount} documents.`,
    ];
  }
  return [
    `${INDEX_PATH} needs fixing:`,
    "",
    ...problems.map((problem) => {
      const where = problem.lineNumber === undefined
        ? ""
        : `line ${problem.lineNumber}: `;
      return `  ${where}${problem.message}`;
    }),
    "",
    `The rules, and why they are what they are, are in ` +
    `${HISTORY_DIR}/README.md under "Index".`,
  ];
}

/** Reads the tree under an absolute root into the shape `checkIndex` takes. */
export async function readTree(root: string): Promise<HistoryTree> {
  const documents: string[] = [];
  const paths = new Set<string>();
  const walk = async (relativeDirectory: string): Promise<void> => {
    const absolute = join(root, relativeDirectory);
    for await (const entry of Deno.readDir(absolute)) {
      const path = relativeDirectory === ""
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory) {
        // Trailing slash included and omitted: an entry may write either.
        paths.add(path);
        paths.add(`${path}/`);
        await walk(path);
        continue;
      }
      paths.add(path);
      if (!entry.name.endsWith(".md")) continue;
      if (path === "README.md" || path === "INDEX.md") continue;
      documents.push(path);
    }
  };
  await walk("");
  documents.sort();
  return { documents, paths };
}

async function main() {
  const text = await Deno.readTextFile(join(REPO_ROOT, INDEX_PATH));
  const tree = await readTree(join(REPO_ROOT, HISTORY_DIR));
  const { problems, entryCount } = checkIndex(text, tree);
  const lines = report(problems, entryCount, tree.documents.length);
  if (problems.length === 0) {
    console.log(lines.join("\n"));
    return;
  }
  console.error(lines.join("\n"));
  Deno.exit(1);
}

if (import.meta.main) await main();
