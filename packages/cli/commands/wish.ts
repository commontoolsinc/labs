import { Command, ValidationError } from "@cliffy/command";
import type { DID } from "@commonfabric/identity";
import { parseCellPath } from "@commonfabric/runner";
import { cliText } from "../lib/cli-name.ts";
import { render } from "../lib/render.ts";
import { getDidFromFile } from "../lib/identity.ts";
import { absPath } from "../lib/utils.ts";
import { normalizeApiUrl, setQuietMode } from "./piece.ts";
import { readWish } from "../lib/wish.ts";

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
  #favorites  #journal  #learned  #mentionable  #recent  /  #allPieces  …

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
    const scope = options.scope && options.scope.length > 0
      ? (options.scope as (DID | "~" | "." | "profile")[])
      : undefined;

    const { result, error } = await readWish({
      apiUrl: normalizeApiUrl(options.apiUrl),
      space,
      identity,
      query: target,
      path,
      scope,
    });

    if (error && result === null && !options.allowEmpty) {
      console.error(`wish "${target}": ${error}`);
      Deno.exit(1);
    }

    render(result, { json: true });
  });
