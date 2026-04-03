import { Browser, ConsoleEvent, launch, Page } from "@astral/astral";
import { Manifest } from "./manifest.ts";
import { tsToJs } from "./utils.ts";
import { TestResult } from "./interface.ts";
import { extractAstralConfig } from "./config.ts";
import { sleep } from "@commontools/utils/sleep";

export class BrowserController extends EventTarget {
  private manifest: Manifest;
  private page: Page | null;
  private browser: Browser | null;
  private serverPort: number;

  constructor(manifest: Manifest, serverPort: number) {
    super();
    this.manifest = manifest;
    this.browser = null;
    this.page = null;
    this.serverPort = serverPort;
  }

  async load(filePath: string) {
    const rootUrl = `http://localhost:${this.serverPort}`;
    const jsTestPath = tsToJs(filePath);
    const testUrl = `${rootUrl}/?test=/${jsTestPath}`;
    const config = this.manifest.config;

    if (this.page) {
      await this.page.goto(testUrl);
    } else {
      this.browser = await launch(extractAstralConfig(config));
      this.page = await this.browser.newPage(testUrl);
      this.page.addEventListener("console", (e) => {
        // Not sure why this event needs reconstructed in order
        // to re-fire, rather than just passing it into `dispatchEvent`.
        this.dispatchEvent(
          new ConsoleEvent({
            type: e.detail.type,
            text: e.detail.text,
          }),
        );
      });
    }
    await this.waitUntilReady();
  }

  async getTestCount(): Promise<number> {
    if (!this.page) {
      throw new Error("No page loaded.");
    }
    return (await this.page.evaluate(() =>
      // @ts-ignore This is defined in the JS harness
      globalThis.__denoWebTest.getTestCount()
    ))
      .ok;
  }

  async runNextTest(): Promise<TestResult | void> {
    if (!this.page) {
      throw new Error("No page loaded.");
    }

    return (await this.page.evaluate(() =>
      // @ts-ignore This is defined in the JS harness
      globalThis.__denoWebTest.runNext()
    )).ok;
  }

  private async waitUntilReady() {
    if (!this.page) {
      throw new Error("No page loaded.");
    }
    for (let i = 0; i < 10; i++) {
      const response = await this.page.evaluate(() =>
        // @ts-ignore This is defined in the JS harness
        globalThis.__denoWebTest && globalThis.__denoWebTest.isReady()
      );
      if (response.ok) {
        return;
      }
      if (response.error) {
        throw new Error(response.error?.message ?? response.error);
      }
      await sleep(200);
    }
    throw new Error("Test harness not ready in 2s.");
  }

  async close() {
    this.page = null;
    if (this.browser) {
      await this.browser.close();
    }
    this.browser = null;
  }
}
