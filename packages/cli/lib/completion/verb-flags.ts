/**
 * A verb's own fields, shaped as the flags a caller writes them with.
 *
 * The pattern author's vocabulary rather than the CLI's, which is what makes
 * this the position where a caller has least to go on and completion has most
 * to give. Everything it needs rides the listing `callableCandidates` already
 * fetches, so filling the slot costs no request.
 *
 * Held here rather than beside `shapeVerbCandidates` in `providers.ts` for one
 * reason: reading a declared input means resolving `callable.ts`, which costs
 * about a third of a whole static completion. `providers.ts` is resolved on
 * every Tab and this module is resolved only where a verb's flags are being
 * offered, which is what the inline imports there buy everywhere else.
 *
 * Which slot receives these candidates is not settled here. Step 10 of
 * [CLI surface shape](../../../../docs/plans/cli-surface-shape.md) decides
 * whether a verb's fields are written before the `--` marker or after it, and
 * routing them to today's position would teach a spelling that step retires.
 * The candidates are the same function either way, which is why they are built
 * ahead of it.
 */

import type { JSONSchema } from "@commonfabric/api";
import { declaredVerbFlags } from "../exec-schema.ts";
import type { Candidate } from "./static.ts";

/** The half of a verb listing row these candidates are derived from. */
export interface VerbFlagListingLike {
  /** The verb's input schema, as `cf piece verbs` reports it. */
  readonly inputSchema: JSONSchema | true;
}

/**
 * `--help` reaches the verb's own page from inside the callable's section, so
 * it belongs in this slot rather than among the command's flags. The other
 * generic input flags are offered beside it because the parser accepts them
 * for every verb, whatever it declared.
 */
const GENERIC_FLAGS: readonly Candidate[] = [
  { value: "--json", description: "the whole input as JSON" },
  { value: "--json-file", description: "the whole input from a JSON file" },
  { value: "--help", description: "this verb's own help page" },
];

/**
 * Every flag the verb accepts, in the order its help page lists them: its
 * declared fields first, then the generic input flags.
 *
 * A boolean field is offered in both spellings — `--flag` and `--no-flag` —
 * because both are what the parser accepts and the negated one is the half a
 * caller is least likely to guess.
 *
 * The annotation is the author's own doc comment where the field carries one,
 * falling back to whether the payload door owes the field. That is the same
 * choice the help page makes, read from the same enumeration.
 */
export function shapeVerbFlagCandidates(
  verb: VerbFlagListingLike,
): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (value: string, description: string) => {
    if (seen.has(value)) return;
    seen.add(value);
    candidates.push({ value, description });
  };

  for (const flag of declaredVerbFlags(verb.inputSchema)) {
    const description = fieldDescription(flag.schema) ??
      (flag.required ? "required" : "optional");
    // Nothing reserves a field name, so a verb may declare `json`,
    // `json-file` or `help` — names the command already owns as bare tokens.
    // The parser reads the bare token as ITS meaning and never reaches the
    // field, so the field is offered in the one spelling that does reach it.
    if (RESERVED_BARE_SPELLINGS.has(flag.name)) {
      // A boolean carries its value in the spelling; anything else is
      // completed up to the `=` and the caller writes the value.
      add(
        flag.negatable ? `--${flag.name}=true` : `--${flag.name}=`,
        `${description} (the declared field)`,
      );
      if (flag.negatable) add(`--no-${flag.name}`, `${description} (false)`);
      continue;
    }
    add(`--${flag.name}`, description);
    if (flag.negatable) add(`--no-${flag.name}`, `${description} (false)`);
  }

  for (const generic of GENERIC_FLAGS) {
    add(generic.value, generic.description ?? "");
  }
  return candidates;
}

/**
 * Flag names the command consumes as bare tokens before a declared field is
 * ever consulted: `--json` and `--json-file` select an input mode, and
 * `--help` opens the verb's page. A field of one of those names is reachable
 * only as `--name=value`, which those doors do not match.
 */
const RESERVED_BARE_SPELLINGS: ReadonlySet<string> = new Set([
  "json",
  "json-file",
  "help",
]);

/** The author's doc comment on the field, where the schema carries one. */
function fieldDescription(schema: JSONSchema | undefined): string | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const description = (schema as { description?: unknown }).description;
  return typeof description === "string" && description.length > 0
    ? description.split("\n")[0]
    : undefined;
}
