import { env } from "@commontools/integration";
import { CharmsController } from "@commontools/charm/ops";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import { Identity } from "@commontools/identity";

const { API_URL, SPACE_NAME } = env;

// TODO(CT-844): Re-enable these patterns once
// we can submit charms without running them locally.
const DISABLED_PATTERNS = (await Deno.readTextFile(
  join(
    import.meta.dirname!,
    "..",
    "DISABLED_PATTERNS.txt",
  ),
)).split("\n").map((p: string) => p.trim());

describe("Compile all recipes", () => {
  for (const file of Deno.readDirSync(join(import.meta.dirname!, ".."))) {
    const { name } = file;
    if (!name.endsWith(".tsx")) continue;
    if (DISABLED_PATTERNS.includes(name)) continue;

    let cc: CharmsController;
    let identity: Identity;

    beforeAll(async () => {
      identity = await Identity.generate();
      cc = await CharmsController.initialize({
        spaceName: SPACE_NAME,
        apiUrl: new URL(API_URL),
        identity: identity,
      });
    });

    afterAll(async () => {
      if (cc) await cc.dispose();
    });

    it(`Executes: ${name}`, async () => {
      const charm = await cc!.create(
        await Deno.readTextFile(
          join(
            import.meta.dirname!,
            "..",
            name,
          ),
        ),
      );
      assert(charm.id, `Received charm ID ${charm.id} for ${name}.`);
    });
  }
});
