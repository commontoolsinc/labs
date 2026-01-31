import { env, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { Identity } from "@commontools/identity";
import { PiecesController } from "@commontools/piece/ops";
import { FileSystemProgramResolver } from "@commontools/js-compiler";
import { join } from "@std/path";

const { API_URL, FRONTEND_URL } = env;
const SPACE_NAME = `calendar-e2e-${randomUUID().slice(0, 8)}`;

// Extended timeout for manual OAuth completion
const OAUTH_TIMEOUT = 120000; // 2 minutes for user to complete OAuth

describe("google calendar importer e2e", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let googleAuthPieceId: string;
  let calendarImporterPieceId: string;

  beforeAll(async () => {
    // 1. Generate identity
    identity = await Identity.generate({ implementation: "noble" });

    // 2. Initialize PiecesController
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });

    // 3. Deploy google-auth pattern with calendar scope pre-selected
    const googleAuthPath = join(
      import.meta.dirname!,
      "..",
      "google-auth.tsx",
    );
    const googleAuthProgram = await cc.manager().runtime.harness
      .resolve(
        new FileSystemProgramResolver(googleAuthPath),
      );
    const googleAuthPiece = await cc.create(googleAuthProgram, { start: true });
    googleAuthPieceId = googleAuthPiece.id;

    // 4. Deploy google-calendar-importer pattern
    const calendarPath = join(
      import.meta.dirname!,
      "..",
      "google-calendar-importer.tsx",
    );
    const calendarProgram = await cc.manager().runtime.harness
      .resolve(
        new FileSystemProgramResolver(calendarPath),
      );
    const calendarPiece = await cc.create(calendarProgram, { start: true });
    calendarImporterPieceId = calendarPiece.id;

    console.log(`\n=== TEST SETUP ===`);
    console.log(`Space: ${SPACE_NAME}`);
    console.log(`Google Auth Piece: ${googleAuthPieceId}`);
    console.log(`Calendar Importer Piece: ${calendarImporterPieceId}`);
    console.log(`==================\n`);
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should complete Google OAuth flow and import calendar events", async () => {
    const page = shell.page();

    // Step 1: Navigate to Google Auth piece
    console.log("Navigating to Google Auth piece...");
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME, pieceId: googleAuthPieceId },
      identity,
    });

    // Step 2: Wait for the ct-google-oauth element and its button
    // The button text is "Authenticate with Google" inside shadow DOM
    console.log("Waiting for Google OAuth component...");
    await waitFor(async () => {
      try {
        // The button is inside ct-google-oauth shadow DOM
        const buttons = await page.$$("button", { strategy: "pierce" });
        for (const btn of buttons) {
          const text = await btn.innerText();
          if (
            text?.toLowerCase().includes("authenticate") ||
            text?.toLowerCase().includes("google")
          ) {
            return true;
          }
        }
        return false;
      } catch {
        return false;
      }
    }, { timeout: 30000 });

    // Step 3: Click the Authenticate with Google button
    console.log("Clicking Authenticate with Google button...");
    const buttons = await page.$$("button", { strategy: "pierce" });
    for (const btn of buttons) {
      const text = await btn.innerText();
      if (
        text?.toLowerCase().includes("authenticate") ||
        text?.toLowerCase().includes("google")
      ) {
        await btn.click();
        break;
      }
    }

    // Step 4: Wait for OAuth completion (manual step)
    console.log("\n========================================");
    console.log("MANUAL STEP REQUIRED:");
    console.log("Please complete the Google OAuth flow in the popup window.");
    console.log("1. Select your Google account");
    console.log("2. Approve the Calendar read scope");
    console.log(`Waiting up to ${OAUTH_TIMEOUT / 1000} seconds...`);
    console.log("========================================\n");

    // Wait until we see the user's email (indicating successful auth)
    await waitFor(async () => {
      try {
        // Look for signs of successful auth - email displayed
        const content = await page.evaluate(() => document.body.innerText);
        // Check for email pattern or "Connected" status
        return content?.includes("@gmail.com") ||
          content?.includes("@google.com") ||
          content?.includes("Connected");
      } catch {
        return false;
      }
    }, { timeout: OAUTH_TIMEOUT });

    console.log("OAuth completed successfully!");

    // Step 5: Navigate to Calendar Importer
    console.log("Navigating to Calendar Importer...");
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME, pieceId: calendarImporterPieceId },
      identity,
    });

    // Step 6: Wait for auth to be recognized via wish()
    console.log("Waiting for Calendar Importer to recognize auth...");
    await waitFor(async () => {
      try {
        const content = await page.evaluate(() => document.body.innerText);
        // Should show "Connected" or the user's email or the Fetch button
        return content?.includes("Connected") ||
          content?.includes("@gmail.com") ||
          content?.includes("@google.com") ||
          content?.includes("Fetch Calendar Events");
      } catch {
        return false;
      }
    }, { timeout: 30000 });

    // Step 7: Click "Fetch Calendar Events" button
    console.log("Clicking Fetch Calendar Events button...");
    const fetchButton = await page.waitForSelector("ct-button", {
      strategy: "pierce",
      timeout: 10000,
    });
    await fetchButton.click();

    // Step 8: Wait for events to load
    console.log("Waiting for calendar events to load...");
    await waitFor(async () => {
      try {
        const content = await page.evaluate(() => document.body.innerText);
        // Look for "Imported event count: N" where N > 0
        const match = content?.match(/Imported event count:\s*(\d+)/);
        if (match) {
          const count = parseInt(match[1], 10);
          return count > 0;
        }
        // Also check for "N events imported"
        const match2 = content?.match(/(\d+) events imported/);
        if (match2) {
          const count = parseInt(match2[1], 10);
          return count > 0;
        }
        return false;
      } catch {
        return false;
      }
    }, { timeout: 30000 });

    // Step 9: Verify calendars were found
    const finalContent = await page.evaluate(() => document.body.innerText);
    assert(
      finalContent?.includes("Your Calendars") ||
        finalContent?.includes("Calendars found"),
      "Expected to see calendars list",
    );

    console.log("\n========================================");
    console.log("TEST PASSED!");
    console.log("Calendar events were successfully imported.");
    console.log("========================================\n");
  });
});
