import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

// End-to-end differential verifier parity oracle (Phase 3 / D3 of
// docs/specs/module-loading.md). Unlike `esm-verifier-parity.test.ts` — which
// feeds crafted *compiled* bodies straight to `verifyCompiledModuleBody` — this
// runs the SAME authored TypeScript source through BOTH real compile paths and
// asserts the two verifiers reach the SAME accept/reject verdict:
//
//   AMD: Engine.compile()            → bundle pre-flight + classification
//   ESM: Engine.compileToRecordGraph → per-module body classification + graph
//
// Both methods verify unconditionally and without evaluating, so the verdict is
// the verifier's alone. A divergence (one path accepts what the other rejects)
// is the release blocker that gates flipping `CF_ESM_MODULE_LOADER` on by
// default — the AMD verifier is the trusted oracle the ESM port must match.

const signer = await Identity.fromPassphrase(
  "esm verifier differential oracle",
);

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

async function verdict(
  run: () => Promise<unknown>,
): Promise<Verdict> {
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

describe("ESM↔AMD verifier differential parity (authored source, both paths)", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

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

      const amd = await verdict(() => engine.compile(program));
      const esm = await verdict(() => engine.compileToRecordGraph(program));

      // The core invariant: both verifiers reach the same verdict. A mismatch
      // is a genuine divergence and the release blocker for default-on.
      expect(
        esm.accepted,
        `verdict divergence — AMD ${
          amd.accepted ? "accepted" : `rejected (${amd.error})`
        }, ESM ${esm.accepted ? "accepted" : `rejected (${esm.error})`}`,
      ).toBe(amd.accepted);

      // And the shared verdict matches the documented expectation.
      expect(amd.accepted).toBe(f.expect === "accept");
    });
  }
});
