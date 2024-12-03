import { chromium } from "playwright";

export async function takeScreenshot(
  url: string,
  { outputPath, fullPage }: { outputPath: string; fullPage: boolean },
) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: {
      width: 1024,
      height: 768,
    },
  });

  const page = await context.newPage();

  // Wait for network to be idle to ensure all content is loaded
  await page.goto(url, {
    waitUntil: "networkidle",
  });

  // Close the sidebar
  const selector = "os-navstack > os-navpanel > os-sidebar-close-button";
  await page.waitForSelector(selector);
  await page.click(selector);
  await page.waitForTimeout(500);
  await page.waitForLoadState("networkidle");

  // Take screenshot
  const screenshot = await page.screenshot({
    path: outputPath,
    fullPage,
  });

  console.log(`Saved screenshot of '${url}' to ${outputPath}`);

  await context.close();
  await browser.close();

  return screenshot;
}
