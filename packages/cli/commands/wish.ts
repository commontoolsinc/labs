import { Command, ValidationError } from "@cliffy/command";
import { type DID, isDID } from "@commonfabric/identity";
import { parseCellPath } from "@commonfabric/runner";
import { cliText } from "../lib/cli-name.ts";
import { render } from "../lib/render.ts";
import { getDidFromFile } from "../lib/identity.ts";
import { absPath } from "../lib/utils.ts";
import { normalizeApiUrl, setQuietMode } from "./piece.ts";
import { projectWishValue, readWish } from "../lib/wish.ts";

/** Options the `cf wish` action receives (cliffy-parsed flags + env). */
export interface WishCommandOptions {
  apiUrl?: string;
  identity?: string;
  space?: string;
  path?: string;
  scope?: string[];
  quiet?: boolean;
  allowEmpty?: boolean;
}

/** Injectable effects so the action body is unit-testable in-process. */
export interface WishCommandDeps {
  readWish: typeof readWish;
  exit: (code: number) => void;
}

/**
 * Narrow `--scope` values to what the wish builtin accepts ("~" | "." |
 * "profile" | space DID), rejecting anything else up front instead of casting.
 */
export function parseScopeFlags(
  values: string[] | undefined,
): (DID | "~" | "." | "profile")[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values.map((value) => {
    if (value === "~" || value === "." || value === "profile") return value;
    if (isDID(value)) return value;
    throw new ValidationError(
      `Invalid --scope "${value}". Expected "~", ".", "profile", or a space DID.`,
      { exitCode: 1 },
    );
  });
}

/**
 * The `cf wish` action body, extracted so tests can drive it with a stubbed
 * {@link readWish} / exit (same in-process idiom as test/inspect-remote).
 */
export async function wishAction(
  options: WishCommandOptions,
  target: string,
  deps: WishCommandDeps = { readWish, exit: Deno.exit },
): Promise<void> {
  setQuietMode(!!options.quiet);

  if (!options.identity) {
    throw new ValidationError(
      `Missing required option: "--identity", or "CF_IDENTITY".`,
      { exitCode: 1 },
    );
  }
  if (!options.apiUrl) {
    throw new ValidationError(
      `Missing required option: "--api-url", or "CF_API_URL".`,
      { exitCode: 1 },
    );
  }

  const identity = absPath(options.identity);
  // Profile / home targets resolve against the identity's own home space, so a
  // space is optional. Default to the identity's DID (its home space) so
  // `cf wish '#profile'` works with just an identity.
  const space = options.space ?? (await getDidFromFile(identity));

  const path = options.path ? parseCellPath(options.path).map(String) : [];
  const scope = parseScopeFlags(options.scope);

  const { result, error } = await deps.readWish({
    apiUrl: normalizeApiUrl(options.apiUrl),
    space,
    identity,
    query: target,
    path,
    scope,
  });

  if (error && result === null && !options.allowEmpty) {
    console.error(`wish "${target}": ${error}`);
    deps.exit(1);
    return; // Reached only when a test injects a non-terminating exit.
  }

  // Project away stream/cell handles before serializing. An object target
  // (#profile) otherwise drags its pattern's stream handles — and through them
  // the whole runtime object graph — into JSON (~50KB of noise). Scalar targets
  // (#profileName etc.) and the null / --allow-empty result pass through
  // unchanged. See projectWishValue (CT-1844).
  render(projectWishValue(result), { json: true });
}

const description = cliText(
  `Resolve a wish target headlessly and print its value (CT-1834).

The blessed, non-interactive read path for wish targets. It resolves through the
SAME runtime builtin patterns use ('wish'), driven headless so no suggestion or
profile-picker UI ever spins up — resolution (default → MRU → first, with
runtime-enforced labels at read time) lives in the builtin and is never
re-implemented here. Use it for the cases that "cannot wish": offline profile
caches demoting to witness/echo, agents, and scripts.

PROFILE TARGETS (resolve against the IDENTITY's home space; '--space' optional):
  #profile        The viewer's active profile object (default → MRU → first)
  #profileName    Its live display name
  #profileAvatar  Its avatar
  #profileBio     Its owner-authored bio
  #profileSpace   Its own space cell

OTHER TARGETS (space-relative; pass '--space'):
  #favorites  #journal  #learned  #mentionable  #recent  /  #pieceRegistry  …

ZERO-PROFILE: when no profile exists yet, the wish surfaces an error; this
command prints it to stderr and exits non-zero (use --allow-empty to instead
print 'null' on stdout and exit 0).`,
);

export const wish = new Command()
  .name("wish")
  .description(description)
  .env("CF_API_URL=<url:string>", "URL of the fabric instance.", {
    prefix: "CF_",
  })
  .option("-a,--api-url <url:string>", "URL of the fabric instance.")
  .env("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CF_",
  })
  .option("-i,--identity <path:string>", "Path to an identity keyfile.")
  .option(
    "-s,--space <space:string>",
    "Space name or DID to connect to. Defaults to the identity's home space " +
      "(where profile targets resolve regardless).",
  )
  .option(
    "-p,--path <path:string>",
    "Extra path appended to the resolved target, e.g. 'avatar' or 'a/b/0'.",
  )
  .option(
    "--scope <scope:string>",
    "Hashtag search scope: '~' (favorites), '.' (current space), 'profile', " +
      "or a space DID. Repeatable.",
    { collect: true },
  )
  .option(
    "-q,--quiet",
    "Suppress hints and next-step suggestions.",
  )
  .option(
    "--allow-empty",
    "On an empty/failed wish, print 'null' and exit 0 instead of erroring.",
  )
  .example(
    cliText(`cf wish '#profile' -i ./claude.key`),
    "Read the viewer's active profile object as JSON.",
  )
  .example(
    cliText(`cf wish '#profileName' -i ./claude.key`),
    "Read just the active profile's display name.",
  )
  .example(
    cliText(`cf wish '#mentionable' -i ./claude.key -s my-space`),
    "Read a space-relative target (needs an explicit --space).",
  )
  .arguments("<target:string>")
  .action(async (options, target) => {
    await wishAction(options, target);
  });
