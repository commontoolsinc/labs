import { env } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-runtime";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

interface MilestoneInput {
  label?: string;
  weight?: number;
  completed?: boolean;
}

type MilestoneInputRecord = Record<string, MilestoneInput>;

describe("goal progress tracker pattern test", () => {
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
      "goal-progress-tracker.pattern.tsx",
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

  it("should load the goal progress tracker and verify initial state", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId: charm.id,
      identity,
    });

    // Wait for UI to render
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Find heading
    const headings = await page.$$("h2", { strategy: "pierce" });
    let found = false;
    for (const heading of headings) {
      const text = await heading.evaluate((el: HTMLElement) => el.textContent);
      if (text?.includes("Track progress toward goal completion")) {
        found = true;
        break;
      }
    }
    assert(found, "Should find goal tracker heading");

    // Verify initial state has default milestones
    const milestones = charm.result.get(["milestones"]) as Record<string, MilestoneInput>;
    assert(milestones !== null && typeof milestones === "object", "Should have milestones");
    const keys = Object.keys(milestones);
    assert(keys.length >= 3, `Should have at least 3 default milestones, got ${keys.length}`);

    // Verify completion percent
    const completionPercent = charm.result.get(["completionPercent"]) as number;
    assert(typeof completionPercent === "number", "Should have completion percentage");
  });

  it("should display milestone list with completion status", async () => {
    const milestoneList = charm.result.get(["milestoneList"]) as Array<{
      id: string;
      label: string;
      weight: number;
      completed: boolean;
    }>;

    assert(Array.isArray(milestoneList), "Milestone list should be an array");
    assert(milestoneList.length >= 3, "Should have default milestones");

    // Verify each milestone has required fields
    for (const milestone of milestoneList) {
      assert(typeof milestone.id === "string", "Milestone should have id");
      assert(typeof milestone.label === "string", "Milestone should have label");
      assert(typeof milestone.weight === "number", "Milestone should have weight");
      assert(typeof milestone.completed === "boolean", "Milestone should have completed status");
    }
  });

  it("should add a new milestone via UI form", async () => {
    const page = shell.page();

    // Fill in milestone ID
    const idInput = await page.waitForSelector(
      'input[placeholder="e.g., kickoff"]',
      { strategy: "pierce" }
    );
    assert(idInput, "Should find ID input");
    await idInput.click();
    await idInput.type("testing");
    await new Promise(resolve => setTimeout(resolve, 300));

    // Fill in milestone label
    const labelInput = await page.waitForSelector(
      'input[placeholder="e.g., Kickoff review"]',
      { strategy: "pierce" }
    );
    assert(labelInput, "Should find label input");
    await labelInput.click();
    await labelInput.type("Testing milestone");
    await new Promise(resolve => setTimeout(resolve, 300));

    // Fill in weight
    const weightInput = await page.waitForSelector(
      'input[placeholder="e.g., 30"]',
      { strategy: "pierce" }
    );
    assert(weightInput, "Should find weight input");
    await weightInput.click();
    await weightInput.type("25");
    await new Promise(resolve => setTimeout(resolve, 300));

    // Click add milestone button
    const addButton = await page.waitForSelector("#add-milestone-button", {
      strategy: "pierce",
    });
    assert(addButton, "Should find add milestone button");
    await addButton.click();

    // Wait for state to settle
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Verify new milestone was added
    const milestones = charm.result.get(["milestones"]) as Record<string, MilestoneInput>;
    assert(milestones.testing, "Should have new 'testing' milestone");
    assertEquals(milestones.testing.label, "Testing milestone");
    assertEquals(milestones.testing.weight, 25);
    assertEquals(milestones.testing.completed, false);
  });

  it("should calculate totals correctly", async () => {
    const totalWeight = charm.result.get(["totalWeight"]) as number;
    const completedWeight = charm.result.get(["completedWeight"]) as number;
    const remainingWeight = charm.result.get(["remainingWeight"]) as number;
    const completionPercent = charm.result.get(["completionPercent"]) as number;

    assert(typeof totalWeight === "number", "Should have total weight");
    assert(typeof completedWeight === "number", "Should have completed weight");
    assert(typeof remainingWeight === "number", "Should have remaining weight");
    assert(typeof completionPercent === "number", "Should have completion percent");

    // Verify totals add up
    const expectedRemaining = totalWeight - completedWeight;
    assert(
      Math.abs(remainingWeight - expectedRemaining) < 0.01,
      `Remaining should equal total - completed, got ${remainingWeight} vs ${expectedRemaining}`,
    );

    // Verify percentage calculation
    const expectedPercent = totalWeight === 0 ? 0 : (completedWeight / totalWeight) * 100;
    assert(
      Math.abs(completionPercent - expectedPercent) < 0.1,
      `Percent should be calculated correctly, got ${completionPercent} vs ${expectedPercent}`,
    );
  });

  it("should update milestone via direct operation", async () => {
    // Get current milestones
    const current = charm.result.get(["milestones"]) as Record<string, MilestoneInput>;

    // Add a new milestone directly
    const updated: MilestoneInputRecord = {
      ...current,
      direct: {
        label: "Direct test",
        weight: 15,
        completed: false,
      },
    };

    await charm.result.set(updated, ["milestonesInput"]);

    // Wait for reactive updates
    await new Promise(resolve => setTimeout(resolve, 5000));

    const milestones = charm.result.get(["milestones"]) as Record<string, MilestoneInput>;
    assert(milestones.direct, "Should have directly added milestone");
    assertEquals(milestones.direct.label, "Direct test");
    assertEquals(milestones.direct.weight, 15);
  });

  it("should update completion status via direct operation", async () => {
    // Mark the 'direct' milestone as completed
    const current = charm.result.get(["milestones"]) as Record<string, MilestoneInput>;
    const updated: MilestoneInputRecord = {
      ...current,
      direct: {
        ...current.direct,
        completed: true,
      },
    };

    await charm.result.set(updated, ["milestonesInput"]);

    // Wait for reactive updates
    await new Promise(resolve => setTimeout(resolve, 5000));

    const milestones = charm.result.get(["milestones"]) as Record<string, MilestoneInput>;
    assertEquals(milestones.direct.completed, true, "Milestone should be marked complete");

    // Verify completed weight increased
    const completedWeight = charm.result.get(["completedWeight"]) as number;
    assert(completedWeight >= 15, `Completed weight should include the 15 from 'direct' milestone, got ${completedWeight}`);
  });

  it("should update totals when milestones change", async () => {
    const initialTotal = charm.result.get(["totalWeight"]) as number;

    // Add another milestone
    const current = charm.result.get(["milestones"]) as Record<string, MilestoneInput>;
    const updated: MilestoneInputRecord = {
      ...current,
      additional: {
        label: "Additional test",
        weight: 20,
        completed: false,
      },
    };

    await charm.result.set(updated, ["milestonesInput"]);
    await new Promise(resolve => setTimeout(resolve, 5000));

    const newTotal = charm.result.get(["totalWeight"]) as number;
    assertEquals(
      newTotal,
      initialTotal + 20,
      `Total weight should increase by 20, was ${initialTotal}, now ${newTotal}`,
    );
  });
});
