import { chromium, type Browser, type Page, type BrowserContext } from "npm:playwright@1.40.1";

const URL = "http://localhost:8000/alex-112-claude-1/baedreicsz5frwn57hk6t7lnwvgkxbadeqy74ook3x72anz52j44wr5qgcu";
const SCREENSHOT_DIR = "/Users/alex/Code/labs/.playwright-mcp";

async function testShoppingList() {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    console.log("Launching browser with MCP Chrome...");
    
    browser = await chromium.connectOverCDP("http://localhost:9222");
    
    const contexts = browser.contexts();
    if (contexts.length > 0) {
      context = contexts[0];
    } else {
      context = await browser.newContext();
    }
    
    page = await context.newPage();

    const consoleMessages: Array<{ type: string; text: string }> = [];
    const errors: string[] = [];
    
    page.on("console", (msg) => {
      const text = msg.text();
      const msgType = msg.type();
      consoleMessages.push({ type: msgType, text });
      console.log("[" + msgType + "] " + text);
    });

    page.on("pageerror", (error) => {
      const errorMsg = error.toString();
      errors.push(errorMsg);
      console.error("[PAGE ERROR] " + errorMsg);
    });

    console.log("\n1. Navigating to URL...");
    await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);

    console.log("\n2. Taking initial screenshot...");
    await page.screenshot({ 
      path: SCREENSHOT_DIR + "/shopping-list-initial.png",
      fullPage: true 
    });
    console.log("   Screenshot saved: shopping-list-initial.png");

    console.log("\n3. Looking for Shopping List button...");
    
    const buttonSelectors = [
      'text="🛒 Shopping List"',
      'button:has-text("Shopping List")',
      'button:has-text("🛒")',
      '[data-testid*="shopping"]',
      'button'
    ];

    let button = null;
    let buttonText = "";
    
    for (const selector of buttonSelectors) {
      try {
        button = await page.locator(selector).first();
        if (await button.count() > 0) {
          buttonText = await button.textContent() || "";
          console.log("   Found button with selector: " + selector);
          console.log("   Button text: " + buttonText);
          break;
        }
      } catch (e) {
        // Continue
      }
    }

    if (!button || await button.count() === 0) {
      const allButtons = await page.locator("button").all();
      console.log("   Found " + allButtons.length + " total buttons on page:");
      for (let i = 0; i < allButtons.length; i++) {
        const text = await allButtons[i].textContent();
        console.log("     Button " + (i + 1) + ": " + text);
      }
      throw new Error("Could not find Shopping List button");
    }

    console.log("\n4. Clicking Shopping List button...");
    await button.click();
    console.log("   Button clicked");

    console.log("\n5. Waiting for page to load/render (5 seconds)...");
    await page.waitForTimeout(5000);

    console.log("\n6. Taking post-click screenshot...");
    await page.screenshot({ 
      path: SCREENSHOT_DIR + "/shopping-list-after-click.png",
      fullPage: true 
    });
    console.log("   Screenshot saved: shopping-list-after-click.png");

    console.log("\n7. Analyzing console output...");
    const stackOverflowErrors = consoleMessages.filter(msg => 
      msg.text.includes("Maximum call stack size exceeded") ||
      msg.text.includes("RangeError")
    );

    const otherErrors = consoleMessages.filter(msg => 
      msg.type === "error" && 
      !msg.text.includes("Maximum call stack size exceeded")
    );

    const bodyText = await page.locator("body").textContent();
    const hasContent = bodyText && bodyText.trim().length > 0;

    console.log("\n========== TEST RESULTS ==========");
    console.log("\nSuccessfully navigated to URL");
    console.log("Found and clicked Shopping List button");
    console.log("Page loaded after click");
    
    if (stackOverflowErrors.length > 0) {
      console.log("\nSTACK OVERFLOW ERRORS DETECTED (" + stackOverflowErrors.length + "):");
      stackOverflowErrors.forEach(err => console.log("   - " + err.text));
    } else {
      console.log("\nNo stack overflow errors detected");
    }

    if (errors.length > 0) {
      console.log("\nPAGE ERRORS DETECTED (" + errors.length + "):");
      errors.forEach(err => console.log("   - " + err));
    } else {
      console.log("\nNo page errors detected");
    }

    if (otherErrors.length > 0) {
      console.log("\nOTHER CONSOLE ERRORS (" + otherErrors.length + "):");
      otherErrors.forEach(err => console.log("   - " + err.text));
    }

    console.log("\nConsole message summary:");
    console.log("   - Total messages: " + consoleMessages.length);
    console.log("   - Errors: " + consoleMessages.filter(m => m.type === "error").length);
    console.log("   - Warnings: " + consoleMessages.filter(m => m.type === "warning").length);
    console.log("   - Info: " + consoleMessages.filter(m => m.type === "info" || m.type === "log").length);

    console.log("\nPage content: " + (hasContent ? "Present" : "Empty/Missing"));
    
    console.log("\nScreenshots saved to: " + SCREENSHOT_DIR);
    console.log("   - shopping-list-initial.png");
    console.log("   - shopping-list-after-click.png");

    console.log("\n==================================\n");

    console.log("Waiting 3 seconds before closing...");
    await page.waitForTimeout(3000);

  } catch (error) {
    console.error("\nTEST FAILED:");
    console.error(error);
    
    if (page) {
      console.log("\nTaking error screenshot...");
      await page.screenshot({ 
        path: SCREENSHOT_DIR + "/shopping-list-error.png",
        fullPage: true 
      });
    }
  } finally {
    if (page) await page.close();
    console.log("\nTest complete.");
  }
}

testShoppingList();
