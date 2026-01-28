import { env, Page, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { Identity } from "@commontools/identity";
import { PiecesController } from "@commontools/piece/ops";
import { ANYONE_USER } from "@commontools/memory/acl";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

const testComponents = [
  { name: "ct-checkbox-cell", file: "examples/ct-checkbox-cell.tsx" },
];

testComponents.forEach(({ name, file }) => {
  describe(`${name} integration test`, () => {
    const shell = new ShellIntegration();
    shell.bindLifecycle();

    let pieceId: string;
    let identity: Identity;
    let cc: PiecesController;

    beforeAll(async () => {
      identity = await Identity.generate({ implementation: "noble" });
      cc = await PiecesController.initialize({
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
        { start: false },
      );
      pieceId = charm.id;

      // Add permissions for ANYONE in the first test
      await cc.acl().set(ANYONE_USER, "WRITE");
    });

    afterAll(async () => {
      if (cc) await cc.dispose();
    });

    it(`should load the ${name} charm`, async () => {
      const page = shell.page();
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceName: SPACE_NAME,
          pieceId,
        },
        identity,
      });
      await page.waitForSelector("ct-checkbox", { strategy: "pierce" });
    });

    it("should show disabled content initially", async () => {
      const page = shell.page();
      await waitFor(async () => {
        const statusText = await getFeatureStatus(page);
        return statusText === "⚠ Feature is disabled";
      });
    });

    it("should toggle to enabled content when checkbox is clicked", async () => {
      const page = shell.page();

      await clickCtCheckbox(page);
      await waitFor(async () => {
        const statusText = await getFeatureStatus(page);
        return statusText === "✓ Feature is enabled!";
      });
    });

    it("should toggle back to disabled content when checkbox is clicked again", async () => {
      const page = shell.page();
      await clickCtCheckbox(page);
      await waitFor(async () => {
        const statusText = await getFeatureStatus(page);
        return statusText === "⚠ Feature is disabled";
      });
    });
  });
});

function clickCtCheckbox(page: Page) {
  return waitFor(async () => {
    const checkbox = await page.waitForSelector("ct-checkbox", {
      strategy: "pierce",
    });
    // This could throw due to lacking a box model to click on.
    // Catch in lieu of handling time sensitivity.
    try {
      await checkbox.click();
      return true;
    } catch (_) {
      return false;
    }
  });
}

async function getFeatureStatus(
  page: Page,
): Promise<string | undefined | null> {
  const featureStatus = await page.waitForSelector("#feature-status", {
    strategy: "pierce",
  });
  // This could throw due to lacking a box model to click on.
  // Catch in lieu of handling time sensitivity.
  try {
    const statusText = await featureStatus.evaluate((el: HTMLElement) =>
      el.textContent
    );
    return statusText?.trim();
  } catch (_) {
    return null;
  }
}
