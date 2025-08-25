import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { CharmsController } from "@commontools/charm/ops";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

const testComponents = [
  { name: "ct-checkbox-cell", file: "ct-checkbox-cell.tsx" },
  { name: "ct-checkbox-handler", file: "ct-checkbox-handler.tsx" },
];

testComponents.forEach(({ name, file }) => {
  describe(`${name} integration test`, () => {
    const shell = new ShellIntegration();
    shell.bindLifecycle();

    let charmId: string;
    let identity: Identity;
    let cc: CharmsController;

    beforeAll(async () => {
      identity = await Identity.generate({ implementation: "noble" });
      cc = await CharmsController.initialize({
        spaceName: SPACE_NAME,
        apiUrl: new URL(API_URL),
        identity: identity,
      });
      const charm = await cc.create(
        await Deno.readTextFile(
          join(
            import.meta.dirname!,
            "..",
            file,
          ),
        ),
      );
      charmId = charm.id;
    });

    afterAll(async () => {
      if (cc) await cc.dispose();
    });

    it(`should load the ${name} charm`, async () => {
      const page = shell.page();
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        spaceName: SPACE_NAME,
        charmId,
        identity,
      });
      await page.waitForSelector("ct-checkbox", { strategy: "pierce" });
    });

    it("should show disabled content initially", async () => {
      const page = shell.page();

      const featureStatus = await page.waitForSelector("#feature-status", {
        strategy: "pierce",
      });
      const statusText = await featureStatus.evaluate((el: HTMLElement) =>
        el.textContent
      );
      assertEquals(statusText?.trim(), "⚠ Feature is disabled");
    });

    it("should toggle to enabled content when checkbox is clicked", async () => {
      const page = shell.page();

      const checkbox = await page.waitForSelector("ct-checkbox", {
        strategy: "pierce",
      });
      await checkbox.click();
      await sleep(500);

      const featureStatus = await page.$("#feature-status", {
        strategy: "pierce",
      });
      const statusText = await featureStatus?.evaluate((el: HTMLElement) =>
        el.textContent
      );
      assertEquals(statusText?.trim(), "✓ Feature is enabled!");
    });

    it("should toggle back to disabled content when checkbox is clicked again", async () => {
      const page = shell.page();

      const checkbox = await page.$("ct-checkbox", {
        strategy: "pierce",
      });
      await checkbox?.click();
      await sleep(1000);

      const featureStatus = await page.$("#feature-status", {
        strategy: "pierce",
      });
      const statusText = await featureStatus?.evaluate((el: HTMLElement) =>
        el.textContent
      );
      assertEquals(statusText?.trim(), "⚠ Feature is disabled");
    });
  });
});
