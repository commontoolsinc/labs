#!/usr/bin/env -S deno run --allow-read --allow-env --allow-sys --allow-ffi
/**
 * Fails when a slot the CLI accepts has not been decided about for completion.
 *
 * Completion trails the command surface, and it does so silently. The resolver
 * walks the live Cliffy tree, so a new subcommand or flag becomes completable
 * the moment it is registered; its VALUES do not, because they come from two
 * hand-maintained tables. A command reaching the tree with no entry in either
 * is indistinguishable at the prompt from one whose fabric is unreachable —
 * both offer nothing — so the drift never announces itself.
 *
 * Both provider keys are derivable from the same tree the resolver walks: an
 * option's long name, and `<command path>:<argument name>`. So the drift is
 * machine-detectable, in three directions:
 *
 * - A slot with no provider, no enumerated set, and no allowlist entry.
 * - A provider entry matching no slot on the tree — the same subtraction run
 *   the other way, which is what found `log-file` and `state-path` belonging
 *   to commands that declare no Cliffy options at all.
 * - An allowlist entry matching no slot, so the record of a decision cannot
 *   outlive the thing it was about.
 *
 * What this cannot decide is whether a slot SHOULD complete — plenty should
 * not. What it requires is that every slot has been decided about, which is
 * what the allowlists record. That turns the next command's completion from
 * something remembered into something the gate asks for.
 *
 * Usage: deno task check-completion-slots
 *        deno task check-completion-slots --list   # every undecided slot
 */

import type { Command } from "@cliffy/command";
import { main as cliRoot } from "../packages/cli/commands/main.ts";
import { enumeratedOptionNames } from "../packages/cli/lib/completion/static.ts";
import { completionProviderKeys } from "../packages/cli/lib/completion/providers.ts";

/**
 * Positionals deliberately left without candidates, each with the reason.
 *
 * A reason here answers one question: what would the candidates BE? A value a
 * caller pastes from elsewhere, a word they are coining, or a number has no set
 * to draw from, and offering a wrong one is worse than offering none.
 */
export const NO_CANDIDATES = new Map<string, string>([
  // Values a caller brings from outside the CLI.
  ["acl set:did", "a DID being granted access; nothing here enumerates them"],
  ["acl remove:did", "the same DID, and the same absence of a source"],
  ["inspect identity:did", "a DID to look up, pasted from elsewhere"],
  ["id derive:passphrase", "a secret; a candidate list is the wrong place"],
  ["id from-mnemonic:mnemonic", "the same"],
  ["ingest revoke:id", "an ingest key id, held by whoever minted it"],
  ["ingest rotate:id", "the same"],
  // Words the caller is coining or composing.
  ["acl set:capability", "a capability string, composed rather than chosen"],
  ["piece search:query", "a search query"],
  // Words that belong to a callable rather than to the CLI. Item 4 of
  // docs/plans/cli-completion-coverage.md builds the candidates; which slot
  // receives them waits on step 10 of docs/plans/cli-surface-shape.md.
  ["call:tail", "the callable's own vocabulary"],
  ["piece call:tail", "the same"],
  ["exec:tail", "the same"],
]);

/**
 * Options deliberately left without candidates, keyed by long name.
 *
 * The same question, answered per option rather than per slot: an entry here is
 * a value with no set to draw from, or one whose set would cost more to derive
 * than the keystrokes it saves.
 */
export const NO_OPTION_CANDIDATES = new Map<string, string>([
  // Numbers, durations and bounds. Nothing enumerates a count.
  ["limit", "a row count"],
  ["depth", "a graph depth"],
  ["seq", "a revision sequence number"],
  ["top", "a result count"],
  ["bucket", "a time bucket size"],
  ["since", "a timestamp"],
  ["until", "a timestamp"],
  ["ttl-days", "a lifetime in days"],
  ["timeout", "a timeout in milliseconds"],
  ["attrcache-timeout", "a timeout in seconds, passed to the FUSE child"],
  ["stats-action-limit", "a count"],
  ["stats-threshold", "a threshold"],
  ["storage-stats-limit", "a count"],
  ["wait", "a patience in seconds"],
  // Identifiers the caller brings from outside, or coins.
  ["did", "a DID, pasted from elsewhere"],
  ["as", "a DID whose view to approximate, pasted from elsewhere"],
  ["slug", "a slug being coined for the first time"],
  ["invocation", "the caller's own word for one call"],
  ["invocation-session", "an unguessable session string"],
  ["install-id", "the caller's own installation identifier"],
  ["cause-prefix", "a prefix the caller chooses"],
  ["name", "a name the caller chooses"],
  ["session", "a session id, read out of the data being inspected"],
  ["branch", "a branch name; the default is the empty one"],
  ["cfc-xattr-namespace", "a namespace the caller chooses"],
  // Expressions and lists with their own grammar.
  ["filter", "a jq-inspired predicate expression"],
  ["path", "a cell path relative to a target the flag does not name"],
  ["path-json", "the same path written as a JSON array"],
  ["spaces", "a comma-separated list of the tokens --space takes"],
  ["stats-include", "a comma-separated list of timing categories"],
  ["import", "an import specifier"],
  [
    "retarget",
    "a `<phase>=<main.tsx>[@rev]` spec, composed rather than chosen",
  ],
  // Values naming something outside the fabric.
  ["url", "a browser URL; its parts complete as --api-url, --space, --piece"],
  ["app-url", "a shell origin, which is not the api-url --api-url names"],
  ["repository", "a source repository URL"],
  [
    "main-export",
    "an export name inside a pattern file, which needs the file compiled",
  ],
  ["filename", "a display name for what `cf view` is rendering"],
]);

/** One positional the tree declares, and where it was found. */
export interface PositionalSlot {
  readonly key: string;
  readonly where: string;
}

/** Every value-taking option and every positional a command tree declares. */
export interface DeclaredSlots {
  /** Option long name -> the command paths declaring it. */
  readonly options: Map<string, string[]>;
  readonly positionals: PositionalSlot[];
}

/** What the check found, in the three directions it looks. */
export interface SlotReport {
  /** Options with no provider, no enumerated set, and no allowlist entry. */
  readonly undecidedOptions: string[];
  /** Positionals with no provider and no allowlist entry. */
  readonly undecidedPositionals: string[];
  /** Provider entries matching no slot on the tree. */
  readonly unreachableProviders: string[];
  /** Allowlist entries matching no slot on the tree. */
  readonly staleAllowlist: string[];
}

/** Long name of an option, without leading dashes. */
function longName(option: { flags: string[] }): string {
  const long = option.flags.find((flag) => flag.startsWith("--"));
  return (long ?? option.flags[0] ?? "").replace(/^-+/, "");
}

/**
 * Walk a command tree the way `resolveCompletionLine` walks it: Cliffy's
 * generated `help` is skipped, because it is propagated to every descendant
 * and is nobody's slot.
 */
export function collectSlots(
  // deno-lint-ignore no-explicit-any
  root: Command<any>,
): DeclaredSlots {
  const options = new Map<string, string[]>();
  const positionals: PositionalSlot[] = [];
  // deno-lint-ignore no-explicit-any
  const walk = (command: Command<any>, path: readonly string[]): void => {
    const where = path.join(" ") || "<root>";
    for (const option of command.getOptions(false)) {
      if ((option.args?.length ?? 0) === 0) continue;
      const name = longName(option);
      const seen = options.get(name) ?? [];
      if (!seen.includes(where)) seen.push(where);
      options.set(name, seen);
    }
    for (const argument of command.getArguments()) {
      positionals.push({ key: `${path.join(" ")}:${argument.name}`, where });
    }
    for (const child of command.getCommands(false)) {
      if (child.getName() === "help") continue;
      walk(child, [...path, child.getName()]);
    }
  };
  walk(root, []);
  return { options, positionals };
}

/** Subtract what completion decides about from what the tree declares. */
export function reportSlots(
  declared: DeclaredSlots,
  known: {
    readonly providerOptions: ReadonlySet<string>;
    readonly providerArguments: ReadonlySet<string>;
    readonly enumerated: ReadonlySet<string>;
    readonly allowedOptions: ReadonlySet<string>;
    readonly allowedPositionals: ReadonlySet<string>;
  },
): SlotReport {
  const undecidedOptions: string[] = [];
  for (const [name, where] of [...declared.options].sort()) {
    if (known.providerOptions.has(name)) continue;
    if (known.enumerated.has(name)) continue;
    if (known.allowedOptions.has(name)) continue;
    undecidedOptions.push(`--${name}  (${where.join(", ")})`);
  }

  const undecidedPositionals: string[] = [];
  for (
    const slot of [...declared.positionals].sort((a, b) =>
      a.key.localeCompare(b.key)
    )
  ) {
    if (known.providerArguments.has(slot.key)) continue;
    if (known.allowedPositionals.has(slot.key)) continue;
    undecidedPositionals.push(slot.key);
  }

  const positionalKeys = new Set(
    declared.positionals.map((slot) => slot.key),
  );
  const unreachableProviders: string[] = [];
  for (const name of known.providerOptions) {
    if (!declared.options.has(name)) unreachableProviders.push(`--${name}`);
  }
  for (const key of known.providerArguments) {
    if (!positionalKeys.has(key)) unreachableProviders.push(key);
  }

  const staleAllowlist: string[] = [];
  for (const key of known.allowedPositionals) {
    if (!positionalKeys.has(key)) staleAllowlist.push(key);
  }
  for (const name of known.allowedOptions) {
    if (!declared.options.has(name)) staleAllowlist.push(`--${name}`);
  }

  return {
    undecidedOptions,
    undecidedPositionals,
    unreachableProviders: unreachableProviders.sort(),
    staleAllowlist: staleAllowlist.sort(),
  };
}

/** The failures a report describes, one paragraph each. */
export function describeFailures(report: SlotReport): string[] {
  const failures: string[] = [];
  const block = (lines: readonly string[]) =>
    lines.map((line) => `  ${line}`).join("\n");
  if (report.undecidedOptions.length > 0) {
    failures.push(
      `${report.undecidedOptions.length} value-taking option(s) have no ` +
        `provider, no enumerated set, and no entry in NO_OPTION_CANDIDATES:\n` +
        block(report.undecidedOptions),
    );
  }
  if (report.undecidedPositionals.length > 0) {
    failures.push(
      `${report.undecidedPositionals.length} positional(s) have no provider ` +
        `and no entry in NO_CANDIDATES:\n` +
        block(report.undecidedPositionals),
    );
  }
  if (report.unreachableProviders.length > 0) {
    failures.push(
      `${report.unreachableProviders.length} provider entr(ies) match no slot ` +
        `on the command tree:\n` + block(report.unreachableProviders),
    );
  }
  if (report.staleAllowlist.length > 0) {
    failures.push(
      `${report.staleAllowlist.length} allowlist entr(ies) match no slot:\n` +
        block(report.staleAllowlist),
    );
  }
  return failures;
}

/** Run the check against the real CLI tree. Returns the process exit code. */
export function main(args: readonly string[] = []): number {
  const declared = collectSlots(cliRoot);
  const providers = completionProviderKeys();
  const report = reportSlots(declared, {
    providerOptions: providers.options,
    providerArguments: providers.arguments,
    enumerated: enumeratedOptionNames(),
    allowedOptions: new Set(NO_OPTION_CANDIDATES.keys()),
    allowedPositionals: new Set(NO_CANDIDATES.keys()),
  });

  if (args.includes("--list")) {
    console.log("Undecided options:");
    for (const line of report.undecidedOptions) console.log(`  ${line}`);
    console.log("Undecided positionals:");
    for (const line of report.undecidedPositionals) console.log(`  ${line}`);
    return 0;
  }

  const failures = describeFailures(report);
  if (failures.length > 0) {
    console.error("Completion slot check failed.\n");
    console.error(failures.join("\n\n"));
    console.error(
      "\nEither give the slot candidates in packages/cli/lib/completion/, or " +
        "record why it has none in tasks/check-completion-slots.ts.",
    );
    return 1;
  }

  console.log(
    `Completion slots OK (${declared.options.size} option name(s), ` +
      `${declared.positionals.length} positional(s)).`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(main(Deno.args));
