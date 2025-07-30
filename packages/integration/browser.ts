import {
  Browser as AstralBrowser,
  launch,
  SandboxOptions,
  UserAgentOptions,
  WaitForOptions,
} from "@astral/astral";
import { Page } from "./page.ts";

const DEFAULT_ASTRAL_TIMEOUT = 60_000;

// Wrapper around `@astral/astral`'s `Browser`.
export class Browser {
  private browser: AstralBrowser | null;
  private timeout: number;

  private constructor(
    browser: AstralBrowser,
    options: { timeout: number },
  ) {
    this.browser = browser;
    this.timeout = options.timeout;
  }

  static async launch(
    config?: { timeout?: number; headless?: boolean; args?: string[] },
  ): Promise<Browser> {
    const headless = config?.headless ?? true;
    const args = config?.args ?? [];
    const timeout = config?.timeout ?? DEFAULT_ASTRAL_TIMEOUT;

    const browser = await launch({
      args,
      headless,
    });
    return new Browser(browser, { timeout });
  }

  // Passthru of `@astral/astral`'s `Browser#newPage`, applying
  // the browser timeout.
  async newPage(
    url?: string,
    options?: WaitForOptions & SandboxOptions & UserAgentOptions,
  ): Promise<Page> {
    this.checkIsOk();
    const page = await this.browser!.newPage(url, options);
    return new Page(page, { timeout: this.timeout });
  }

  async close(): Promise<void> {
    this.checkIsOk();
    const browser = this.browser;
    this.browser = null;
    await browser!.close();
  }

  private checkIsOk() {
    if (!this.browser) {
      throw new Error("Browser is already closed.");
    }
  }
}
