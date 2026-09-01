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
import { parse as parseJsonc } from "@std/jsonc";
import { dirname, fromFileUrl, join, relative } from "@std/path";

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
  // The step-7 mounts kept only so a caller who learned the old spelling
  // keeps working. Documenting one would teach the spelling being retired,
  // and the command says on every run what to write instead. These entries
  // go when the mounts do: the check fails on an allowance naming a command
  // the tree no longer accepts, so the removal cannot leave them behind.
  [
    "piece recreate-root",
    "superseded by `cf space recreate-root`; the mount survives for callers " +
    "who have not migrated and the command itself names its replacement",
  ],
  [
    "piece set-home",
    "superseded by `cf space set-home`, on the same terms",
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

/**
 * The README of each workspace package, as a repository-relative path.
 *
 * A package is what the root config says it is, rather than what the shape of
 * a path suggests: `packages/connectors/agents` is a package and
 * `packages/ts-transformers/test/fixtures` is not, and only the member list
 * tells the two apart. The path a member yields need not exist — one that
 * does not simply never turns up in the walk.
 */
export async function readPackageDocs(root: string): Promise<Set<string>> {
  const config = parseJsonc(
    await Deno.readTextFile(join(root, "deno.jsonc")),
  ) as { workspace?: unknown } | null;
  const members = Array.isArray(config?.workspace) ? config.workspace : [];
  const docs = new Set<string>();
  for (const member of members) {
    if (typeof member !== "string") continue;
    docs.add(`${member.replace(/^\.\//, "").replace(/\/+$/, "")}/README.md`);
  }
  return docs;
}

/**
 * Documents that record a moment rather than describing the system.
 *
 * `packageDocs` is {@link readPackageDocs}: under `packages/` the
 * documentation is a package's own README, and an internal one — a fixture
 * corpus, a test directory, a sub-example — is no more somewhere a caller is
 * sent to read than the source beside it.
 */
export function isLiveDoc(
  path: string,
  packageDocs: ReadonlySet<string>,
): boolean {
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
  if (doc.startsWith("packages/") && !packageDocs.has(doc)) return false;
  return true;
}

/**
 * Every command path the tree accepts, deepest last.
 *
 * Hidden commands are walked with the rest. Hidden is a fact about `--help`,
 * not about whether the CLI accepts the words: `cf completion complete` is
 * hidden and every installed completion function invokes it on every Tab. A
 * command a caller can reach is a command this gate has to ask about, and one
 * that genuinely needs no prose says so in {@link NO_PROSE} rather than by
 * being invisible here.
 */
export function declaredCommands(
  // deno-lint-ignore no-explicit-any
  root: Command<any>,
): string[] {
  const paths: string[] = [];
  // deno-lint-ignore no-explicit-any
  const visit = (command: Command<any>, path: readonly string[]): void => {
    if (path.length > 0) paths.push(path.join(" "));
    for (const child of command.getCommands(true)) {
      // Cliffy propagates its generated `help` to every descendant, so it is
      // nobody's command and no document owes it prose.
      if (child.getName() === "help") continue;
      visit(child, [...path, child.getName()]);
    }
  };
  visit(root, []);
  return paths;
}

/** Nothing in a pattern's own text may be read as regex syntax. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The expression that decides whether a document names one command.
 *
 * A document names a command by writing it the way a caller types it, which
 * is the whole command path between boundaries. Three things look like that
 * and are not it. `cf piece setsrc` is a different command with its own prose
 * obligation, so it cannot stand in for `cf set`. `scf brew` is a word
 * that happens to end in the command's letters. And `cf piece ls` names the
 * child: a reader looking up `cf piece` finds nothing about `cf piece` there,
 * so the parent still owes prose of its own — which is why the next segment
 * of every command this one is a prefix of ends the match.
 */
export function commandPattern(
  command: string,
  commands: readonly string[],
): RegExp {
  const path = command.split(" ");
  const children = new Set<string>();
  for (const other of commands) {
    const parts = other.split(" ");
    if (parts.length === path.length + 1 && other.startsWith(`${command} `)) {
      children.add(parts.at(-1)!);
    }
  }
  const child = children.size === 0
    ? ""
    : `(?!\\s+(?:${[...children].map(escapeRegExp).join("|")})(?![\\w-]))`;
  return new RegExp(
    `(?<![\\w-])cf\\s+${path.map(escapeRegExp).join("\\s+")}${child}(?![\\w-])`,
  );
}

/** The command paths some live document names. */
export async function documentedCommands(
  root: string,
  commands: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  const packageDocs = await readPackageDocs(root);
  const patterns = commands.map((command) => ({
    command,
    pattern: commandPattern(command, commands),
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
        if (!isLiveDoc(path, packageDocs)) continue;
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
  root = dirname(dirname(fromFileUrl(import.meta.url))),
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
