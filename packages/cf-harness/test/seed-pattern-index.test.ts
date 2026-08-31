import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  experimentalOptionsFromEnv,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";
import { StorageManager } from "../../runner/src/storage/cache.deno.ts";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  compileAtom,
  defaultSeedIo,
  denoFmtCheck,
  durableEntryIdentity,
  fabricSeedDeps,
  main,
  parseArguments,
  publishRequestFor,
  requiredSetting,
  resolveSettings,
  runSeed,
  SEED_DIRECTORY,
  type SeedDeps,
  seedDepsFrom,
  type SeedIo,
  seedMetadataFromSource,
  seedSourcePaths,
  SeedUsageError,
  USAGE,
} from "../scripts/seed-pattern-index.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

const withDoc = (doc: string) => `${doc}\nexport const X = 1;\n`;

describe("seed-pattern-index", () => {
  describe("seedMetadataFromSource()", () => {
    it("takes the description from the first paragraph only, so the claim stays narrow", () => {
      const metadata = seedMetadataFromSource(
        "atom",
        withDoc(`/**
 * Counts a number up and down by a configurable step.
 *
 * Embed it as \`<Counter value={myCell} />\` and it mutates the host's cell.
 *
 * @hashtags counter, number
 * @keywords count, increment
 */`),
      );
      expect(metadata.description).toBe(
        "Counts a number up and down by a configurable step.",
      );
    });

    it("folds a description wrapped across lines back onto one line", () => {
      const metadata = seedMetadataFromSource(
        "atom",
        withDoc(`/**
 * Keeps a list of labeled amounts and shows
 * the formatted running total.
 *
 * @hashtags money
 * @keywords total
 */`),
      );
      expect(metadata.description).toBe(
        "Keeps a list of labeled amounts and shows the formatted running total.",
      );
    });

    it("reads hashtags and keywords, including a tag list wrapped across lines", () => {
      const metadata = seedMetadataFromSource(
        "atom",
        withDoc(`/**
 * Rolls a die.
 *
 * @hashtags dice, random, roll
 * @keywords roll dice, random number,
 * pick a number
 */`),
      );
      expect(metadata.hashtags).toEqual(["dice", "random", "roll"]);
      expect(metadata.keywords).toEqual([
        "roll dice",
        "random number",
        "pick a number",
      ]);
    });

    //
    // Refusals
    //
    // An atom the index cannot be searched for is worth less than no atom, and
    // one described by a guess is worse than either, so each of these stops the
    // run before anything is published.
    //

    it("refuses an atom with no doc comment", () => {
      expect(() => seedMetadataFromSource("atom", "export const X = 1;\n"))
        .toThrow(/no leading doc comment/);
    });

    it("refuses an atom whose doc comment opens straight into a tag", () => {
      expect(() =>
        seedMetadataFromSource(
          "atom",
          withDoc("/**\n * @hashtags a\n * @keywords b\n */"),
        )
      ).toThrow(/opens with no description/);
    });

    it("refuses an atom that declares no hashtags", () => {
      expect(() =>
        seedMetadataFromSource(
          "atom",
          withDoc("/**\n * Does a thing.\n *\n * @keywords b\n */"),
        )
      ).toThrow(/no @hashtags/);
    });

    it("refuses an atom that declares no keywords", () => {
      expect(() =>
        seedMetadataFromSource(
          "atom",
          withDoc("/**\n * Does a thing.\n *\n * @hashtags a\n */"),
        )
      ).toThrow(/no @keywords/);
    });
  });

  describe("seedSourcePaths()", () => {
    it("answers the atoms in a stable order and descends into no subdirectory", async () => {
      const paths = await seedSourcePaths(join(REPO_ROOT, SEED_DIRECTORY));
      const names = paths.map((path) => path.split("/").pop());
      expect(names).toEqual([...names].sort());
      // `demo/` holds the adopter that embeds the atoms; seeding it would
      // publish the demonstration as though it were a part.
      expect(names.some((name) => name === undefined)).toBe(false);
      expect(paths.every((path) => path.endsWith(".tsx"))).toBe(true);
      expect(paths.some((path) => path.includes("/demo/"))).toBe(false);
    });

    it("skips a directory entry that is not an atom", async () => {
      const directory = await Deno.makeTempDir();
      try {
        await Deno.writeTextFile(join(directory, "atom.tsx"), "export {};\n");
        await Deno.writeTextFile(
          join(directory, "notes.md"),
          "# not an atom\n",
        );
        await Deno.writeTextFile(join(directory, "helper.ts"), "export {};\n");
        await Deno.writeTextFile(
          join(directory, "atom.test.tsx"),
          "export {};\n",
        );
        await Deno.mkdir(join(directory, "demo"));
        const paths = await seedSourcePaths(directory);
        expect(paths.map((path) => path.split("/").pop())).toEqual([
          "atom.tsx",
        ]);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });

    it("finds every atom this seed publishes", async () => {
      const paths = await seedSourcePaths(join(REPO_ROOT, SEED_DIRECTORY));
      expect(paths.map((path) => path.split("/").pop())).toEqual([
        "amount-ledger.tsx",
        "check-list.tsx",
        "counter.tsx",
        "dice-roller.tsx",
        "option-picker.tsx",
        "sortable-table.tsx",
      ]);
    });
  });

  describe("every seeded atom", () => {
    it("carries a description, hashtags and keywords the index can rank on", async () => {
      const paths = await seedSourcePaths(join(REPO_ROOT, SEED_DIRECTORY));
      for (const path of paths) {
        const name = path.split("/").pop() ?? path;
        const metadata = seedMetadataFromSource(
          name,
          await Deno.readTextFile(path),
        );
        expect(metadata.description.length).toBeGreaterThan(40);
        expect(metadata.hashtags.length).toBeGreaterThan(2);
        expect(metadata.keywords.length).toBeGreaterThan(4);
      }
    });
  });

  describe("parseArguments()", () => {
    it("reads the dry-run flag, repeated --only names, and named settings", () => {
      const parsed = parseArguments([
        "--dry-run",
        "--only",
        "counter",
        "--only",
        "dice-roller",
        "--api-url",
        "http://localhost:8040",
      ]);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.only).toEqual(["counter", "dice-roller"]);
      expect(parsed.named.get("api-url")).toBe("http://localhost:8040");
      expect(parsed.help).toBe(false);
    });

    it("defaults to publishing every atom", () => {
      const parsed = parseArguments([]);
      expect(parsed.dryRun).toBe(false);
      expect(parsed.only).toEqual([]);
    });

    it("reads both spellings of help", () => {
      expect(parseArguments(["--help"]).help).toBe(true);
      expect(parseArguments(["-h"]).help).toBe(true);
    });

    it("refuses an argument it cannot place", () => {
      // A dropped flag would seed more than the caller asked for, against a
      // shared corpus, so an argument the parser cannot place stops the run.

      expect(() => parseArguments(["counter"])).toThrow(SeedUsageError);
    });

    it("refuses a flag whose value is missing", () => {
      expect(() => parseArguments(["--only"])).toThrow(/needs the name/);
      expect(() => parseArguments(["--api-url"])).toThrow(/needs a value/);
    });
  });

  describe("requiredSetting()", () => {
    const parsed = parseArguments(["--space", "from-flag"]);

    it("prefers the flag over the environment", () => {
      expect(requiredSetting(parsed, "space", "CF_SPACE", () => "from-env"))
        .toBe("from-flag");
    });

    it("falls back to the environment", () => {
      expect(
        requiredSetting(
          parseArguments([]),
          "space",
          "CF_SPACE",
          () => "from-env",
        ),
      ).toBe("from-env");
    });

    it("names the flag and the variable when neither supplies it", () => {
      expect(() =>
        requiredSetting(
          parseArguments([]),
          "space",
          "CF_SPACE",
          () => undefined,
        )
      ).toThrow(/--space is required \(or set CF_SPACE\)/);
    });

    it("treats an empty environment value as absent", () => {
      expect(() =>
        requiredSetting(parseArguments([]), "space", "CF_SPACE", () => "")
      ).toThrow(SeedUsageError);
    });
  });

  describe("USAGE", () => {
    it("names the directory the atoms are read from", () => {
      expect(USAGE).toContain(SEED_DIRECTORY);
    });
  });

  describe("runSeed()", () => {
    const directory = join(REPO_ROOT, SEED_DIRECTORY);

    interface Recorder {
      deps: SeedDeps;
      published: string[];
      recorded: string[];
      compiled: string[];
      lines: string[];
      errors: string[];
    }

    const recorder = (
      overrides: Partial<SeedDeps> = {},
    ): Recorder => {
      const published: string[] = [];
      const recorded: string[] = [];
      const compiled: string[] = [];
      const lines: string[] = [];
      const errors: string[] = [];
      const deps: SeedDeps = {
        compile: (path) => {
          compiled.push(path);
          return Promise.resolve({
            patternId: `id-for-${path.split("/").pop()}`,
            program: {
              main: "/main.tsx",
              files: [{ name: "/main.tsx", contents: "export {};" }],
            },
            argumentSchema: { type: "object" },
            resultSchema: { type: "object" },
          });
        },
        publish: (request) => {
          published.push(request.patternId);
          return Promise.resolve({
            patternId: request.patternId,
            created: true,
          });
        },
        recordCreated: (patternId) => {
          recorded.push(patternId);
          return Promise.resolve();
        },
        checkFormatting: () => Promise.resolve([]),
        log: (line) => lines.push(line),
        logError: (line) => errors.push(line),
        ...overrides,
      };
      return { deps, published, recorded, compiled, lines, errors };
    };

    it("publishes every atom and records a created event for each", async () => {
      const r = recorder();
      const code = await runSeed(
        { dryRun: false, only: [], directory },
        r.deps,
      );
      expect(code).toBe(0);
      expect(r.published.length).toBe(6);
      expect(r.recorded).toEqual(r.published);
      expect(r.lines.at(-1)).toContain("6 published, 0 already held");
    });

    it("publishes nothing in a dry run, having compiled everything", async () => {
      const r = recorder();
      const code = await runSeed({ dryRun: true, only: [], directory }, r.deps);
      expect(code).toBe(0);
      expect(r.compiled.length).toBe(6);
      expect(r.published).toEqual([]);
      expect(r.recorded).toEqual([]);
      expect(r.lines.at(-1)).toContain("nothing published");
    });

    it("prints the import specifier a composing pattern would write", async () => {
      const r = recorder();
      await runSeed({ dryRun: true, only: ["counter"], directory }, r.deps);
      expect(
        r.lines.some((line) => line.includes("cf:pattern:id-for-counter.tsx")),
      )
        .toBe(true);
    });

    it("seeds only the named atom", async () => {
      const r = recorder();
      await runSeed({ dryRun: false, only: ["counter"], directory }, r.deps);
      expect(r.published).toEqual(["id-for-counter.tsx"]);
    });

    it("records no event for an atom the index already holds", async () => {
      // Re-running must not create duplicates: the index answers
      // `created:false` for an identity it already holds, and that records no
      // further event.

      const r = recorder({
        publish: (request) =>
          Promise.resolve({ patternId: request.patternId, created: false }),
      });
      const code = await runSeed(
        { dryRun: false, only: [], directory },
        r.deps,
      );
      expect(code).toBe(0);
      expect(r.recorded).toEqual([]);
      expect(r.lines.at(-1)).toContain("0 published, 6 already held");
    });

    it("publishes nothing when an atom compiles to no durable identity", async () => {
      // An entry under a keyless identity could never be loaded by anything
      // else, so the run stops rather than seeding one.

      const r = recorder({
        compile: () =>
          Promise.resolve({
            program: {
              main: "/main.tsx",
              files: [{ name: "/main.tsx", contents: "export {};" }],
            },
          }),
      });
      const code = await runSeed(
        { dryRun: false, only: [], directory },
        r.deps,
      );
      expect(code).toBe(1);
      expect(r.published).toEqual([]);
      expect(r.errors.join("\n")).toContain("no durable content-addressed");
    });

    it("refuses a selection that matches no atom", async () => {
      const r = recorder();
      await expect(
        runSeed({ dryRun: true, only: ["nope"], directory }, r.deps),
      ).rejects.toThrow(SeedUsageError);
      expect(r.compiled).toEqual([]);
    });
  });

  describe("durableEntryIdentity()", () => {
    it("keeps a content-addressed identity", () => {
      expect(durableEntryIdentity("docnE_YXUkal8R92pI4Lz7zAg0w")).toBe(
        "docnE_YXUkal8R92pI4Lz7zAg0w",
      );
    });

    it("answers undefined for an absent identity", () => {
      expect(durableEntryIdentity(undefined)).toBeUndefined();
    });

    it("refuses a keyless identity", () => {
      // An entry published under a keyless identity could never be loaded by
      // any other runtime, so it must not reach the index at all.

      expect(durableEntryIdentity("keyless:abc123")).toBeUndefined();
    });
  });

  describe("resolveSettings()", () => {
    it("resolves every setting from the environment", () => {
      const env = (key: string) =>
        ({
          CF_HARNESS_FABRIC_API_URL: "http://localhost:8040",
          CF_HARNESS_FABRIC_IDENTITY: "/keys/agent.pkcs8",
          CF_HARNESS_FABRIC_SPACE: "seeds",
          CF_HARNESS_PATTERN_INDEX_URL: "https://index.example",
        })[key];
      expect(resolveSettings(parseArguments([]), env)).toEqual({
        apiUrl: "http://localhost:8040",
        identityKeyPath: "/keys/agent.pkcs8",
        space: "seeds",
        indexBaseUrl: "https://index.example",
      });
    });

    it("names the first setting nothing supplies", () => {
      expect(() => resolveSettings(parseArguments([]), () => undefined))
        .toThrow(/--api-url is required/);
    });
  });

  describe("compileAtom()", () => {
    it("answers a durable identity and the real argument schema for an atom", async () => {
      const signer = await Identity.fromPassphrase("seed-pattern-index test");
      const runtime = new Runtime(runtimePresets.patternTest({
        apiUrl: new URL(import.meta.url),
        storageManager: StorageManager.emulate({ as: signer }),
        experimental: experimentalOptionsFromEnv(Deno.env.get),
      }));
      try {
        const root = join(REPO_ROOT, "packages/patterns");
        const compiled = await compileAtom(
          runtime,
          signer.did(),
          join(root, "primitives/counter.tsx"),
          root,
        );
        // The identity is a content hash, so it is durable under any runtime.
        expect(compiled.patternId).toBeDefined();
        expect(durableEntryIdentity(compiled.patternId)).toBe(
          compiled.patternId,
        );
        expect(compiled.program.files.length).toBeGreaterThan(0);
        // The whole point of the seed: an atom that takes real inputs.
        const schema = compiled.argumentSchema as {
          properties?: Record<string, unknown>;
        };
        expect(Object.keys(schema.properties ?? {})).toEqual([
          "value",
          "step",
          "label",
          "min",
          "max",
        ]);
      } finally {
        await runtime.dispose?.();
      }
    });
  });

  describe("main()", () => {
    const io = (
      overrides: Partial<SeedIo> = {},
    ): {
      io: SeedIo;
      lines: string[];
      errors: string[];
      published: string[];
    } => {
      const lines: string[] = [];
      const errors: string[] = [];
      const published: string[] = [];
      return {
        lines,
        errors,
        published,
        io: {
          env: (key) =>
            ({
              CF_HARNESS_FABRIC_API_URL: "http://localhost:8040",
              CF_HARNESS_FABRIC_IDENTITY: "/keys/agent.pkcs8",
              CF_HARNESS_FABRIC_SPACE: "seeds",
              CF_HARNESS_PATTERN_INDEX_URL: "https://index.example",
            })[key],
          log: (line) => lines.push(line),
          logError: (line) => errors.push(line),
          repoRoot: REPO_ROOT,
          createDeps: (_settings, _root, log, logError) =>
            Promise.resolve({
              compile: (path) =>
                Promise.resolve({
                  patternId: `id-${path.split("/").pop()}`,
                  program: {
                    main: "/main.tsx",
                    files: [{ name: "/main.tsx", contents: "export {};" }],
                  },
                }),
              publish: (request) => {
                published.push(request.patternId);
                return Promise.resolve({
                  patternId: request.patternId,
                  created: true,
                });
              },
              recordCreated: () => Promise.resolve(),
              checkFormatting: () => Promise.resolve([]),
              log,
              logError,
            }),
          ...overrides,
        },
      };
    };

    it("seeds every atom and answers success", async () => {
      const h = io();
      expect(await main([], h.io)).toBe(0);
      expect(h.published.length).toBe(6);
    });

    it("publishes nothing on a dry run", async () => {
      const h = io();
      expect(await main(["--dry-run"], h.io)).toBe(0);
      expect(h.published).toEqual([]);
    });

    it("prints usage for --help without connecting to anything", async () => {
      const h = io({
        createDeps: () => Promise.reject(new Error("must not connect")),
      });
      expect(await main(["--help"], h.io)).toBe(0);
      expect(h.lines.join("\n")).toContain(
        "Usage: deno task seed-pattern-index",
      );
    });

    it("answers 2 and prints usage for an argument it cannot place", async () => {
      const h = io();
      expect(await main(["counter"], h.io)).toBe(2);
      expect(h.errors.join("\n")).toContain("unexpected argument");
      expect(h.published).toEqual([]);
    });

    it("answers 2 when a required setting is missing", async () => {
      const h = io({ env: () => undefined });
      expect(await main([], h.io)).toBe(2);
      expect(h.errors.join("\n")).toContain("--api-url is required");
    });

    it("answers 2 for a selection that matches no atom", async () => {
      const h = io();
      expect(await main(["--only", "nope"], h.io)).toBe(2);
      expect(h.published).toEqual([]);
    });

    it("answers 1 when the run fails for a reason that is not usage", async () => {
      const h = io({
        createDeps: () => Promise.reject(new Error("fabric unreachable")),
      });
      expect(await main([], h.io)).toBe(1);
      expect(h.errors.join("\n")).toContain("fabric unreachable");
    });

    it("answers 1 when an atom compiles to no durable identity", async () => {
      const h = io({
        createDeps: (_s, _r, log, logError) =>
          Promise.resolve({
            compile: () =>
              Promise.resolve({
                program: {
                  main: "/main.tsx",
                  files: [{ name: "/main.tsx", contents: "export {};" }],
                },
              }),
            publish: () => Promise.reject(new Error("must not publish")),
            recordCreated: () => Promise.reject(new Error("must not record")),
            checkFormatting: () => Promise.resolve([]),
            log,
            logError,
          }),
      });
      expect(await main([], h.io)).toBe(1);
    });
  });

  describe("defaultSeedIo()", () => {
    it("reads the environment and roots itself at the repository", () => {
      const io = defaultSeedIo();
      expect(io.repoRoot).toBe(REPO_ROOT);
      expect(io.createDeps).toBe(fabricSeedDeps);
      // Reads the real environment, and writes where a script writes.
      Deno.env.set("CF_SEED_IO_PROBE", "present");
      try {
        expect(io.env("CF_SEED_IO_PROBE")).toBe("present");
      } finally {
        Deno.env.delete("CF_SEED_IO_PROBE");
      }
      expect(io.env("CF_SEED_IO_ABSENT")).toBeUndefined();
      io.log("");
      io.logError("");
    });
  });

  describe("the formatting guard", () => {
    const directory = join(REPO_ROOT, SEED_DIRECTORY);

    it("publishes nothing when an atom is not formatted, and names it", async () => {
      // An entry identity is a hash of the source bytes, so publishing
      // unformatted source mints an id the repository cannot reproduce: the
      // next `deno fmt` changes the bytes and the same atom seeds again under a
      // second id. One atom, two entries, competing in search.

      const published: string[] = [];
      const errors: string[] = [];
      const compiled: string[] = [];
      const code = await runSeed({ dryRun: false, only: [], directory }, {
        compile: (path) => {
          compiled.push(path);
          return Promise.resolve({
            patternId: "id",
            program: { main: "/m.tsx", files: [] },
          });
        },
        publish: (request) => {
          published.push(request.patternId);
          return Promise.resolve({
            patternId: request.patternId,
            created: true,
          });
        },
        recordCreated: () => Promise.resolve(),
        checkFormatting: (paths) => Promise.resolve([paths[0]]),
        log: () => {},
        logError: (line) => errors.push(line),
      });
      expect(code).toBe(1);
      expect(published).toEqual([]);
      // Refused before anything compiles, so no id is minted at all.
      expect(compiled).toEqual([]);
      expect(errors.join("\n")).toContain(
        "changes the next time `deno fmt` runs",
      );
      expect(errors.join("\n")).toContain("amount-ledger.tsx");
    });

    it("proceeds when every atom is formatted", async () => {
      const published: string[] = [];
      const code = await runSeed({
        dryRun: false,
        only: ["counter"],
        directory,
      }, {
        compile: () =>
          Promise.resolve({
            patternId: "id",
            program: { main: "/m.tsx", files: [] },
          }),
        publish: (request) => {
          published.push(request.patternId);
          return Promise.resolve({
            patternId: request.patternId,
            created: true,
          });
        },
        recordCreated: () => Promise.resolve(),
        checkFormatting: () => Promise.resolve([]),
        log: () => {},
        logError: () => {},
      });
      expect(code).toBe(0);
      expect(published).toEqual(["id"]);
    });

    it("finds the committed atoms already formatted", async () => {
      // The guard is only as good as the check behind it, so the real one is
      // exercised against the atoms as committed.

      const paths = await seedSourcePaths(directory);
      expect(await denoFmtCheck(paths)).toEqual([]);
    });

    it("names only the unformatted file among several", async () => {
      // Deliberately mixes a formatted file in with the unformatted one, and
      // asserts BOTH that the offender is named and that the innocent file is
      // not. Given a single path those two claims coincide with "blame
      // everything I was given", which is what `denoFmtCheck` falls back to
      // when it cannot read deno's answer — so a one-file version of this test
      // passes against a parse that never worked, and passed against a fixture
      // that did not exist at all.

      // Written outside the repository so the repo's own formatting gates
      // cannot rewrite the thing under test.
      const directory = await Deno.makeTempDir();
      try {
        const unformatted = join(directory, "unformatted.ts");
        const formatted = join(directory, "formatted.ts");
        await Deno.writeTextFile(
          unformatted,
          "export const   x   =    {a:1,   b:2}\n",
        );
        await Deno.writeTextFile(formatted, "export const y = 1;\n");
        const named = await denoFmtCheck([formatted, unformatted]);
        expect(named.length).toBe(1);
        // deno reports the path it resolved, so compare by what it names.
        expect(named[0].endsWith("unformatted.ts")).toBe(true);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });

    it("refuses everything it was given when deno names no file", async () => {
      // The fallback itself: a non-zero exit deno named no file for is still a
      // refusal to publish, because seeding on an unreadable answer is the
      // silence this guard exists to prevent.

      const directory = await Deno.makeTempDir();
      await Deno.remove(directory, { recursive: true });
      const absent = join(directory, "gone.ts");
      expect(await denoFmtCheck([absent])).toEqual([absent]);
    });
  });

  describe("seedDepsFrom()", () => {
    const client = () => {
      const published: string[] = [];
      const events: string[] = [];
      return {
        published,
        events,
        get: () =>
          Promise.resolve({
            publishPattern: (request: { patternId: string }) => {
              published.push(request.patternId);
              return Promise.resolve({
                patternId: request.patternId,
                created: true,
              });
            },
            recordEvent: (
              request: { patternId: string; eventType: string },
            ) => {
              events.push(`${request.patternId}:${request.eventType}`);
              return Promise.resolve({ ok: true });
            },
          }),
      };
    };

    const depsOver = (c: ReturnType<typeof client>) => {
      const lines: string[] = [];
      return {
        lines,
        deps: seedDepsFrom({
          // Never called in these cases; `compileAtom` is covered on its own
          // against a real runtime.
          runtime: {} as never,
          space: "did:key:zTest" as never,
          getClient: c.get,
          patternsRoot: "/repo/packages/patterns",
          log: (line: string) => lines.push(line),
          logError: () => {},
        }),
      };
    };

    it("publishes through the client it was given", async () => {
      const c = client();
      const { deps } = depsOver(c);
      const response = await deps.publish(
        { patternId: "abc", program: { main: "/m", files: [] } } as never,
      );
      expect(response).toEqual({ patternId: "abc", created: true });
      expect(c.published).toEqual(["abc"]);
    });

    it("records a created event through the same client", async () => {
      const c = client();
      const { deps } = depsOver(c);
      await deps.recordCreated("abc");
      expect(c.events).toEqual(["abc:created"]);
    });

    it("logs through the callbacks it was given", () => {
      const c = client();
      const { deps, lines } = depsOver(c);
      deps.log("hello");
      expect(lines).toEqual(["hello"]);
    });

    it("checks formatting with the repository's own formatter", () => {
      const c = client();
      const { deps } = depsOver(c);
      expect(deps.checkFormatting).toBe(denoFmtCheck);
    });
  });

  describe("fabricSeedDeps()", () => {
    const settings = {
      apiUrl: "http://localhost:8060",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "seeds",
      indexBaseUrl: "https://index.example",
    };

    it("wires the fabric settings to the session and the index URL to the client", async () => {
      // Which setting reaches the fabric and which reaches the index are both
      // strings, so wiring one to the other compiles and fails only in the
      // deployment. This is the assertion that catches it.

      let sessionArgs: unknown;
      let clientArgs: unknown[] = [];
      const deps = await fabricSeedDeps(
        settings,
        "/repo/packages/patterns",
        () => {},
        () => {},
        ((config: unknown) => {
          sessionArgs = config;
          return () =>
            Promise.resolve({
              pieces: {
                runtime: {} as never,
                getSpace: () => "did:key:zSpace",
              },
            });
        }) as never,
        ((...args: unknown[]) => {
          clientArgs = args;
          return () => Promise.resolve({} as never);
        }) as never,
      );
      expect(sessionArgs).toEqual({
        apiUrl: "http://localhost:8060",
        identityKeyPath: "/keys/agent.pkcs8",
        space: "seeds",
      });
      expect(clientArgs[0]).toEqual({ baseUrl: "https://index.example" });
      expect(clientArgs[1]).toBe("/keys/agent.pkcs8");
      expect(deps.checkFormatting).toBe(denoFmtCheck);
    });

    it("fails when the identity keyfile is absent", async () => {
      // Exercises the constructions it performs by default rather than the
      // stand-ins, and fails on the keyfile before reaching any network.

      await expect(
        fabricSeedDeps(
          { ...settings, identityKeyPath: "/keys/definitely-absent.pkcs8" },
          "/repo/packages/patterns",
          () => {},
          () => {},
        ),
      ).rejects.toThrow();
    });
  });

  describe("as a program", () => {
    it("prints usage and exits zero", async () => {
      // The one path that runs the file as a script rather than importing it.
      // `--help` neither connects to a fabric nor writes anything, so this is a
      // smoke test of the entry point itself: it parses, prints, and exits 0.
      //
      // Runs through the isolated-lock helper, which points the child at a copy
      // of `deno.lock` so resolving dependencies cannot rewrite the real one,
      // and which spawns `Deno.execPath()` rather than whichever `deno` is on
      // PATH — a different Deno reads transpiled sources from its own part of
      // the cache, and reports coverage with every file missing.

      const output = await runDenoCommandWithTemporaryLock({
        root: REPO_ROOT,
        args: (lock) => [
          "run",
          "--allow-read",
          "--allow-env",
          `--lock=${lock}`,
          join(REPO_ROOT, "packages/cf-harness/scripts/seed-pattern-index.ts"),
          "--help",
        ],
      });
      expect(output.code).toBe(0);
      expect(new TextDecoder().decode(output.stdout)).toContain(
        "Usage: deno task seed-pattern-index",
      );
    });
  });

  describe("publishRequestFor()", () => {
    const entry = {
      name: "counter",
      path: "/repo/packages/patterns/primitives/counter.tsx",
      metadata: {
        description: "Counts a number up and down.",
        hashtags: ["counter"],
        keywords: ["count"],
      },
      patternId: "abc123",
      program: {
        main: "/primitives/counter.tsx",
        files: [{ name: "/primitives/counter.tsx", contents: "export {};" }],
      },
      argumentSchema: { type: "object" },
      resultSchema: { type: "object" },
    };

    it("publishes under the compiled entry identity and carries the derived metadata", () => {
      const request = publishRequestFor(entry);
      expect(request.patternId).toBe("abc123");
      expect(request.description).toBe("Counts a number up and down.");
      expect(request.hashtags).toEqual(["counter"]);
      expect(request.keywords).toEqual(["count"]);
      expect(request.program.main).toBe("/primitives/counter.tsx");
    });

    it("publishes the curated atom discoverably", () => {
      expect(publishRequestFor(entry).discoverable).toBe(true);
    });

    it("answers no dependencies for an atom that imports no published pattern", () => {
      expect(publishRequestFor(entry).dependencies).toEqual([]);
    });

    it("reports the published patterns an atom composes", () => {
      const request = publishRequestFor({
        ...entry,
        program: {
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: 'import X from "cf:pattern:dep-1";',
          }],
        },
      });
      expect(request.dependencies).toEqual(["dep-1"]);
    });
  });
});
