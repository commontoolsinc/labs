import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

// End-to-end differential verifier parity oracle (Phase 3 / D3 of
// docs/specs/module-loading-implementation-plan.md) — the release gate that must
// be green before `CF_ESM_MODULE_LOADER` can be flipped on by default.
//
// `esm-verifier-parity.test.ts` feeds crafted *compiled* bodies straight to
// `verifyCompiledModuleBody`. This runs the SAME authored TypeScript source
// through BOTH real compile paths and asserts the two verifiers reach the SAME
// accept/reject verdict:
//
//   AMD: Engine.compile()            → bundle pre-flight + classification
//   ESM: Engine.compileToRecordGraph → per-module body classification + graph
//
// Both methods verify unconditionally and WITHOUT evaluating, so the verdict is
// the verifier's alone. The AMD verifier is the trusted oracle; a divergence
// (one path accepts what the other rejects) is the release blocker.
//
// Two layers of coverage:
//   1. Synthetic fixtures — exercise the REJECT surface (real patterns never
//      contain SES violations, so reject-parity can only be tested with crafted
//      sources) plus a few key accept shapes.
//   2. The real pattern corpus (`packages/patterns/*.tsx`) — the same top-level
//      set `all.test.ts` ("Compile all patterns") compiles+executes on the AMD
//      path, so every file is a known AMD-accept. The ESM verifier must accept
//      each one too; an ESM rejection of a shipped pattern is the divergence the
//      gate exists to catch.

const signer = await Identity.fromPassphrase(
  "esm verifier differential oracle",
);

// Top-level pattern corpus (non-recursive), matching `all.test.ts`. Subdirs hold
// multi-file sub-modules that are not standalone compile entry points.
const CORPUS_DIR = join(import.meta.dirname!, "..", "..", "patterns");

// Files under the corpus dir that are not standalone compilable patterns.
// Mirrors `all.test.ts`'s skip list.
const CORPUS_SKIP = new Set<string>([
  // (none beyond non-.tsx / subdir entries today; add with justification)
]);

type Verdict = { accepted: boolean; error?: string };

interface Fixture {
  readonly name: string;
  /** Authored entry-module source. */
  readonly main: string;
  /** Extra files (multi-module fixtures), keyed by absolute path. */
  readonly extra?: Readonly<Record<string, string>>;
  readonly expect: "accept" | "reject";
}

const IMPORT =
  `import { Cell, __cf_data, computed, handler, pattern } from "commonfabric";`;

const FIXTURES: readonly Fixture[] = [
  // ---- Accept: valid authored patterns ----
  {
    name: "minimal pattern default export",
    main: `${IMPORT}\nexport default pattern(() => ({ value: 1 }));`,
    expect: "accept",
  },
  {
    name: "handler + pattern wiring",
    main: [
      IMPORT,
      "const inc = handler<unknown, { count: Cell<number> }>(",
      "  (_e, { count }) => { count.set(count.get() + 1); },",
      ");",
      "export default pattern<{ count: number }>(({ count }) => {",
      "  return { count, inc: inc({ count }) };",
      "});",
    ].join("\n"),
    expect: "accept",
  },
  {
    name: "computed value",
    main: [
      IMPORT,
      "export default pattern(() => {",
      "  return { doubled: computed(() => 42) };",
      "});",
    ].join("\n"),
    expect: "accept",
  },
  // The CF transformer wraps top-level object/call-result const exports so the
  // authored forms are safe — both verifiers accept (the raw, un-transformed
  // compiled-body forms are rejected by esm-verifier-parity.test.ts instead).
  {
    name: "object-literal const export (transformer-wrapped)",
    main: `export const config = { a: 1, b: 2 };\n` +
      `export default function f() { return config; }`,
    expect: "accept",
  },
  {
    name: "top-level call-result const export (transformer-wrapped)",
    main: `const parsed = JSON.parse("{}");\n` +
      `export default function f() { return parsed; }`,
    expect: "accept",
  },
  {
    name: "__cf_data-wrapped mutable config export",
    main: `${IMPORT}\nexport const config = __cf_data({ a: 1, b: 2 });\n` +
      `export default pattern(() => ({ value: 1 }));`,
    expect: "accept",
  },
  {
    name: "multi-module: entry imports a helper",
    main: `import { helper } from "./util.ts";\n${IMPORT}\n` +
      `export default pattern(() => ({ value: helper(1) }));`,
    extra: { "/util.ts": "export const helper = (x: number) => x + 1;" },
    expect: "accept",
  },

  // ---- Reject: SES module-item violations ----
  {
    name: "top-level mutable binding (let)",
    main: [
      "let leaked = 0;",
      "export default function next() {",
      "  leaked += 1;",
      "  return leaked;",
      "}",
    ].join("\n"),
    expect: "reject",
  },
  {
    name: "top-level class declaration export",
    main: `export class Foo { x = 1; }\n` +
      `export default function f() { return new Foo(); }`,
    expect: "reject",
  },
  {
    name: "top-level generator declaration export",
    main: `export function* gen() { yield 1; }\n` +
      `export default function f() { return gen(); }`,
    expect: "reject",
  },
  {
    name: "import from a disallowed specifier (node:fs)",
    main: `import * as fs from "node:fs";\n` +
      `export default function f() { return fs; }`,
    expect: "reject",
  },
  {
    name: "dynamic import attempt",
    main: [
      IMPORT,
      "export default pattern(() => {",
      '  const p = import("./evil.ts");',
      "  return { p };",
      "});",
    ].join("\n"),
    extra: { "/evil.ts": "export const x = 1;" },
    expect: "reject",
  },
];

async function verdict(run: () => Promise<unknown>): Promise<Verdict> {
  try {
    await run();
    return { accepted: true };
  } catch (error) {
    return {
      accepted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

let runtime: Runtime;
let engine: Engine;
let storageManager: ReturnType<typeof StorageManager.emulate>;

function setup() {
  storageManager = StorageManager.emulate({ as: signer });
  runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  engine = runtime.harness as Engine;
}

async function teardown() {
  await runtime?.dispose();
  await storageManager?.close();
}

/** Run both verifiers on a program and assert they reach the same verdict. */
async function assertParity(
  program: RuntimeProgram,
  context: string,
): Promise<Verdict> {
  const amd = await verdict(() => engine.compile(program));
  const esm = await verdict(() => engine.compileToRecordGraph(program));
  expect(
    esm.accepted,
    `${context}: verdict divergence — AMD ${
      amd.accepted ? "accepted" : `rejected (${amd.error})`
    }, ESM ${esm.accepted ? "accepted" : `rejected (${esm.error})`}`,
  ).toBe(amd.accepted);
  return amd;
}

describe("ESM↔AMD verifier differential parity (synthetic fixtures)", () => {
  beforeAll(setup);
  afterAll(teardown);

  for (const f of FIXTURES) {
    it(`${f.expect}: ${f.name}`, async () => {
      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          { name: "/main.tsx", contents: f.main },
          ...Object.entries(f.extra ?? {}).map(([name, contents]) => ({
            name,
            contents,
          })),
        ],
      };

      const amd = await assertParity(program, f.name);
      // The shared verdict must match the documented expectation.
      expect(amd.accepted).toBe(f.expect === "accept");
    });
  }
});

describe("ESM↔AMD verifier differential parity (pattern corpus)", () => {
  beforeAll(setup);
  afterAll(teardown);

  const corpus: string[] = [];
  for (const e of Deno.readDirSync(CORPUS_DIR)) {
    if (!e.isFile || !e.name.endsWith(".tsx")) continue;
    if (CORPUS_SKIP.has(e.name)) continue;
    corpus.push(e.name);
  }
  corpus.sort();

  it("found the corpus", () => {
    // Guard against a silently-empty walk (wrong path / moved corpus) turning
    // the gate into a no-op.
    expect(corpus.length).toBeGreaterThan(20);
  });

  for (const name of corpus) {
    it(`parity: ${name}`, async () => {
      const program = await engine.resolve(
        new FileSystemProgramResolver(join(CORPUS_DIR, name), CORPUS_DIR),
      );
      const amd = await assertParity(program, name);
      // Every shipped top-level pattern compiles+executes on AMD (all.test.ts),
      // so the trusted oracle must accept it. If this fails, the corpus changed
      // shape (or AMD regressed) — investigate before trusting the parity result.
      expect(amd.accepted, `${name}: AMD oracle unexpectedly rejected`).toBe(
        true,
      );
    });
  }
});
