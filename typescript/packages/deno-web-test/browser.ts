import { Browser, launch, Page } from "jsr:@astral/astral";
import { Manifest } from "./manifest.ts";
import { tsToJs, wait } from "./utils.ts";
import { TestResult } from "./interface.ts";

export class BrowserController {
  private manifest: Manifest;
  private page: Page | null;
  private browser: Browser | null;

  constructor(manifest: Manifest) {
    this.manifest = manifest;
    this.browser = null;
    this.page = null;
  }

  async load(filePath: string) {
    const rootUrl = `http://localhost:${this.manifest.port}`;
    const jsTestPath = tsToJs(filePath);
    const testUrl = `${rootUrl}/?test=/${jsTestPath}`;
    const config = this.manifest.config;

    if (this.page) {
      await this.page.goto(testUrl);
    } else {
      this.browser = await launch(config.astral ?? {});
      this.page = await this.browser.newPage(testUrl);
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
      await wait(200);
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
