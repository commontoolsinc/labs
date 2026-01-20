#!/usr/bin/env -S deno run --allow-read --allow-run --allow-net --allow-env --allow-write
import { Browser } from "./packages/integration/browser.ts";
import { sleep } from "@commontools/utils/sleep";

const CHARM_URL =
  "http://localhost:8000/united-explore-test/baedreihe36ptzsspp6ojlbfgpgbhzx3i7gmkawmnr6yghbphxdrkmhfwla";

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
    console.log("Waiting for page to load...");
    await sleep(5000);

    // Get the full page HTML
    console.log("Capturing page HTML...");
    const html = await page.evaluate(() => {
      return document.documentElement.outerHTML;
    });

    await Deno.writeTextFile("/tmp/united-explorer-page.html", html);
    console.log("Page HTML saved to: /tmp/united-explorer-page.html");

    // Get text content
    const textContent = await page.evaluate(() => {
      // Try to get shadow DOM content
      const app = document.querySelector("ct-app-view");
      if (app && app.shadowRoot) {
        return app.shadowRoot.textContent || "";
      }
      return document.body.textContent || "";
    });

    console.log("\n=== Page Text Content ===");
    console.log(textContent);

    // Check for auth status
    console.log("\n=== Checking Auth Status ===");
    const authInfo = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const buttonTexts = buttons.map((b) => b.textContent?.trim());

      // Check if there's a wish UI for google-auth
      const wishes = Array.from(document.querySelectorAll("[data-wish]"));
      const wishInfo = wishes.map((w) => ({
        wish: w.getAttribute("data-wish"),
        text: w.textContent?.trim(),
      }));

      return {
        buttons: buttonTexts,
        wishes: wishInfo,
        hasGoogleAuth: buttonTexts.some((t) =>
          t?.includes("Google") || t?.includes("Auth")
        ),
      };
    });

    console.log(JSON.stringify(authInfo, null, 2));

    // Try to click Fetch Emails if visible
    console.log("\n=== Looking for Fetch Emails Button ===");
    try {
      // Use evaluate to click from inside the page
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const fetchBtn = buttons.find((b) =>
          b.textContent?.includes("Fetch Emails")
        );
        if (fetchBtn) {
          (fetchBtn as HTMLButtonElement).click();
          return true;
        }
        return false;
      });

      if (clicked) {
        console.log("Clicked Fetch Emails button!");
        console.log("Waiting for emails to load...");
        await sleep(10000);

        // Get updated content
        const emailContent = await page.evaluate(() => {
          return document.body.textContent || "";
        });

        console.log("\n=== Email Content ===");
        console.log(emailContent);

        await Deno.writeTextFile(
          "/tmp/united-explorer-emails.txt",
          emailContent,
        );
        console.log(
          "\nEmail content saved to: /tmp/united-explorer-emails.txt",
        );
      } else {
        console.log("Fetch Emails button not found");
      }
    } catch (e) {
      console.log("Error clicking button:", e.message);
    }

    console.log("\n=== Browser will stay open for 60 seconds ===");
    console.log("Check the browser window to see the charm UI");
    await sleep(60000);
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await browser.close();
  }
}

main();
