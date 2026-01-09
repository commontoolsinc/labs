#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env --allow-run

/**
 * Chrome/headless browser runner for the object hashing benchmark.
 *
 * This script runs the benchmark in a headless Chrome browser using Astral.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-env --allow-run scripts/benchmark-object-hashing/chrome.ts
 */

import { launch } from "@astral/astral";
import { join } from "@std/path";

async function main() {
  console.log("=== Starting headless Chrome benchmark ===\n");

  // Get the path to the HTML file
  const scriptDir = new URL(".", import.meta.url).pathname;
  const htmlPath = join(scriptDir, "browser.html");
  const htmlUrl = `file://${htmlPath}`;

  console.log(`Loading benchmark from: ${htmlUrl}\n`);

  // Launch headless Chrome
  const browser = await launch({
    headless: true,
  });

  try {
    // Create a new page
    const page = await browser.newPage();

    // Set up console message listener
    page.addEventListener("console", (e: any) => {
      console.log(e.detail.text);
    });

    // Set up error listener
    page.addEventListener("pageerror", (e: any) => {
      console.error("Page error:", e.detail);
    });

    // Navigate to the HTML file
    await page.goto(htmlUrl, { waitUntil: "networkidle0" });

    // Wait for benchmark to complete
    console.log("Waiting for benchmark to complete...\n");
    await page.waitForFunction(
      () => (window as any).benchmarkComplete === true,
      { timeout: 600000 }, // 10 minutes timeout
    );

    // Get results
    const results = await page.evaluate(() => (window as any).benchmarkResults);

    console.log("\n=== Benchmark completed successfully ===");
    console.log(`Results collected: ${Object.keys(results).length} strategies`);
  } catch (err) {
    console.error("Error running benchmark:", err);
    throw err;
  } finally {
    await browser.close();
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    Deno.exit(1);
  });
}
