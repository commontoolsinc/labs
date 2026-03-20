import { describe, it } from "@std/testing/bdd";
import { assert, assertRejects } from "@std/assert";
import { COMMONTOOLS_TYPES } from "./commontools-test-types.ts";
import { transformFiles, transformSource } from "./utils.ts";

const fixture = `
import { toSchema } from "commontools";

interface Config {
  value: number;
}

const configSchema = toSchema<Config>({
  default: { value: 42 },
  description: "Configuration schema"
});
export { configSchema };
`;

describe("CommonToolsTransformerPipeline", () => {
  it("Filters transformations if <cts-enabled /> not provided", async () => {
    const disabled = await transformFiles({
      "/main.ts": fixture,
    });
    assert(
      !/import \* as __ctHelpers/.test(disabled["/main.ts"]!),
      "no replacements without <cts-enable />",
    );
    const enabled = await transformFiles({
      "/main.ts": `/// <cts-enable />\n` + fixture,
    });
    assert(
      /import \* as __ctHelpers/.test(enabled["/main.ts"]!),
      "no replacements without <cts-enable />",
    );
  });

  it("transforms only files marked with <cts-enable /> in multi-file programs", async () => {
    const output = await transformFiles({
      "/main.tsx": [
        "/// <cts-enable />",
        "import { helper } from './utils.ts';",
        "export default helper;",
      ].join("\n"),
      "/utils.ts": [
        "import { toSchema } from 'commontools';",
        "export const helper = toSchema<{ value: number }>({",
        "  default: { value: 1 },",
        "});",
      ].join("\n"),
    });

    assert(
      /import \* as __ctHelpers/.test(output["/main.tsx"]!),
      "cts-enabled entrypoints should be transformed",
    );
    assert(
      !/import \* as __ctHelpers/.test(output["/utils.ts"]!),
      "plain helper modules should remain untransformed",
    );
  });
});

describe("CTHelpers handling", () => {
  it("Throws if __ctHelpers variable is used in source", async () => {
    const statements = [
      "function __ctHelpers() {}",
      "function foo(): number { var __ctHelpers = 5; return __ctHelpers; }",
      "var __ctHelpers: number = 5;",
      "declare global { var __ctHelpers: any; }\nglobalThis.__ctHelpers = 5;",
    ];

    for (const statement of statements) {
      await assertRejects(() =>
        transformFiles({
          "/main.ts": fixture + `\n${statement}`,
        })
      );
    }
  });

  it("Allows '__ctHelpers' in comments and in other forms", async () => {
    const statements = [
      "var x = 5; // __ctHelpers",
      "// __ctHelpers",
      "/* __ctHelpers */",
      "var __ctHelpers123: number = 5;",
      "declare global {\nvar __ctHelpers1: any;\n}\nglobalThis.__ctHelpers1 = 5;",
    ];
    for (const statement of statements) {
      await transformFiles({
        "/main.ts": fixture + `\n${statement}`,
      });
    }
  });

  it("keeps the __ctHelpers import without injecting a local h shim", async () => {
    const output = await transformSource(
      `/// <cts-enable />
      const view = <div>Hello</div>;
      export default view;
    `,
      {
        types: COMMONTOOLS_TYPES,
        typeCheck: true,
      },
    );

    assert(
      output.includes('import * as __ctHelpers from "commontools";'),
      "__ctHelpers import should be retained for later JSX/helper emit",
    );
    assert(
      output.includes("void __ctHelpers;"),
      "namespace import should stay alive without a local helper shim",
    );
    assert(
      !output.includes("function h("),
      "local h shim should no longer be injected",
    );
    assert(
      !output.includes("h.fragment = __ctHelpers.h.fragment"),
      "fragment shim should no longer be injected",
    );
  });
});

describe("Builder symbol resolution", () => {
  it("rewrites const aliases to computed()", async () => {
    const output = await transformSource(
      `/// <cts-enable />
      import { computed } from "commontools";

      const alias = computed;

      export default alias(() => 1);
    `,
      { types: COMMONTOOLS_TYPES },
    );

    assert(
      output.includes("__ctHelpers.derive("),
      "const aliases to computed() should still lower to derive()",
    );
  });

  it("does not rewrite a shadowed local computed helper", async () => {
    const output = await transformSource(
      `/// <cts-enable />
      function computed<T>(fn: () => T): T {
        return fn();
      }

      export default computed(() => 1);
    `,
      { types: COMMONTOOLS_TYPES },
    );

    assert(
      !output.includes("__ctHelpers.derive("),
      "shadowed local helpers named computed should not lower to derive()",
    );
  });

  it("does not rewrite reassigned computed aliases", async () => {
    const output = await transformSource(
      `/// <cts-enable />
      import { computed } from "commontools";

      let alias = computed;
      alias = ((fn: () => number) => fn()) as typeof alias;

      export default alias(() => 1);
    `,
      { types: COMMONTOOLS_TYPES },
    );

    assert(
      !output.includes("__ctHelpers.derive("),
      "mutable aliases should not be treated as stable computed() references",
    );
  });
});
