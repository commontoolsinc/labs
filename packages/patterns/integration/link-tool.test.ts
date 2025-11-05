import { env } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-runtime";

const { API_URL, SPACE_NAME } = env;

describe("link-tool test", () => {
  let identity: Identity;
  let cc: CharmsController;
  let sourceCharm: CharmController;
  let targetCharm: CharmController;
  let linkTool: CharmController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });

    // Create source counter charm
    const counterPath = join(import.meta.dirname!, "..", "counter.tsx");
    const counterProgram = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(counterPath),
    );
    sourceCharm = await cc.create(counterProgram, { start: true });

    // Create target counter charm
    targetCharm = await cc.create(counterProgram, { start: true });

    // Create link-tool charm
    const linkToolPath = join(import.meta.dirname!, "..", "link-tool.tsx");
    const linkToolProgram = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(linkToolPath),
    );
    linkTool = await cc.create(linkToolProgram, { start: true });
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should list available charms", async () => {
    const result = await linkTool.run("listCharms", {});
    assert(result, "listCharms should return a result");

    const parsed = JSON.parse(result as string);
    assert(parsed.count >= 0, "Should have a count of charms");
    assert(Array.isArray(parsed.charms), "Should have a charms array");
  });

  it("should create a link between two counter charms", async () => {
    // Set initial value on source charm
    await sourceCharm.result.set(100, ["value"]);
    const sourceValue = await sourceCharm.result.get(["value"]);
    assertEquals(sourceValue, 100, "Source value should be 100");

    // Get charm names for path construction
    const sourceName = await sourceCharm.result.get(["[NAME]"]);
    const targetName = await targetCharm.result.get(["[NAME]"]);

    // Create link: target's value -> source's value
    const linkResult = await linkTool.run("createLink", {
      source: `${sourceName}/result/value`,
      target: `${targetName}/result/value`,
    });

    // Verify link was created (should return success message)
    assert(
      typeof linkResult === "string" && linkResult.includes("Successfully"),
      "Should return success message",
    );

    // Verify that target now shows source's value
    const targetValue = await targetCharm.result.get(["value"]);
    assertEquals(
      targetValue,
      100,
      "Target value should match source value after linking",
    );

    // Update source value
    await sourceCharm.result.set(200, ["value"]);

    // Verify target value updates (because it's linked)
    const updatedTargetValue = await targetCharm.result.get(["value"]);
    assertEquals(
      updatedTargetValue,
      200,
      "Target value should update when source changes",
    );
  });

  it("should handle invalid charm names gracefully", async () => {
    try {
      await linkTool.run("createLink", {
        source: "NonExistentCharm/result/value",
        target: "AnotherNonExistent/input/field",
      });
      assert(false, "Should have thrown an error for invalid charm");
    } catch (error) {
      assert(
        error instanceof Error &&
          error.message.includes("not found"),
        "Should throw error about charm not found",
      );
    }
  });

  it("should support paths without explicit result/input keywords", async () => {
    const sourceName = await sourceCharm.result.get(["[NAME]"]);
    const targetName = await targetCharm.result.get(["[NAME]"]);

    // Set source value
    await sourceCharm.result.set(42, ["value"]);

    // Create link without using "result" keyword
    await linkTool.run("createLink", {
      source: `${sourceName}/value`,
      target: `${targetName}/value`,
    });

    // Verify link works
    const targetValue = await targetCharm.result.get(["value"]);
    assertEquals(
      targetValue,
      42,
      "Should work without explicit result/input keywords",
    );
  });
});
