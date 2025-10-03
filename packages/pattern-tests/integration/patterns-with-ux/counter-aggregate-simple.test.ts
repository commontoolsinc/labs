import { env, waitFor } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-runtime";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("counter aggregate simple test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: CharmsController;
  let charm: CharmController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const sourcePath = join(
      import.meta.dirname!,
      "counter-aggregate.pattern.tsx",
    );
    const program = await cc.manager().runtime.harness
      .resolve(
        new FileSystemProgramResolver(sourcePath),
      );
    charm = await cc.create(
      program,
      { start: true },
    );
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load and verify initial state", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId: charm.id,
      identity,
    });

    // Wait for the Counter Aggregator heading to appear
    await waitFor(async () => {
      const headings = await page.$$("h1", {
        strategy: "pierce",
      });
      for (const heading of headings) {
        const text = await heading.evaluate((el: HTMLElement) =>
          el.textContent
        );
        if (text?.includes("Counter Aggregator")) {
          return true;
        }
      }
      return false;
    });

    // Verify initial state - don't await, just get directly
    const counters = charm.result.get(["counters"]);
    assert(Array.isArray(counters), "Counters should be an array");
    assertEquals(counters.length, 0, "Should start with no counters");

    const total = charm.result.get(["total"]);
    assertEquals(total, 0, "Total should be 0");
  });

  it("should add counter via button click", async () => {
    const page = shell.page();

    // Find and click the add button
    const addButton = await page.waitForSelector("#add-counter-button", {
      strategy: "pierce",
    });
    assert(addButton, "Should find add button");

    console.log("Clicking add counter button...");
    await addButton.click();

    // Wait for state to update with logging
    console.log("Waiting for counter to be added...");
    await waitFor(async () => {
      const counters = charm.result.get(["counters"]);
      console.log("Current counters:", counters);
      return Array.isArray(counters) && counters.length === 1;
    }, { timeout: 10000 });

    const counters = charm.result.get(["counters"]) as number[];
    assertEquals(counters[0], 0, "New counter should start at 0");
  });
});
