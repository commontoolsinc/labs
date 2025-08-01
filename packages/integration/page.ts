import {
  ConsoleEvent,
  DialogEvent,
  ElementHandle,
  EvaluateFunction,
  EvaluateOptions,
  GoToOptions,
  Keyboard,
  Page as AstralPage,
  PageEventMap,
  ScreenshotOptions,
  SelectorOptions,
  WaitForSelectorOptions,
} from "@astral/astral";
import { sleep } from "@commontools/utils/sleep";
import { Mutable } from "@commontools/utils/types";
import * as path from "@std/path";
import { ensureDirSync } from "@std/fs";
import { ConsoleMethod } from "./console.ts";

// To handle `console` events from `Page`, logging to outer context:
//
// ```ts
// page.addEventListener("console", pipeConsole);
// ```
export function pipeConsole(e: ConsoleEvent) {
  console.log(`Browser Console [${e.detail.type}]: ${e.detail.text}`);
}

// To handle `dialog` events from `Page`, automatically dismissing.
//
// ```ts
// page.addEventListener("dialog", dismissDialogs);
// ```
export async function dismissDialogs(e: DialogEvent) {
  const dialog = e.detail;
  console.log(`Browser Dialog: ${dialog.type} - ${dialog.message}`);
  await dialog.dismiss();
}

// Wrapper around `@astral/astral`'s `Page`.
export class Page extends EventTarget {
  private page: AstralPage | null;
  private timeout: number;

  constructor(page: AstralPage, options: { timeout: number }) {
    super();
    this.timeout = options.timeout;
    {
      const mutPage: Mutable<AstralPage> = page;
      // @ts-ignore We wrap Page in a Mutable
      // so we can override the readonly `timeout`
      // property. Type checker doesn't like this.
      mutPage.timeout = this.timeout;
    }
    this.page = page;
  }

  // @ts-ignore Astral tightens the args for `EventTarget`
  override addEventListener<K extends keyof PageEventMap>(
    type: K,
    callback: (
      event: PageEventMap[K],
    ) => void,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.checkIsOk();
    return this.page!.addEventListener(type, callback, options);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    this.checkIsOk();
    return this.page!.removeEventListener(type, callback, options);
  }

  override dispatchEvent(event: Event): boolean {
    this.checkIsOk();
    return this.page!.dispatchEvent(event);
  }

  // Extended method: Rewrites the contents' `console.*` methods to stringify
  // objects. The astral console handler only provides a concatenated
  // string of all console arguments, with objects represented as `"undefined"`.
  // Calling this method after navigating to a fresh document will properly
  // stringify objects in `ConsoleEvent#detail.text`.
  async applyConsoleFormatter() {
    this.checkIsOk();

    const trueConsoleKey: string = "__common_integration_console";
    const methods: string[] = Object.values(ConsoleMethod);

    await this.evaluate((trueConsoleKey: string, methods: string[]) => {
      // @ts-ignore: this code is stringified and sent to browser context
      // If console has already been stubbed for this document, abort.
      if (globalThis[trueConsoleKey]) {
        return;
      }
      const trueConsole = globalThis.console;
      const newConsole = Object.create(null);
      for (const method of methods) {
        newConsole[method] = (...args: any[]) => {
          const formatted = args.map((value) => {
            if (value && typeof value === "object") {
              try {
                return JSON.stringify(value);
              } catch (_e) {
                // satisfy typescript's empty block
              }
            }
            return value;
          });
          // @ts-ignore: this code is stringified and sent to browser context
          return trueConsole[method].apply(trueConsole, formatted);
        };
      }
      // @ts-ignore: this code is stringified and sent to browser context
      globalThis[trueConsoleKey] = trueConsole;
      // @ts-ignore: this code is stringified and sent to browser context
      globalThis.console = newConsole;
    }, { args: [trueConsoleKey, methods] });
  }

  // Extended method: Takes a screenshot, storing the result at `filename`.
  async screenshot(
    filename: string,
    options?: ScreenshotOptions,
  ): Promise<void> {
    this.checkIsOk();
    const screenshot = await this.page!.screenshot(options);
    return Deno.writeFile(filename, screenshot);
  }

  // Extended method: Takes a screenshot and HTML capture, storing
  // the timestamped artifacts in the provided `snapshotDir`.
  async snapshot(snapshotName: string, snapshotDir: string): Promise<void> {
    this.checkIsOk();
    ensureDirSync(snapshotDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePrefix = `${snapshotName}_${timestamp}`;

    const screenshot = await this.page!.screenshot();
    const html = await this.page!.content();
    await Deno.writeFile(
      path.join(snapshotDir, `${filePrefix}.png`),
      screenshot,
    );
    await Deno.writeTextFile(
      path.join(snapshotDir, `${filePrefix}.html`),
      html,
    );

    console.log(`→ Snapshot saved: ${filePrefix}`);
  }

  // Extended method: Waits for `selector` to contain matching `text`.
  // Times out after page `timeout` settings.
  async waitForSelectorWithText(
    selector: string,
    text: string,
  ): Promise<ElementHandle> {
    this.checkIsOk();
    const start = globalThis.performance.now();
    while (true) {
      const el = await this.waitForSelector(selector);
      if ((await el.innerText()) === text) {
        return el;
      }
      await sleep(200);
      if ((start + this.timeout) < globalThis.performance.now()) {
        throw new Error(
          `Timed out waiting for "${selector}" to have text "${text}".`,
        );
      }
    }
  }

  // Passthru of `@astral/astral`'s `Page#keyboard`
  get keyboard(): Keyboard {
    this.checkIsOk();
    return this.page!.keyboard;
  }

  // Passthru of `@astral/astral`'s `Page#evaluate`
  async evaluate<T, R extends readonly unknown[]>(
    evaluate: EvaluateFunction<T, R>,
    evaluateOptions?: EvaluateOptions<R>,
  ): Promise<T> {
    this.checkIsOk();
    return await this.page!.evaluate(evaluate, evaluateOptions);
  }

  // Passthru of `@astral/astral`'s `Page#goto`
  async goto(url: string, options?: GoToOptions): Promise<void> {
    this.checkIsOk();
    await this.page!.goto(url, options);
  }

  // Passthru of `@astral/astral`'s `Page#waitForSelector`
  async waitForSelector(
    selector: string,
    options?: WaitForSelectorOptions & SelectorOptions,
  ): Promise<ElementHandle> {
    this.checkIsOk();
    return await this.page!.waitForSelector(selector, options);
  }

  // Passthru of `@astral/astral`'s `Page#$`
  async $(
    selector: string,
    opts?: SelectorOptions,
  ): Promise<ElementHandle | null> {
    this.checkIsOk();
    return await this.page!.$(selector, opts);
  }

  // Passthru of `@astral/astral`'s `Page#$$`
  async $$(selector: string, opts?: SelectorOptions): Promise<ElementHandle[]> {
    this.checkIsOk();
    return await this.page!.$$(selector, opts);
  }

  // Passthru of `@astral/astral`'s `Page#close`
  async close() {
    this.checkIsOk();
    const page = this.page;
    this.page = null;
    await page!.close();
  }

  private checkIsOk() {
    if (!this.page) {
      throw new Error("Page is already closed.");
    }
  }
}
