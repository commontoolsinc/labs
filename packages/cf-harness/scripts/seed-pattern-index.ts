/**
 * Publishes the composable atoms under `packages/patterns/primitives` to the
 * pattern index, so a harness run has parameterized parts to find rather than
 * only whole applications that take no inputs.
 *
 * Everything the index stores about an atom is derived from the atom's own
 * source. The description is the first paragraph of its doc comment, and the
 * tags come from `@hashtags` and `@keywords` lines in the same comment, so the
 * claim the index advertises sits beside the code that has to honour it and
 * moves when that code moves. An atom whose doc comment carries neither tag
 * line is refused rather than published under a guess.
 *
 * The identity an atom is published under is its compiled entry identity —
 * the content-addressed value `run_pattern` publishes under, read back off the
 * compiled artifact through `getArtifactEntryRef`. It is stable across runs of
 * this script for unchanged source, which is what makes re-running idempotent:
 * `publishPattern` answers `created: false` for an identity the index already
 * holds.
 *
 * The compile runs inside the harness's own Fabric session rather than a
 * runtime built beside it. That is load-bearing rather than convenient: a
 * `PiecesController` pulls its experimental flags from the deployment it
 * connects to, and at least one of them (`contentAddressedSchemas`) bears on
 * content hashing. A runtime constructed here with default options could
 * compute an identity no composing run would ever recompute, and a
 * `cf:pattern:` import of that identity is refused outright rather than
 * silently degraded. So a dry run connects to the fabric too — it compiles
 * exactly what a real run compiles, and only the index writes are withheld.
 */

import { basename, fromFileUrl, join } from "@std/path";
import {
  compileAndSavePattern,
  PatternManager,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  createHarnessPatternIndexClientFactory,
  type PatternIndexPublishRequest,
} from "../src/pattern-index/client.ts";
import { createHarnessFabricSessionFactory } from "../src/fabric-session.ts";
import { patternIndexDependencies } from "../src/pattern-index/composition.ts";

/** Where the atoms live, relative to the repository root. */
export const SEED_DIRECTORY = "packages/patterns/primitives";

/** What one atom's doc comment says about it, for the index to advertise. */
export interface SeedMetadata {
  /**
   * The first paragraph of the doc comment: what the program does, in terms a
   * reader can check against the source beside it.
   */
  description: string;

  hashtags: readonly string[];
  keywords: readonly string[];
}

/** An atom, its derived metadata, and the identity it publishes under. */
export interface SeedEntry {
  /** File name without extension, used to name the atom in output. */
  name: string;

  /** Absolute path to the atom's entry module. */
  path: string;

  metadata: SeedMetadata;
  patternId: string;
  program: RuntimeProgram;
  argumentSchema?: unknown;
  resultSchema?: unknown;
}

/** A doc comment's text with its leading `/**`, ` * ` and `*\/` removed. */
const docCommentBody = (source: string): string | undefined => {
  const match = source.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (match === null) return undefined;
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
};

/** The comma-separated values of an `@tag` line, folded onto one line. */
const tagValues = (body: string, tag: string): readonly string[] => {
  const match = body.match(
    new RegExp(`@${tag}\\s+([\\s\\S]*?)(?=\\n\\s*@|$)`),
  );
  if (match === null) return [];
  return match[1]
    .split(",")
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0);
};

/**
 * What the index should advertise about the atom in `source`.
 *
 * @throws Error when the doc comment is missing, carries no prose before its
 * first tag, or declares no hashtags or keywords. A seed entry the index
 * cannot be searched for is worth less than no entry, and an entry described
 * by a guess is worse than either.
 */
export const seedMetadataFromSource = (
  name: string,
  source: string,
): SeedMetadata => {
  const body = docCommentBody(source);
  if (body === undefined) {
    throw new Error(`${name} has no leading doc comment to describe it`);
  }
  // Anchored at a line start including the first, so a comment that opens
  // straight into a tag yields no prose rather than the tag's own text.
  const prose = body.split(/(?:^|\n)\s*@/)[0];
  const description = prose.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  if (description === "") {
    throw new Error(`${name}'s doc comment opens with no description`);
  }
  const hashtags = tagValues(body, "hashtags");
  const keywords = tagValues(body, "keywords");
  if (hashtags.length === 0) {
    throw new Error(`${name}'s doc comment declares no @hashtags`);
  }
  if (keywords.length === 0) {
    throw new Error(`${name}'s doc comment declares no @keywords`);
  }
  return { description, hashtags, keywords };
};

/** The atom entry modules under `directory`, in a stable order. */
export const seedSourcePaths = async (
  directory: string,
): Promise<readonly string[]> => {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile) continue;
    if (!entry.name.endsWith(".tsx")) continue;
    if (entry.name.endsWith(".test.tsx")) continue;
    paths.push(join(directory, entry.name));
  }
  return paths.sort();
};

/** The publish request an entry produces, so a dry run prints the real thing. */
export const publishRequestFor = (
  entry: SeedEntry,
): PatternIndexPublishRequest => ({
  patternId: entry.patternId,
  program: {
    main: entry.program.main,
    files: entry.program.files.map((file) => ({
      name: file.name,
      contents: file.contents,
    })),
    ...(entry.program.mainExport !== undefined
      ? { mainExport: entry.program.mainExport }
      : {}),
  },
  description: entry.metadata.description,
  hashtags: entry.metadata.hashtags,
  keywords: entry.metadata.keywords,
  // What a session looking for this atom would be asking for. The atom was
  // not written to answer one request, so its own description is the honest
  // stand-in: it is the same claim, in the same words the index ranks on.
  directQuery: entry.metadata.description,
  ...(entry.argumentSchema !== undefined
    ? { argumentSchema: entry.argumentSchema as never }
    : {}),
  ...(entry.resultSchema !== undefined
    ? { resultSchema: entry.resultSchema as never }
    : {}),
  dependencies: patternIndexDependencies(entry.program.files),
});

interface SeedOptions {
  dryRun: boolean;
  only: readonly string[];
  repoRoot: string;
  apiUrl: string;
  identityKeyPath: string;
  space: string;
  indexBaseUrl: string;
}

const USAGE = `Usage: deno task seed-pattern-index [options]

Publishes the atoms under ${SEED_DIRECTORY} to the pattern index.

  --dry-run          Compile and print what would be published, publishing
                     nothing. Still connects to the fabric, because the
                     identity it prints comes from the compile.
  --only <name>      Seed only the named atom (repeatable), e.g. --only counter
  --api-url <url>    Fabric API             [CF_HARNESS_FABRIC_API_URL]
  --identity <path>  Identity keyfile       [CF_HARNESS_FABRIC_IDENTITY]
  --space <space>    Fabric space           [CF_HARNESS_FABRIC_SPACE]
  --index-url <url>  Pattern index base URL [CF_HARNESS_PATTERN_INDEX_URL]
`;

const requireOption = (value: string | undefined, name: string): string => {
  if (value === undefined || value === "") {
    console.error(`seed-pattern-index: ${name} is required.\n\n${USAGE}`);
    Deno.exit(2);
  }
  return value;
};

const parseOptions = (args: readonly string[]): SeedOptions => {
  const only: string[] = [];
  let dryRun = false;
  const named = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      Deno.exit(0);
    } else if (arg === "--only") {
      only.push(args[++i]);
    } else if (arg.startsWith("--")) {
      named.set(arg.slice(2), args[++i]);
    } else {
      console.error(`seed-pattern-index: unexpected argument "${arg}".`);
      Deno.exit(2);
    }
  }
  const env = (key: string) => Deno.env.get(key);
  // The script lives at packages/cf-harness/scripts/, three levels below root.
  const repoRoot = fromFileUrl(new URL("../../..", import.meta.url));
  return {
    dryRun,
    only,
    repoRoot,
    apiUrl: requireOption(
      named.get("api-url") ?? env("CF_HARNESS_FABRIC_API_URL"),
      "--api-url",
    ),
    identityKeyPath: requireOption(
      named.get("identity") ?? env("CF_HARNESS_FABRIC_IDENTITY"),
      "--identity",
    ),
    space: requireOption(
      named.get("space") ?? env("CF_HARNESS_FABRIC_SPACE"),
      "--space",
    ),
    indexBaseUrl: requireOption(
      named.get("index-url") ?? env("CF_HARNESS_PATTERN_INDEX_URL"),
      "--index-url",
    ),
  };
};

const main = async (): Promise<number> => {
  const options = parseOptions(Deno.args);
  const directory = join(options.repoRoot, SEED_DIRECTORY);
  const allPaths = await seedSourcePaths(directory);
  const paths = options.only.length === 0
    ? allPaths
    : allPaths.filter((path) => options.only.includes(basename(path, ".tsx")));
  if (paths.length === 0) {
    console.error(`seed-pattern-index: no atoms matched under ${directory}.`);
    return 2;
  }
  // Every atom's metadata is derived before anything is compiled or published,
  // so a doc comment that describes nothing stops the run while the index is
  // still untouched rather than half-seeded.
  const described = await Promise.all(paths.map(async (path) => {
    const name = basename(path, ".tsx");
    const source = await Deno.readTextFile(path);
    return { name, path, metadata: seedMetadataFromSource(name, source) };
  }));

  const { pieces } = await createHarnessFabricSessionFactory({
    apiUrl: options.apiUrl,
    identityKeyPath: options.identityKeyPath,
    space: options.space,
  })();
  const space = pieces.getSpace();

  const entries: SeedEntry[] = [];
  for (const { name, path, metadata } of described) {
    const program = await resolveLocalProgram(
      (resolver) => pieces.runtime.harness.resolve(resolver),
      { main: path, root: join(options.repoRoot, "packages/patterns") },
    );
    const pattern = await compileAndSavePattern(pieces.runtime, program, {
      space,
    });
    const patternId = pieces.runtime.patternManager
      .getArtifactEntryRef(pattern)?.identity;
    // A keyless identity names a pattern only within the session that minted
    // it, so an entry published under one could never be loaded by anything
    // else — the same refusal `run_pattern` makes on its own publish path.
    if (
      patternId === undefined ||
      PatternManager.isKeylessPatternIdentity(patternId)
    ) {
      console.error(
        `seed-pattern-index: ${name} compiled to no durable content-addressed entry identity; not seeding it.`,
      );
      return 1;
    }
    entries.push({
      name,
      path,
      metadata,
      patternId,
      program,
      argumentSchema: pattern.argumentSchema,
      resultSchema: pattern.resultSchema,
    });
  }

  for (const entry of entries) {
    const request = publishRequestFor(entry);
    console.log(`\n=== ${entry.name}`);
    console.log(`  patternId:   ${entry.patternId}`);
    console.log(`  import:      cf:pattern:${entry.patternId}`);
    console.log(`  description: ${request.description}`);
    console.log(`  hashtags:    ${request.hashtags.join(", ")}`);
    console.log(`  keywords:    ${request.keywords?.join(", ")}`);
    console.log(
      `  files:       ${
        request.program.files.map((file) => file.name).join(", ")
      }`,
    );
    console.log(
      `  argumentSchema: ${JSON.stringify(request.argumentSchema) ?? "(none)"}`,
    );
  }

  if (options.dryRun) {
    console.log(
      `\nDry run: ${entries.length} atom(s) compiled, nothing published.`,
    );
    return 0;
  }

  const client = await createHarnessPatternIndexClientFactory(
    { baseUrl: options.indexBaseUrl },
    options.identityKeyPath,
  )();
  let created = 0;
  let held = 0;
  for (const entry of entries) {
    const response = await client.publishPattern(publishRequestFor(entry));
    if (response.created) {
      created += 1;
      // The index ranks on recorded events, and a publication is not one. The
      // `created` event is what `run_pattern` records for a first publication,
      // and a seeded atom is entitled to exactly that and nothing more.
      await client.recordEvent({
        patternId: response.patternId,
        eventType: "created",
      });
    } else {
      held += 1;
    }
    console.log(
      `${
        response.created ? "published" : "already held"
      }: ${entry.name} (${response.patternId})`,
    );
  }
  console.log(`\n${created} published, ${held} already held by the index.`);
  return 0;
};

if (import.meta.main) {
  Deno.exit(await main());
}
