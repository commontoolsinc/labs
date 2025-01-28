import { chromium } from "playwright";
import { browserSemaphore } from "./queue.ts";

export async function takeScreenshot(
  url: string,
  { outputPath, fullPage }: { outputPath: string; fullPage: boolean },
) {
  console.log(`Starting screenshot process for ${url}`);
  await browserSemaphore.acquire();
  console.log('Acquired browser semaphore');

  try {
    console.log('Launching browser...');
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: {
        width: 1024,
        height: 768,
      },
    });
    console.log('Browser context created with viewport 1024x768');

    const page = await context.newPage();
    console.log('New page created');

    // // Add console log listener
    // page.on('console', msg => {
    //   console.log(`Browser Console ${msg.type()}: ${msg.text()}`);
    // });

    // Add error handler
    page.on('pageerror', err => {
      console.error('Page error:', err.message);
    });

    console.log(`Navigating to ${url}...`);
    // Wait for network to be idle to ensure all content is loaded
    await page.goto(url, {
      waitUntil: "networkidle",
    });
    console.log('Page loaded, network idle');

    // Close the sidebar
    const selector = "os-navstack > os-navpanel > os-sidebar-close-button";
    console.log('Waiting for sidebar close button...');
    await page.waitForSelector(selector);
    console.log('Clicking sidebar close button...');
    await page.click(selector);
    await page.waitForTimeout(200);
    console.log('Waiting for network to settle after sidebar close...');

    // Take screenshot
    console.log(`Taking screenshot (fullPage: ${fullPage})...`);
    const screenshot = await page.screenshot({
      path: outputPath,
      fullPage,
    });
    console.log(`Screenshot saved to ${outputPath}`);

    await context.close();
    await browser.close();
    console.log('Browser closed');

    return screenshot;
  } catch (error) {
    console.error('Screenshot process failed:', error);
    throw error;
  } finally {
    browserSemaphore.release();
    console.log('Released browser semaphore');
  }
}
