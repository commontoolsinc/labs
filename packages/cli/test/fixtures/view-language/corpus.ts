import type { TokenClass } from "../../../lib/view/model.ts";

/**
 * Source evidence whose token class proves that a language highlighter ran.
 */
export interface HighlightEvidence {
  readonly text: string;
  readonly className: TokenClass;
}

/** Selection paths exercised for one surveyed language fixture. */
export interface SelectionCases {
  readonly filenames: readonly string[];
  readonly aliases: readonly string[];
  readonly shebangs?: readonly string[];
}

/**
 * One source family in the shared `cf view` language fixture corpus.
 *
 * The repository, commit, and path identify a file in the frozen coverage
 * survey. The checked-in sources reduce that file to the syntax needed by the
 * fixture contract, then adapt it into before, after, and incomplete states.
 */
export interface ViewLanguageFixture {
  readonly languageId: string;
  readonly surveyRepository: string;
  readonly surveyCommit: string;
  readonly surveyPath: string;
  readonly before: URL;
  readonly after: URL;
  readonly incomplete: URL;
  readonly selection: SelectionCases;
  readonly beforeEvidence: HighlightEvidence;
  readonly afterEvidence: HighlightEvidence;
  readonly incompleteEvidence: HighlightEvidence;
}

/** Text-language fixtures covered by the shared language contract. */
export const VIEW_LANGUAGE_FIXTURES: readonly ViewLanguageFixture[] = [
  {
    languageId: "typescript",
    surveyRepository: "labs",
    surveyCommit: "a09656c3342bf3e34b68c5f754c25473acb0afef",
    surveyPath: "packages/patterns/counter/counter.tsx",
    before: new URL("./typescript/before.tsx", import.meta.url),
    after: new URL("./typescript/after.tsx", import.meta.url),
    incomplete: new URL("./typescript/incomplete.fixture", import.meta.url),
    selection: {
      filenames: [
        "packages/patterns/counter/counter.tsx",
        "src/runtime.ts",
        "scripts/check.mts",
        "scripts/check.cts",
        "web/client.js",
        "web/client.jsx",
        "tools/inspect.mjs",
        "tools/inspect.cjs",
      ],
      aliases: ["typescript", "ts", "javascript", "js"],
      shebangs: [
        "#!/usr/bin/env -S deno run -A",
        "#!/usr/bin/env node",
        "#!/usr/bin/nodejs",
        "#!/usr/bin/env bun",
      ],
    },
    beforeEvidence: { text: "pattern", className: "builderCall" },
    afterEvidence: { text: "pattern", className: "builderCall" },
    incompleteEvidence: { text: "`Count: ${", className: "template" },
  },
  {
    languageId: "markdown",
    surveyRepository: "specs",
    surveyCommit: "57d00d343109b34e279a11efcb8517ff0e25e9c4",
    surveyPath: "attention-framework/README.md",
    before: new URL("./markdown/before.md", import.meta.url),
    after: new URL("./markdown/after.md", import.meta.url),
    incomplete: new URL("./markdown/incomplete.fixture", import.meta.url),
    selection: {
      filenames: [
        "attention-framework/README.md",
        "notes.markdown",
        "guide.mdown",
        "guide.mkd",
        "guide.mdx",
      ],
      aliases: ["markdown", "md"],
    },
    beforeEvidence: {
      text: "# Attention Framework",
      className: "sectionHeader",
    },
    afterEvidence: {
      text: "# Attention Framework revision",
      className: "sectionHeader",
    },
    incompleteEvidence: { text: "```ts", className: "punctuation" },
  },
  {
    languageId: "json",
    surveyRepository: "labs",
    surveyCommit: "a09656c3342bf3e34b68c5f754c25473acb0afef",
    surveyPath: "deno.jsonc",
    before: new URL("./json/before.jsonc", import.meta.url),
    after: new URL("./json/after.jsonc", import.meta.url),
    incomplete: new URL("./json/incomplete.fixture", import.meta.url),
    selection: {
      filenames: [
        "deno.jsonc",
        "package.json",
        "settings.jsonc.example",
        "tasks/test-identity-aliases.jsonl",
        "tests/fixtures/location.point.sample.ndjson",
      ],
      aliases: ["json", "jsonc", "jsonl", "ndjson"],
    },
    beforeEvidence: { text: '"tasks"', className: "propertyName" },
    afterEvidence: { text: '"tasks"', className: "propertyName" },
    incompleteEvidence: { text: '"workspace"', className: "propertyName" },
  },
  {
    languageId: "yaml",
    surveyRepository: "common-cluster",
    surveyCommit: "50c7f1bb0b83dad6057b3bde73ce599f86624084",
    surveyPath: ".github/workflows/ci.yml",
    before: new URL("./yaml/before.yml", import.meta.url),
    after: new URL("./yaml/after.yml", import.meta.url),
    incomplete: new URL("./yaml/incomplete.yml", import.meta.url),
    selection: {
      filenames: [
        ".github/workflows/ci.yml",
        "deploy/config.yaml",
      ],
      aliases: ["yaml", "yml"],
    },
    beforeEvidence: { text: "jobs", className: "propertyName" },
    afterEvidence: { text: "jobs", className: "propertyName" },
    incompleteEvidence: { text: "script", className: "propertyName" },
  },
  {
    languageId: "python",
    surveyRepository: "loom",
    surveyCommit: "43a4afe18fbfc37ab8a11da8fe5011f0be81f6e7",
    surveyPath: "src/bin/loom-size-report.py",
    before: new URL("./python/before.py", import.meta.url),
    after: new URL("./python/after.py", import.meta.url),
    incomplete: new URL("./python/incomplete.py", import.meta.url),
    selection: {
      filenames: [
        "src/bin/loom-size-report.py",
        "src/loom/types.pyi",
        "tools/app.pyw",
      ],
      aliases: ["python", "py"],
      shebangs: [
        "#!/usr/bin/python3",
        "#!/usr/bin/env python",
        "#!/usr/bin/env pypy3",
      ],
    },
    beforeEvidence: { text: "count_items", className: "functionName" },
    afterEvidence: { text: "count_items", className: "functionName" },
    incompleteEvidence: { text: "count_items", className: "functionName" },
  },
  {
    languageId: "plain-text",
    surveyRepository: "raia",
    surveyCommit: "6b9cc95befe5f7cf0929eb569d9a1157e62d2374",
    surveyPath: "LICENSE",
    before: new URL("./plain-text/before", import.meta.url),
    after: new URL("./plain-text/after", import.meta.url),
    incomplete: new URL("./plain-text/incomplete", import.meta.url),
    selection: {
      filenames: [
        "harness/tasks_postmortem_declines/bay_261_sticky_ids",
        "notes.txt",
        "LICENSE",
        "NOTICE",
        "LICENSE.third-party",
        "NOTICE.third-party",
      ],
      aliases: ["plain-text", "text", "plaintext"],
    },
    beforeEvidence: {
      text: "# Permission to use, copy, and modify",
      className: "plain",
    },
    afterEvidence: {
      text: "# Permission to use, copy, and distribute",
      className: "plain",
    },
    incompleteEvidence: {
      text: "# THE SOFTWARE IS PROVIDED “AS IS",
      className: "plain",
    },
  },
];
