#!/usr/bin/env -S deno run --allow-read --allow-run --allow-net --allow-env --allow-write
import { Browser } from "./packages/integration/browser.ts";
import { sleep } from "@commontools/utils/sleep";

const CHARM_URL =
  "http://localhost:8000/united-explore-test/baedreihe36ptzsspp6ojlbfgpgbhzx3i7gmkawmnr6yghbphxdrkmhfwla";
const PASSPHRASE_PATH = "../labs/.passphrase";

async function main() {
  console.log("Launching browser...");
  const browser = await Browser.launch({
    headless: false,
    timeout: 120_000,
  });

  try {
    console.log(`Navigating to: ${CHARM_URL}`);
    const page = await browser.newPage(CHARM_URL);

    // Wait for page to load
    await sleep(3000);

    console.log("Taking initial snapshot...");
    await page.screenshot({ path: "/tmp/united-explorer-initial.png" });
    console.log("Screenshot saved to: /tmp/united-explorer-initial.png");

    // Check if login is needed
    try {
      const loginElement = await page.waitForSelector(
        '[test-id="passphrase-input"]',
        { strategy: "pierce", timeout: 2000 },
      );

      if (loginElement) {
        console.log("Login required, reading passphrase...");
        const passphrase = await Deno.readTextFile(PASSPHRASE_PATH);

        // Type passphrase
        await loginElement.type(passphrase.trim());
        await sleep(500);

        // Click login button
        const loginButton = await page.waitForSelector(
          '[test-id="passphrase-login"]',
          { strategy: "pierce" },
        );
        await loginButton.click();
        await sleep(2000);

        console.log("Logged in successfully");
      }
    } catch (e) {
      console.log("No login prompt detected, continuing...");
    }

    // Take snapshot after potential login
    console.log("Taking post-login snapshot...");
    await page.screenshot({ path: "/tmp/united-explorer-after-login.png" });
    console.log("Screenshot saved to: /tmp/united-explorer-after-login.png");

    // Look for Fetch Emails button
    try {
      console.log("Looking for Fetch Emails button...");
      const buttons = await page.evaluate(() => {
        const allButtons = Array.from(document.querySelectorAll("button"));
        return allButtons.map((btn) => btn.textContent?.trim() || "");
      });
      console.log("Found buttons:", buttons);

      const fetchButton = await page.waitForSelector(
        'button:has-text("Fetch Emails")',
        { strategy: "pierce", timeout: 5000 },
      );

      if (fetchButton) {
        console.log("Clicking Fetch Emails button...");
        await fetchButton.click();

        // Wait for emails to load
        await sleep(5000);

        console.log("Taking snapshot after fetching emails...");
        await page.screenshot({ path: "/tmp/united-explorer-emails.png" });
        console.log("Screenshot saved to: /tmp/united-explorer-emails.png");
      }
    } catch (e) {
      console.log("Could not find Fetch Emails button:", e.message);
    }

    // Get page content to analyze
    const content = await page.evaluate(() => {
      return document.body.textContent || "";
    });
    console.log("\n=== Page Content Preview ===");
    console.log(content.slice(0, 1000));

    console.log("\nKeeping browser open for manual inspection...");
    console.log("Press Ctrl+C to close");

    // Keep browser open
    await sleep(300000); // 5 minutes
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await browser.close();
  }
}

main();
