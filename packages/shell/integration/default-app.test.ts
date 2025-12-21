import { env } from "@commontools/integration";
import { describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { ShellIntegration } from "../../integration/shell-utils.ts";
import { Identity } from "@commontools/identity";
import { sleep } from "@commontools/utils/sleep";

const { FRONTEND_URL } = env;

/**
 * Tests that default-app.tsx loads correctly for new spaces.
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
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("should load default-app with New Note and New Record buttons", async () => {
    const page = shell.page();
    // Use a unique space name to ensure we're testing fresh space creation
    const spaceName = `test-default-app-${Date.now()}`;
    const identity = await Identity.generate({ implementation: "noble" });

    // Navigate to space without charmId - this triggers default-app loading
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName },
      identity,
    });

    // Wait for login flow if needed
    await sleep(1);
    const registerHandle = await page.waitForSelector(
      '[test-id="register-new-key"]',
      { strategy: "pierce", timeout: 5000 },
    ).catch(() => null);

    if (registerHandle) {
      // Complete registration flow
      registerHandle.click();
      await sleep(1);
      const generateHandle = await page.waitForSelector(
        '[test-id="generate-passphrase"]',
        { strategy: "pierce" },
      );
      generateHandle.click();
      await sleep(1);
      const continueHandle = await page.waitForSelector(
        '[test-id="passphrase-continue"]',
        { strategy: "pierce" },
      );
      continueHandle.click();
      await sleep(1);
    }

    // Wait for default-app to load - look for the New Note button
    // This validates that default-app.tsx was fetched and compiled successfully
    const noteButton = await page.waitForSelector(
      'ct-button:has-text("New Note")',
      { strategy: "pierce", timeout: 30000 },
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
    const spaceName = `test-record-creation-${Date.now()}`;
    const identity = await Identity.generate({ implementation: "noble" });

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName },
      identity,
    });

    // Complete registration if needed
    await sleep(1);
    const registerHandle = await page.waitForSelector(
      '[test-id="register-new-key"]',
      { strategy: "pierce", timeout: 5000 },
    ).catch(() => null);

    if (registerHandle) {
      registerHandle.click();
      await sleep(1);
      const generateHandle = await page.waitForSelector(
        '[test-id="generate-passphrase"]',
        { strategy: "pierce" },
      );
      generateHandle.click();
      await sleep(1);
      const continueHandle = await page.waitForSelector(
        '[test-id="passphrase-continue"]',
        { strategy: "pierce" },
      );
      continueHandle.click();
      await sleep(2);
    }

    // Wait for default-app to load
    const recordButton = await page.waitForSelector(
      'ct-button:has-text("New Record")',
      { strategy: "pierce", timeout: 30000 },
    );
    assert(recordButton, "New Record button should be present");

    // Click the New Record button
    await recordButton.click();
    await sleep(2);

    // Verify we navigated to a record - look for record-specific UI elements
    // The record pattern has a title input and module picker
    const titleInput = await page.waitForSelector(
      'input[placeholder*="Record title"]',
      { strategy: "pierce", timeout: 10000 },
    ).catch(() => null);

    // Alternative: check for the type picker which is unique to Record
    const typePicker = await page.waitForSelector(
      'button:has-text("Person")',
      { strategy: "pierce", timeout: 5000 },
    ).catch(() => null);

    assert(
      titleInput || typePicker,
      "Should navigate to Record pattern after clicking New Record button",
    );
  });
});
