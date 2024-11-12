import puppeteer from "puppeteer";

async function takeScreenshot(url: string, outputPath: string) {
  const browser = await puppeteer.launch({
    defaultViewport: {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 2, // Retina-quality
    },
  });

  const page = await browser.newPage();

  // Wait for network to be idle to ensure all content is loaded
  await page.goto(url, {
    waitUntil: "networkidle0",
  });

  // Take full-page screenshot
  await page.screenshot({
    path: outputPath,
    // fullPage: true,
  });

  await browser.close();
}

// Usage
await takeScreenshot(
  "http://localhost:5173/recipe/ba4jcb3r4lpjo2fub6ra5sv3eejgyjsoozsz5r5n5ztsoebquco6ksv4y",
  "screenshot.png",
);
