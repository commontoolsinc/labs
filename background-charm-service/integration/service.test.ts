import { describe, it } from "@std/testing/bdd";
import { BackgroundCharmService } from "../src/lib.ts";
import { getIdentity } from "../src/utils.ts";
import { storage } from "@commontools/runner";

const identity = await getIdentity(
  Deno.env.get("IDENTITY"),
  Deno.env.get("OPERATOR_PASS"),
);
const toolshedUrl = Deno.env.get("TOOLSHED_API_URL");
if (!toolshedUrl) {
  throw new Error("TOOLSHED_API_URL not defined.");
}

describe("background-charm-service", () => {
  it("runs", async () => {
    const service = new BackgroundCharmService({
      identity,
      toolshedUrl,
      storage,
    });
    await service.initialize();
  });
});
