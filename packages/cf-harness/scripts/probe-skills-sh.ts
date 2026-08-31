/**
 * Hand-run probe of the public skills.sh search route, through the read-only
 * client the discovery half of `docs/plans/external-skill-acquisition.md`
 * describes.
 *
 * This is the only thing in the repository that calls the live registry, and
 * it is a script rather than a test on purpose: a test that reached the
 * network would be a flake first and an excuse to delete the test second. The
 * committed tests run against a captured response.
 *
 * It prints identifiers, names, and sources. It does not fetch, print, or
 * store skill text, and it is not wired into the tool registry -- no model can
 * reach any of this.
 *
 *   deno task probe-skills-sh "react native"
 *   deno task probe-skills-sh --owner expo "react native"
 */

import {
  SkillsShSearchClient,
  SkillsShSearchError,
} from "../src/skills-sh/search-client.ts";

const parseArguments = (
  argv: readonly string[],
): { query: string; owner?: string } | { usageError: string } => {
  const words: string[] = [];
  let owner: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--owner") {
      index += 1;
      owner = argv[index];
      // A flag whose value is missing must refuse, not silently drop the
      // filter and broaden the search.
      if (owner === undefined) return { usageError: "--owner needs a value" };
      continue;
    }
    words.push(argv[index]);
  }
  return { query: words.join(" "), ...(owner === undefined ? {} : { owner }) };
};

const main = async (): Promise<number> => {
  const parsed = parseArguments(Deno.args);
  if ("usageError" in parsed || parsed.query.trim().length < 2) {
    if ("usageError" in parsed) console.error(parsed.usageError);
    console.error(
      'usage: deno task probe-skills-sh [--owner <owner>] "<query>"',
    );
    return 2;
  }
  const { query, owner } = parsed;

  const client = new SkillsShSearchClient();
  let result;
  try {
    result = await client.search({
      query,
      ...(owner === undefined ? {} : { owner }),
    });
  } catch (error) {
    if (error instanceof SkillsShSearchError) {
      console.error(`refused (${error.code}): ${error.message}`);
      return 1;
    }
    throw error;
  }

  console.log(`${result.hits.length} hit(s), ${result.rejected} refused`);
  for (const hit of result.hits) {
    const installs = hit.installs === undefined
      ? "installs unknown"
      : `${hit.installs} reported installs (unverifiable)`;
    console.log(`  ${hit.id}`);
    console.log(`    name:    ${hit.name}`);
    console.log(`    source:  ${hit.source}`);
    console.log(`    signal:  ${installs}`);
  }
  if (result.rejected > 0) {
    console.log(
      `\n${result.rejected} entry(s) did not match the shape this client ` +
        "accepts and were dropped.",
    );
  }
  return 0;
};

if (import.meta.main) {
  Deno.exit(await main());
}
