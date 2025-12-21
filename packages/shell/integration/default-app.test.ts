import { env } from "@commontools/integration";
import { describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { Identity } from "@commontools/identity";
import { sleep } from "@commontools/utils/sleep";
import { waitFor } from "@commontools/integration";

const { FRONTEND_URL, SPACE_NAME } = env;

/**
 * Tests that default-app.tsx loads correctly for spaces.
 *
 * This is a critical test that validates:
 * 1. The patterns API can serve default-app.tsx
 * 2. All of default-app's dependencies (including subdirectory imports) resolve
 * 3. The UI renders with expected buttons
 *
 * Background: PR #2314 added a Record button that imports record.tsx, which has
 * subdirectory imports (e.g., ./record/registry.ts). This broke new space creation
 * because the patterns API was blocking paths with `/`. See PRs #2318, #2319.
 */
describe("default-app loading tests", () => {
  // Enable console piping to see any errors during pattern loading
  const shell = new ShellIntegration({ pipeConsole: true });
  shell.bindLifecycle();

  it("should load default-app with New Note and New Record buttons", async () => {
    const page = shell.page();
    const identity = await Identity.generate({ implementation: "noble" });

    // Navigate to space without charmId - this triggers default-app loading
    // shell.goto with identity handles login automatically
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME },
      identity,
    });

    // Wait for the body view to render (indicates shell loaded)
    await page.waitForSelector("x-body-view", {
      strategy: "pierce",
      timeout: 10000,
    });

    // Give time for pattern to fetch, compile, and render
    // This is the critical path: fetch default-app.tsx -> compile -> execute -> render
    await sleep(2000);

    // Wait for default-app to load - look for the New Note button
    // This validates that default-app.tsx was fetched and compiled successfully
    // Use waitFor with custom logic for better error reporting
    await waitFor(
      async () => {
        const button = await page
          .waitForSelector('ct-button:has-text("New Note")', {
            strategy: "pierce",
            timeout: 1000,
          })
          .catch(() => null);
        return button !== null;
      },
      { timeout: 60000, delay: 1000 },
    );

    const noteButton = await page.waitForSelector(
      'ct-button:has-text("New Note")',
      { strategy: "pierce", timeout: 5000 },
    );
    assert(noteButton, "New Note button should be present in default-app");

    // Verify New Record button is present
    // This is the critical check - it validates that record.tsx and all its
    // subdirectory imports (./record/registry.ts, etc.) were resolved correctly
    const recordButton = await page.waitForSelector(
      'ct-button:has-text("New Record")',
      { strategy: "pierce", timeout: 5000 },
    );
    assert(
      recordButton,
      "New Record button should be present - this validates subdirectory imports work",
    );
  });

  it("should be able to create a new record from default-app", async () => {
    const page = shell.page();
    const identity = await Identity.generate({ implementation: "noble" });

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME },
      identity,
    });

    // Wait for shell to render
    await page.waitForSelector("x-body-view", {
      strategy: "pierce",
      timeout: 10000,
    });
    await sleep(2000);

    // Wait for default-app to load
    await waitFor(
      async () => {
        const button = await page
          .waitForSelector('ct-button:has-text("New Record")', {
            strategy: "pierce",
            timeout: 1000,
          })
          .catch(() => null);
        return button !== null;
      },
      { timeout: 60000, delay: 1000 },
    );

    const recordButton = await page.waitForSelector(
      'ct-button:has-text("New Record")',
      { strategy: "pierce", timeout: 5000 },
    );
    assert(recordButton, "New Record button should be present");

    // Get the inner text to ensure it's ready
    await recordButton.innerText();

    // Click the New Record button
    await recordButton.click();
    await sleep(3000);

    // Verify we navigated to a record - look for record-specific UI elements
    // The record pattern has a title input and module picker
    const titleInput = await page
      .waitForSelector('input[placeholder*="Record title"]', {
        strategy: "pierce",
        timeout: 10000,
      })
      .catch(() => null);

    // Alternative: check for the type picker which is unique to Record
    const typePicker = await page
      .waitForSelector('button:has-text("Person")', {
        strategy: "pierce",
        timeout: 5000,
      })
      .catch(() => null);

    assert(
      titleInput || typePicker,
      "Should navigate to Record pattern after clicking New Record button",
    );
  });
});
