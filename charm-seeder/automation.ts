import { parseArgs } from "@std/cli/parse-args";
import {
  Browser,
  ConsoleEvent,
  DialogEvent,
  launch,
  Page,
  PageErrorEvent,
} from "@astral/astral";
import { join } from "@std/path";
import { ensureDirSync } from "@std/fs";
import { sleep } from "@commontools/utils/sleep";
import { castNewRecipe, CharmManager } from "@commontools/charm";
import { getEntityId, setBobbyServerUrl, storage } from "@commontools/runner";
import { createSession, Identity } from "@commontools/identity";
import { client as llm } from "@commontools/llm";
import { prompts } from "./prompts.ts";

const PASSPHRASE =
  `frequent analyst armor dinner moon sustain web dawn marine chat speed emotion remember grid aisle stadium true flash sheriff exact exclude slice fault excuse`;

// Configuration
const TOOLSHED_API_URL = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";
const HEADLESS = Deno.env.get("HEADLESS") !== "false";
const ASTRAL_TIMEOUT = 60_000;
const SNAPSHOTS_DIR = join(Deno.cwd(), "snapshots");

// Helper for snapshot taking
async function takeSnapshot(page: Page, name: string) {
  ensureDirSync(SNAPSHOTS_DIR);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePrefix = `${name}_${timestamp}`;

  const screenshot = await page.screenshot();
  Deno.writeFileSync(`${SNAPSHOTS_DIR}/${filePrefix}.png`, screenshot);

  const html = await page.content();
  Deno.writeTextFileSync(`${SNAPSHOTS_DIR}/${filePrefix}.html`, html);

  console.log(`→ Snapshot saved: ${filePrefix}`);
}

// Helper function for waiting for an element with specific text
async function waitForSelectorWithText(
  page: Page,
  selector: string,
  text: string,
  maxRetries = 30,
  retryDelay = 1000,
): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const el = await page.waitForSelector(selector);
      const content = await el.innerText();
      if (content.includes(text)) {
        return true;
      }
    } catch (error) {
      console.error(`Error finding selector: ${selector}`, error);
    }
    await sleep(retryDelay);
  }
  return false;
}

// Wait for selector and click
async function waitForSelectorClick(
  page: Page,
  selector: string,
): Promise<void> {
  console.log(`Waiting for "${selector}"...`);
  const el = await page.waitForSelector(selector);
  console.log(`Found "${selector}"! Clicking...`);
  await el.click();
}

// Handle login flow
async function login(page: Page) {
  console.log("Running login sequence...");

  // Check if we're already logged in
  await sleep(1000);
  try {
    const avatar = await page.$("#user-avatar");
    if (avatar) {
      console.log("Already logged in");
      return;
    }
  } catch (e) {
    console.log("Not logged in, starting login process");
  }

  // If not logged in, see if any credential data is
  // persisting. If so, destroy local data.
  await sleep(500);
  try {
    const clearCredsButton = await page.$(
      "button[aria-label='clear-credentials']",
    );
    if (clearCredsButton) {
      console.log("Clearing existing credentials");
      await clearCredsButton.click();
      await sleep(500);
    }
  } catch (e) {
    console.log("No credential clear button found");
  }

  // Try to login with "common user" passphrase
  console.log("Starting login flow...");

  // First check if we can just enter the passphrase directly
  try {
    console.log("Checking for direct passphrase entry");
    const passphraseInput = await page.$(
      "input[aria-label='enter-passphrase']",
    );
    if (passphraseInput) {
      console.log("Found direct passphrase input");
      await passphraseInput.type("common user");
      await sleep(500);
      await waitForSelectorClick(page, "button[aria-label='login']");
      await page.waitForSelector("#user-avatar");
      console.log("Direct login successful");
      return;
    }
  } catch (e) {
    console.log("No direct passphrase entry found, continuing with full flow");
  }

  // Full login flow
  console.log("Using full registration flow");

  try {
    // Click register button
    await waitForSelectorClick(page, "button[aria-label='login']");
    await sleep(1000);

    // await waitForSelectorClick(page, "button[aria-label='method-passphrase']");

    // Enter the mnemonic in the passphrase input
    console.log("Entering mnemonic in passphrase field");
    const input = await page.waitForSelector(
      "input[aria-label='enter-passphrase']",
    );
    await input!.evaluate(
      (input: HTMLInputElement, mnemonic: string) => input.value = mnemonic,
      { args: [PASSPHRASE] },
    );

    // Click login button
    await waitForSelectorClick(page, "button[aria-label='login']");

    // Wait for user avatar to appear (login successful)
    console.log("Waiting for user avatar (login confirmation)");
    await page.waitForSelector("#user-avatar");
    console.log("Login successful!");
  } catch (e) {
    console.error("Error during login:", e);
    throw new Error("Login failed: " + e.message);
  }
}

// Main function to create charms and screenshot them
async function createAndScreenshotCharms(
  spaceName: string,
) {
  console.log(`Setting up browser to visit charms in ${spaceName} space...`);

  // Setup LLM and storage
  llm.setServerUrl(TOOLSHED_API_URL);
  storage.setRemoteStorage(new URL(TOOLSHED_API_URL));
  setBobbyServerUrl(TOOLSHED_API_URL);

  // Create session for charm manager
  const charmManager = new CharmManager(
    await createSession({
      identity: await Identity.fromPassphrase("common user"),
      name: spaceName,
    }),
  );

  // Launch browser
  const browser = await launch({ headless: HEADLESS });
  const page = await browser.newPage();

  // Set timeout
  const mutPage: any = page;
  mutPage.timeout = ASTRAL_TIMEOUT;

  // Move exceptions array inside function scope
  const exceptions: string[] = [];

  // Update event listeners to match basic-flow.test.ts
  page.addEventListener("console", (e: ConsoleEvent) => {
    console.log(`Browser Console [${e.detail.type}]: ${e.detail.text}`);
  });

  page.addEventListener("pageerror", (e: PageErrorEvent) => {
    console.error("Browser Page Error:", e.detail.message);
    exceptions.push(e.detail.message);
  });

  page.addEventListener("dialog", async (e: DialogEvent) => {
    const dialog = e.detail;
    console.log(`Browser Dialog: ${dialog.type} - ${dialog.message}`);
    await dialog.dismiss();
  });

  // Listen directly for our custom charm error event
  page.addEventListener(
    "custom-event:charm-runtime-error" as keyof PageEventMap,
    (e: CustomEvent) => {
      console.error("listener Charm Runtime Error:", e.detail);
      exceptions.push(e.detail);
    },
  );

  try {
    // Login to Jumble
    await page.goto(TOOLSHED_API_URL);
    await login(page);
    console.log("Login successful!");

    // Process each prompt
    for (const command of prompts) {
      try {
        console.log(`Creating charm: "${command.prompt}"`);
        const charm = await castNewRecipe(charmManager, command.prompt, {});
        await charmManager.synced();

        // Extract the ID from the charm (using the entity ID)
        const entityId = getEntityId(charm);
        const charmId = entityId?.["/"];
        if (!charmId) {
          throw new Error("Failed to get charm ID");
        }
        const charmUrl = new URL(`/${spaceName}/${charmId}`, TOOLSHED_API_URL)
          .toString();
        console.log(`Charm created: ${charmUrl}`);

        // Visit the charm
        console.log(`Visiting charm...`);
        await page.goto(charmUrl);

        // Wait for page to load
        await sleep(3000);

        // Wait for any potential error messages to appear
        await sleep(1000);

        // Check if there are any exceptions before continuing
        if (exceptions.length > 0) {
          console.warn(
            "Console errors detected, attempting to resolve before continuing:",
          );
          exceptions.forEach((exception) => console.warn(exception));
          // Clear exceptions after logging them
          exceptions.length = 0;
          // Give the page a moment to stabilize
          await sleep(2000);
        } else {
          console.log("No console errors detected, proceeding with testing");
        }

        // Take initial screenshot
        await takeSnapshot(
          page,
          `${command.prompt.replace(/\s+/g, "_")}_initial`,
        );

        // Try to interact with the charm
        console.log("Attempting to interact with charm...");

        // Try to find buttons and click them
        const buttons = await page.$$("div[aria-label='charm-content'] button");
        if (buttons.length > 0) {
          console.log(`Found ${buttons.length} buttons, clicking first one`);
          await buttons[0].click();
          await sleep(2000);
          await takeSnapshot(
            page,
            `${command.prompt.replace(/\s+/g, "_")}_after_click`,
          );
        }

        // Try to find input fields and interact
        const inputs = await page.$$("div[aria-label='charm-content'] input");
        if (inputs.length > 0) {
          console.log(
            `Found ${inputs.length} input fields, typing in first one`,
          );
          await inputs[0].type("Test input from automation");
          await sleep(2000);
          await takeSnapshot(
            page,
            `${command.prompt.replace(/\s+/g, "_")}_after_type`,
          );
        }

        console.log(`Charm "${command.prompt}" tested successfully`);
      } catch (error) {
        console.error(`Error processing charm "${command.prompt}":`, error);
      }
    }

    if (exceptions.length > 0) {
      console.error("Errors occurred during testing:");
      exceptions.forEach((exception) => {
        console.error(exception);
      });
    } else {
      console.log("All charms created and tested successfully!");
    }
  } finally {
    await browser.close();
  }
}

// Parse command line arguments
const { space } = parseArgs(Deno.args, {
  string: ["space"],
});

if (!space) {
  console.error(
    "Error: Missing `--space` argument. Example: deno run -A automation.ts --space=my-space",
  );
  Deno.exit(1);
}

// Run the main function
createAndScreenshotCharms(space)
  .catch((error) => {
    console.error("Fatal error:", error);
    Deno.exit(1);
  });
