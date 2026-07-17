import { env } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { ANYONE_USER } from "@commonfabric/memory/acl";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickCfButtonAndWaitForText,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

const testComponents = [
  { name: "cf-checkbox-cell", file: "examples/cf-checkbox-cell.tsx" },
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
      cc = await initializePiecesController({
        spaceName: SPACE_NAME,
        apiUrl: new URL(API_URL),
        identity: identity,
      });
      const piece = await cc.create(
        await Deno.readTextFile(
          join(
            import.meta.dirname!,
            "..",
            file,
          ),
        ),
        { start: false },
      );
      pieceId = piece.id;

      // Add permissions for ANYONE in the first test
      await cc.acl().set(ANYONE_USER, "WRITE");
    });

    afterAll(async () => {
      if (cc) await cc.dispose();
    });

    it(`should load the ${name} piece`, async () => {
      const page = shell.page();
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceName: SPACE_NAME,
          pieceId,
        },
        identity,
      });
      await page.waitForSelector("cf-checkbox", { strategy: "pierce" });
    });

    it("should show disabled content initially", async () => {
      await waitForText(
        shell.page(),
        "#feature-status",
        "⚠ Feature is disabled",
      );
    });

    it("should toggle to enabled content when checkbox is clicked", async () => {
      // The first cf-checkbox in the piece is bound to the cell that
      // #feature-status reflects; the click helper settles the view, clicks
      // the host element once, and waits for the bound text to update.
      await clickCfButtonAndWaitForText(
        shell.page(),
        "cf-checkbox",
        "#feature-status",
        "✓ Feature is enabled!",
      );
    });

    it("should toggle back to disabled content when checkbox is clicked again", async () => {
      await clickCfButtonAndWaitForText(
        shell.page(),
        "cf-checkbox",
        "#feature-status",
        "⚠ Feature is disabled",
      );
    });
  });
});
