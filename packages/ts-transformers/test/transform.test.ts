import { describe, it } from "@std/testing/bdd";
import { assert, assertRejects } from "@std/assert";
import { transformFiles } from "./utils.ts";

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
});
