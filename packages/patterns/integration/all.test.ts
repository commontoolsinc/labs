import { env } from "@commontools/integration";
import { registerCharm } from "@commontools/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import { Identity } from "@commontools/identity";

const { API_URL, SPACE_NAME } = env;

describe("Compile all recipes", () => {
  for (const file of Deno.readDirSync(join(import.meta.dirname!, ".."))) {
    const { name } = file;
    if (!name.endsWith(".tsx")) continue;

    it(`Executes: ${name}`, async () => {
      const identity = await Identity.generate();
      const charmId = await registerCharm({
        spaceName: SPACE_NAME,
        apiUrl: new URL(API_URL),
        identity: identity,
        source: await Deno.readTextFile(
          join(
            import.meta.dirname!,
            "..",
            name,
          ),
        ),
      });
      assert(charmId, `Received charm ID for ${name}.`);
    });
  }
});
