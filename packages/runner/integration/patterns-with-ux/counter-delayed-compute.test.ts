import { env, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-runtime";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("counter delayed compute ux interactions", () => {
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
      "counter-delayed-compute.pattern.tsx",
    );
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath),
    );
    program.mainExport = "counterDelayedComputeUx";

    charm = await cc.create(program, { start: true });
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("queues increments and applies them during a compute cycle", async () => {
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
      readTestId("computed-value").then((text) => text === "0")
    );
    await waitFor(async () =>
      readTestId("preview-value").then((text) => text === "0")
    );
    await waitFor(async () =>
      readTestId("queued-count").then((text) => text === "0")
    );

    await clickTestId("schedule-one");
    await waitFor(async () =>
      readTestId("queued-count").then((text) => text === "1")
    );
    await waitFor(async () =>
      readTestId("queued-total").then((text) => text === "1")
    );
    await waitFor(async () =>
      readTestId("preview-value").then((text) => text === "1")
    );

    await clickTestId("schedule-minus-two");
    await waitFor(async () =>
      readTestId("queued-count").then((text) => text === "2")
    );
    await waitFor(async () =>
      readTestId("queued-total").then((text) => text === "-1")
    );
    await waitFor(async () =>
      readTestId("preview-value").then((text) => text === "-1")
    );

    await fillInput("#custom-amount input", "3");
    await clickTestId("schedule-custom");

    await waitFor(async () =>
      readTestId("queued-count").then((text) => text === "3")
    );
    await waitFor(async () =>
      readTestId("queued-total").then((text) => text === "2")
    );
    await waitFor(async () =>
      readTestId("preview-value").then((text) => text === "2")
    );

    await waitFor(async () => {
      const badges = await page.evaluate(() => {
        return Array.from(
          document.querySelectorAll('[data-testid^="pending-entry-"]'),
        ).map((node) => node.textContent?.trim() ?? "");
      });
      return badges.length === 3;
    });

    const badgeValues = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll('[data-testid^="pending-entry-"]'),
      ).map((node) => node.textContent?.trim() ?? "");
    });
    assertEquals(badgeValues, ["1", "-2", "3"]);

    await clickTestId("process-queue");

    await waitFor(async () =>
      readTestId("computed-value").then((text) => text === "2")
    );
    await waitFor(async () =>
      readTestId("queued-count").then((text) => text === "0")
    );
    await waitFor(async () =>
      readTestId("queued-total").then((text) => text === "0")
    );
    await waitFor(async () =>
      readTestId("preview-value").then((text) => text === "2")
    );

    const statusText = await readTestId("status");
    assert(statusText.includes("Stored 2"));
    assert(statusText.includes("0 queued"));

    await waitFor(async () => (await charm.result.get(["rawValue"])) === 2);
    await waitFor(async () => {
      const queue = await charm.result.get(["pending"]);
      return Array.isArray(queue) && queue.length === 0;
    });
  });
});
