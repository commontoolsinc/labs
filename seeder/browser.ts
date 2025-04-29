import {
  Browser as AstralBrowser,
  launch,
  Page as AstralPage,
} from "@astral/astral";
import { login } from "@commontools/utils/integration";
import { sleep } from "@commontools/utils/sleep";

// Wrapper around `@astral/astral`'s `Browser`.
export class Browser {
  private browser: AstralBrowser | null;
  private page: AstralPage | null;
  private apiUrl: string;
  private constructor(
    browser: AstralBrowser,
    page: AstralPage,
    apiUrl: string,
  ) {
    this.browser = browser;
    this.page = page;
    this.apiUrl = apiUrl;
  }

  static async launch(
    { headless, apiUrl }: { headless: boolean; apiUrl: string },
  ): Promise<Browser> {
    const browser = await launch({
      args: ["--window-size=1280,1024"],
      headless,
    });
    const page = await browser.newPage();
    return new Browser(browser, page, apiUrl);
  }

  async screenshot(filename: string): Promise<void> {
    this.checkIsOk();
    const screenshot = await this.page!.screenshot();
    return Deno.writeFile(filename, screenshot);
  }

  async goto(url: string) {
    this.checkIsOk();
    await this.page!.goto(new URL(url, this.apiUrl).toString());
    await sleep(1000);
    this.addErrorListeners();
    await login(this.page!);
  }

  async checkForErrors(): Promise<any> {
    this.checkIsOk();
    return await this.page!.evaluate(() => {
      // @ts-ignore: this code is stringified and sent to browser context
      return globalThis.charmRuntimeErrors;
    });
  }

  async close(): Promise<void> {
    this.checkIsOk();
    const { page, browser } = this;
    this.browser = null;
    this.page = null;
    await browser!.close();
  }

  private addErrorListeners() {
    this.page!.evaluate(() => {
      // @ts-ignore: this code is stringified and sent to browser context
      globalThis.charmRuntimeErrors = [];
      globalThis.addEventListener("common-iframe-error", (e) => {
        // @ts-ignore: this code is stringified and sent to browser context
        globalThis.charmRuntimeErrors.push(e.detail.description);
      });
    });
  }

  private checkIsOk() {
    if (!this.browser || !this.page) {
      throw new Error("Browser is already closed.");
    }
  }
}
