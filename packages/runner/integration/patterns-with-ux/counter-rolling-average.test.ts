import { env, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-runtime";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("counter rolling average ux interactions", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let cc: CharmsController;
  let charm: CharmController;
  let identity: Identity;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });

    const sourcePath = join(
      import.meta.dirname!,
      "counter-rolling-average.pattern.tsx",
    );
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath),
    );
    program.mainExport = "counterRollingAverageUx";

    charm = await cc.create(program, { start: true });
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("reflects rolling window changes in the UI and charm state", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId: charm.id,
      identity,
    });

    const readTestId = async (testId: string) => {
      const el = await page.waitForSelector(
        `*[data-testid="${testId}"]`,
        { strategy: "pierce" },
      );
      const text = await el.evaluate((node: HTMLElement) =>
        node.textContent?.trim() ?? ""
      );
      return text;
    };

    const clickTestId = async (testId: string) => {
      const button = await page.waitForSelector(
        `*[data-testid="${testId}"]`,
        { strategy: "pierce" },
      );
      await button.click();
    };

    const fillInput = async (selector: string, value: string) => {
      const input = await page.waitForSelector(selector, {
        strategy: "pierce",
      });
      await input.click();
      await input.evaluate((el: Element) => {
        const target = el as HTMLInputElement;
        target.value = "";
      });
      await input.type(value);
    };

    await waitFor(async () =>
      readTestId("current-value").then((text) => text === "0")
    );
    await waitFor(async () =>
      readTestId("average-value").then((text) => text === "0")
    );

    await clickTestId("add-five");
    await waitFor(async () =>
      readTestId("current-value").then((text) => text === "5")
    );
    await waitFor(async () =>
      readTestId("average-value").then((text) => text === "5")
    );

    await fillInput("#custom-amount input", "2.5");
    await clickTestId("apply-custom");
    await waitFor(async () =>
      readTestId("current-value").then((text) => text === "7.50")
    );
    await waitFor(async () =>
      readTestId("average-value").then((text) => text === "6.25")
    );

    await fillInput("#window-size input", "3");
    await clickTestId("update-window");
    await waitFor(async () =>
      readTestId("status").then((text) => text.includes("over 3 entries"))
    );

    await clickTestId("subtract-one");
    await waitFor(async () =>
      readTestId("current-value").then((text) => text === "6.50")
    );
    await waitFor(async () =>
      readTestId("average-value").then((text) => text === "6.33")
    );

    await waitFor(async () => {
      const entries = await page.evaluate(() => {
        return Array.from(
          document.querySelectorAll('[data-testid="history-list"] span'),
        ).map((node) => node.textContent?.trim() ?? "");
      });
      return entries.length === 3;
    });

    const historyValues = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll('[data-testid="history-list"] span'),
      ).map((node) => node.textContent?.trim() ?? "");
    });
    assertEquals(historyValues, ["5", "7.50", "6.50"]);

    await waitFor(async () =>
      (await charm.result.get(["currentValue"])) === 6.5
    );
    await waitFor(async () => {
      const history = await charm.result.get(["historyView"]);
      return Array.isArray(history) &&
        history.length === 3 &&
        history[0] === 5 &&
        history[1] === 7.5 &&
        history[2] === 6.5;
    });

    const statusText = await readTestId("status");
    assert(statusText.includes("Total 6.50"));
    assert(statusText.includes("Average 6.33"));
    assert(statusText.includes("over 3 entries"));
  });
});
