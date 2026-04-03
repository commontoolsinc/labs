import { describe, it } from "@std/testing/bdd";
import { assert, assertRejects } from "@std/assert";
import { transformFiles } from "./utils.ts";

const fixture = `
import { toSchema } from "commonfabric";

interface Config {
  value: number;
}

const configSchema = toSchema<Config>({
  default: { value: 42 },
  description: "Configuration schema"
});
export { configSchema };
`;

describe("CommonFabricTransformerPipeline", () => {
  it("Filters transformations if <cts-enabled /> not provided", async () => {
    const disabled = await transformFiles({
      "/main.ts": fixture,
    });
    assert(
      !/import \* as __cfHelpers/.test(disabled["/main.ts"]!),
      "no replacements without <cts-enable />",
    );
    const enabled = await transformFiles({
      "/main.ts": `/// <cts-enable />\n` + fixture,
    });
    assert(
      /import \* as __cfHelpers/.test(enabled["/main.ts"]!),
      "no replacements without <cts-enable />",
    );
  });
});

describe("CFHelpers handling", () => {
  it("Throws if __cfHelpers variable is used in source", async () => {
    const statements = [
      "function __cfHelpers() {}",
      "function foo(): number { var __cfHelpers = 5; return __cfHelpers; }",
      "var __cfHelpers: number = 5;",
      "declare global { var __cfHelpers: any; }\nglobalThis.__cfHelpers = 5;",
    ];

    for (const statement of statements) {
      await assertRejects(() =>
        transformFiles({
          "/main.ts": fixture + `\n${statement}`,
        })
      );
    }
  });

  it("Allows '__cfHelpers' in comments and in other forms", async () => {
    const statements = [
      "var x = 5; // __cfHelpers",
      "// __cfHelpers",
      "/* __cfHelpers */",
      "var __cfHelpers123: number = 5;",
      "declare global {\nvar __cfHelpers1: any;\n}\nglobalThis.__cfHelpers1 = 5;",
    ];
    for (const statement of statements) {
      await transformFiles({
        "/main.ts": fixture + `\n${statement}`,
      });
    }
  });
});
