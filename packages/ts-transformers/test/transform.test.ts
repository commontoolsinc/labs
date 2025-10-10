import { describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
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
