#!/usr/bin/env -S deno run --allow-read --allow-env --allow-sys --allow-ffi
/**
 * Fails when a command the CLI accepts is described in no live document.
 *
 * `docs/README.md` already obliges a change that alters documented behavior to
 * update the document in the same change. That obligation cannot fire for a
 * command no document describes: nothing is wrong, because nothing claimed to
 * cover it. So a command ships, the prose does not, and the absence is visible
 * only to someone who already knows the command exists.
 *
 * The command tree is walkable and the documents are greppable, so the question
 * is machine-answerable: is this command named anywhere a reader would find it?
 *
 * What this cannot decide is whether a command SHOULD have prose. Plenty should
 * not — an internal entry point exists for the packaged binary to call, and a
 * forensics subcommand may be `--help`-discoverable by design. What it requires
 * is that every command has been decided about, which is what {@link NO_PROSE}
 * records. That turns the next command's documentation from something
 * remembered into something the gate asks for.
 *
 * Usage: deno task check-command-docs
 *        deno task check-command-docs --list   # every undocumented command
 */

import type { Command } from "@cliffy/command";
import { main as cliRoot } from "../packages/cli/commands/main.ts";
import { walk } from "@std/fs/walk";
import { relative } from "@std/path";

/**
 * Commands deliberately left without prose, each with the reason.
 *
 * A reason here answers one question: why would a reader never need to find
 * this from a document? An entry point the packaged binary calls on its own has
 * no caller to inform; a subcommand whose whole surface is its `--help` page
 * has nothing a document would add.
 */
export const NO_PROSE = new Map<string, string>([
  [
    "fuse-daemon",
    "an internal entry point the packaged binary calls; no caller writes it",
  ],
  [
    "fuse-supervisor",
    "the same, for the process that supervises the FUSE child",
  ],
]);

/**
 * Where the gate looks for prose, relative to the repository root.
 *
 * Each root is somewhere a caller is sent to read: the documentation tree, the
 * authored skills that people and agents share, and the README of the package
 * implementing the command. Instructions addressed to one agent are not that —
 * a command told to an agent mid-task is still a command no caller can look up
 * — so `.claude/` is no more a root than the source is.
 */
export const DOC_ROOTS: readonly string[] = [
  "docs",
  "skills",
  "packages",
];

/** Documents that record a moment rather than describing the system. */
export function isLiveDoc(path: string): boolean {
  // A repository-relative path arrives spelled with the host's separator and
  // every rule below is written in slashes, so the path is read in slashes
  // whichever it arrives in. Untranslated, a Windows `docs\history\report.md`
  // satisfies no rule here, so every one of them passes it through.
  const doc = path.replaceAll("\\", "/");
  if (!doc.endsWith(".md")) return false;
  if (doc.startsWith("docs/history/")) return false;
  // A plan describes work that is intended, not a surface a reader can use
  // today, so naming a command there is not documenting it.
  if (doc.startsWith("docs/plans/")) return false;
  if (doc.includes("/node_modules/")) return false;
  // Under `packages/`, only the package's own README is documentation; the
  // rest is source, fixtures and generated output.
  if (doc.startsWith("packages/") && !doc.endsWith("README.md")) return false;
  return true;
}

/** Every command path the tree accepts, deepest last. */
export function declaredCommands(
  // deno-lint-ignore no-explicit-any
  root: Command<any>,
): string[] {
  const paths: string[] = [];
  // deno-lint-ignore no-explicit-any
  const visit = (command: Command<any>, path: readonly string[]): void => {
    if (path.length > 0) paths.push(path.join(" "));
    for (const child of command.getCommands(false)) {
      // Cliffy propagates its generated `help` to every descendant, so it is
      // nobody's command and no document owes it prose.
      if (child.getName() === "help") continue;
      visit(child, [...path, child.getName()]);
    }
  };
  visit(root, []);
  return paths;
}

/**
 * The command paths some live document names.
 *
 * A document names a command by writing it the way a caller types it, so the
 * search is for `cf <path>` followed by a boundary. `cf piece set` must not be
 * satisfied by `cf piece setsrc`, which is a different command with its own
 * prose obligation.
 */
export async function documentedCommands(
  root: string,
  commands: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  const patterns = commands.map((command) => ({
    command,
    // A boundary is anything that cannot continue the command's last word.
    pattern: new RegExp(`cf ${command.replace(/ /g, "\\s+")}(?![\\w-])`),
  }));
  for (const dir of DOC_ROOTS) {
    // `walk` reports a missing directory when it is iterated rather than when
    // it is constructed, so the guard has to wrap the loop. A root a checkout
    // does not have contributes no documents rather than failing the run.
    try {
      const entries = walk(`${root}/${dir}`, {
        exts: [".md"],
        includeDirs: false,
      });
      for await (const entry of entries) {
        const path = relative(root, entry.path);
        if (!isLiveDoc(path)) continue;
        const text = await Deno.readTextFile(entry.path);
        for (const { command, pattern } of patterns) {
          if (!found.has(command) && pattern.test(text)) found.add(command);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return found;
}

/** What the check found, in the two directions it looks. */
export interface CommandDocReport {
  /** Commands no live document names and no allowance covers. */
  readonly undocumented: string[];
  /** Allowances naming a command the tree no longer accepts. */
  readonly staleAllowance: string[];
}

/** Subtract what the documents cover from what the tree accepts. */
export function reportCommandDocs(
  declared: readonly string[],
  documented: ReadonlySet<string>,
  allowed: ReadonlyMap<string, string>,
): CommandDocReport {
  const undocumented = declared
    .filter((command) => !documented.has(command) && !allowed.has(command))
    .sort();
  const declaredSet = new Set(declared);
  const staleAllowance = [...allowed.keys()]
    .filter((command) => !declaredSet.has(command))
    .sort();
  return { undocumented, staleAllowance };
}

/** The failures a report describes, one paragraph each. */
export function describeCommandDocFailures(
  report: CommandDocReport,
): string[] {
  const failures: string[] = [];
  const block = (lines: readonly string[]) =>
    lines.map((line) => `  cf ${line}`).join("\n");
  if (report.undocumented.length > 0) {
    failures.push(
      `${report.undocumented.length} command(s) are named in no live ` +
        `document and have no entry in NO_PROSE:\n` +
        block(report.undocumented),
    );
  }
  if (report.staleAllowance.length > 0) {
    failures.push(
      `${report.staleAllowance.length} NO_PROSE entr(ies) name a command the ` +
        `tree no longer accepts:\n` + block(report.staleAllowance),
    );
  }
  return failures;
}

/** Run the check against the real CLI tree. Returns the process exit code. */
export async function main(
  args: readonly string[] = [],
  root = new URL("..", import.meta.url).pathname,
): Promise<number> {
  const declared = declaredCommands(cliRoot);
  const documented = await documentedCommands(root, declared);
  const report = reportCommandDocs(declared, documented, NO_PROSE);

  if (args.includes("--list")) {
    for (const command of report.undocumented) console.log(`cf ${command}`);
    return 0;
  }

  const failures = describeCommandDocFailures(report);
  if (failures.length > 0) {
    console.error("Command documentation check failed.\n");
    console.error(failures.join("\n\n"));
    console.error(
      "\nEither describe the command in a live document, or record why it " +
        "needs none in tasks/check-command-docs.ts.",
    );
    return 1;
  }

  console.log(
    `Command documentation OK (${declared.length} command(s), ` +
      `${NO_PROSE.size} deliberately without prose).`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
