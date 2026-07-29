/**
 * Candidates derivable from the Cliffy command tree alone — subcommands,
 * option names, and the enumerable value sets the tree cannot express.
 *
 * No I/O: every function here answers from the `Command` object graph, so it
 * stays correct offline and costs nothing beyond process start.
 */

import type { Option } from "@cliffy/command";
import { languageIds } from "../view/languages/language.ts";
import type { AnyCommand, CompletionLine, PreParseGlobal } from "./line.ts";
import { longName, PRE_PARSE_GLOBALS } from "./line.ts";

export interface Candidate {
  readonly value: string;
  readonly description?: string;
}

/**
 * Value sets that are real constraints but which Cliffy stores as plain
 * `string` options, so they cannot be read back off the tree. Keyed by option
 * long name. Kept here rather than inline in the provider table because these
 * are facts about the CLI's accepted vocabulary, not about live data.
 *
 * `log-level` mirrors `lib/log-level.ts`; `color` mirrors the corresponding
 * `cf view` option. Language identifiers come from the view language registry.
 */
const ENUMERATED_OPTION_VALUES: Readonly<Record<string, readonly string[]>> = {
  "log-level": ["debug", "info", "warn", "error", "silent"],
  "color": ["auto", "always", "never"],
  "language": languageIds(),
  "cfc-mode": ["off", "warn", "enforce"],
};

/** First sentence of a description, for the shell's annotation column. */
function summarize(description: unknown): string | undefined {
  if (typeof description !== "string") return undefined;
  const text = description.trim().split("\n")[0];
  if (!text) return undefined;
  const sentence = text.match(/^(.{1,72}?)(?:\.\s|\.$|$)/);
  return (sentence?.[1] ?? text).trim() || undefined;
}

/**
 * Subcommands of `command`. `getCommands(false)` already drops commands marked
 * hidden; `help` is dropped here because Cliffy generates one on every command
 * and offering it at each level is noise.
 *
 * Commands whose description opens with `Internal:` are plumbing invoked by the
 * CLI itself — `fuse-daemon` and `fuse-supervisor` are spawned by `cf fuse`,
 * never typed. They stay in `--help` (where the marker already explains them)
 * but offering them at the prompt would only crowd out real commands.
 */
export function subcommandCandidates(command: AnyCommand): Candidate[] {
  return command.getCommands(false)
    .filter((child) => child.getName() !== "help")
    .map((child) => ({
      value: child.getName(),
      description: summarize(child.getDescription()),
    }))
    .filter((candidate) => !candidate.description?.startsWith("Internal:"));
}

/**
 * Option flags accepted at this point on the line.
 *
 * A bare `-` offers short and long spellings; `--` offers long only, which
 * keeps the common case from being padded with single-letter duplicates.
 * Options already supplied are dropped unless they are repeatable.
 */
export function optionNameCandidates(
  command: AnyCommand,
  line: CompletionLine,
): Candidate[] {
  const wantsShort = !line.word.startsWith("--");
  const candidates: Candidate[] = [];

  for (const option of command.getOptions(false)) {
    const name = longName(option);
    const supplied = line.options.has(name) || line.flags.has(name);
    if (supplied && !option.collect) continue;

    const description = summarize(option.description);
    for (const flag of option.flags) {
      if (!wantsShort && !flag.startsWith("--")) continue;
      candidates.push({ value: flag, description });
    }
  }

  // Accepted on every command but absent from the tree — see PRE_PARSE_GLOBALS.
  for (const global of PRE_PARSE_GLOBALS) {
    for (const flag of global.flags) {
      candidates.push({ value: flag, description: global.description });
    }
  }

  return candidates;
}

/** Accepted values of a pre-parse global, for its `--flag <value>` slot. */
export function preParseGlobalValues(global: PreParseGlobal): Candidate[] {
  return (global.values ?? []).map((value) => ({ value }));
}

/**
 * Values for an option whose accepted set is known statically. Returns `null`
 * when the option has no such set, which tells the caller to try a live
 * provider instead.
 */
export function enumeratedOptionValues(option: Option): Candidate[] | null {
  const values = ENUMERATED_OPTION_VALUES[longName(option)];
  if (!values) return null;
  return values.map((value) => ({ value }));
}
