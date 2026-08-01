import { env, waitForCondition } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { writeTempIdentity } from "@commonfabric/integration/temp-identity";
import { describe, it } from "@std/testing/bdd";
import "../src/globals.ts";
import { clickPierce } from "./shadow-dom.ts";

const { FRONTEND_URL, SPACE_NAME } = env;

/** Wait until the space root piece has rendered into the body view. */
async function waitForRenderedPiece(
  page: ReturnType<ShellIntegration["page"]>,
): Promise<void> {
  await waitForCondition(page, () => {
    const rootView = document.querySelector("x-root-view");
    const appView = rootView?.shadowRoot?.querySelector("x-app-view");
    const bodyView = appView?.shadowRoot?.querySelector("x-body-view");
    return !!bodyView?.shadowRoot?.querySelector("cf-render");
  });
}

/**
 * Right-click the rendered piece. The click is dispatched on the `cf-render`
 * element itself, which is what a real right-click on the piece reaches.
 */
async function rightClickRenderedPiece(
  page: ReturnType<ShellIntegration["page"]>,
): Promise<void> {
  await page.evaluate(() => {
    const rootView = document.querySelector("x-root-view");
    const appView = rootView?.shadowRoot?.querySelector("x-app-view");
    const bodyView = appView?.shadowRoot?.querySelector("x-body-view");
    const render = bodyView?.shadowRoot?.querySelector("cf-render");
    if (!render) throw new Error("no rendered piece to right-click");
    render.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        composed: true,
        cancelable: true,
        clientX: 80,
        clientY: 80,
      }),
    );
  });
}

/** The text of the piece menu's panel, once a panel with `testId` is open. */
async function waitForPanelText(
  page: ReturnType<ShellIntegration["page"]>,
  testId: string,
  expected: string,
): Promise<void> {
  await waitForCondition(
    page,
    (probe, id: string, text: string) =>
      probe.collect(`[test-id="${id}"]`).some((el) =>
        probe.deepText(el).includes(text)
      ),
    { args: [testId, expected] },
  );
}

describe("piece context menu", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  // The menu and its panels are cf-piece-menu's, mounted on document.body by
  // cf-render. Driving them through a real right-click is what proves the
  // announcement, the portalled overlay, and the worker read all line up.
  it("shows a piece's source and the origin it records", async () => {
    const page = shell.page();
    const { identity } = await writeTempIdentity({ implementation: "noble" });

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME },
      identity,
    });
    await waitForRenderedPiece(page);

    await rightClickRenderedPiece(page);
    await clickPierce(page, '[test-id="piece-menu-source"]');
    // The space root runs the default app, so its entry file is that pattern.
    await waitForPanelText(
      page,
      "piece-panel-source",
      "/api/patterns/system/default-app.tsx",
    );

    await rightClickRenderedPiece(page);
    await clickPierce(page, '[test-id="piece-menu-origin"]');
    // A root created from the default-app URL records it as a web origin.
    await waitForPanelText(page, "piece-panel-origin", "External web URL");
    await waitForPanelText(
      page,
      "piece-panel-origin",
      "/api/patterns/system/default-app.tsx",
    );
  });
});
