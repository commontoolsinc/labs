import {
  ConsoleEvent,
  DialogEvent,
  ElementHandle,
  EvaluateFunction,
  EvaluateOptions,
  GoToOptions,
  InteractionObserver,
  Keyboard,
  Page as AstralPage,
  PageEventMap,
  ScreenshotOptions,
  SelectorOptions,
  WaitForOptions,
  WaitForSelectorOptions,
} from "@astral/astral";
import type {
  Page_screencastFrame,
  Page_screencastFrameEvent,
} from "../vendor-astral/bindings/celestial.ts";
import { sleep } from "@commonfabric/utils/sleep";
import { Mutable } from "@commonfabric/utils/types";
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
//
// A beforeunload confirmation is accepted ("Leave") rather than dismissed:
// dismissing it cancels the navigation the test just requested, which then
// times out. The shell raises this dialog when a reload would drop writes the
// server has not yet confirmed; a test that navigates at that point means to
// navigate anyway, and durability assertions belong to the runtime-idle
// checkpoint, not to this prompt.
export async function dismissDialogs(e: DialogEvent) {
  const dialog = e.detail;
  console.log(`Browser Dialog: ${dialog.type} - ${dialog.message}`);
  if (dialog.type === "beforeunload") {
    await dialog.accept();
  } else {
    await dialog.dismiss();
  }
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
  //
  // It also retains a bounded in-page tail of every formatted console message
  // on `globalThis.__cfConsoleTail` ({ t, method, text } entries, oldest
  // dropped). A failure probe evaluated in the page can include that tail, so
  // a timeout error reports what the page logged around the stall without the
  // test having to pipe the whole console stream.
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
      const tail: Array<{ t: number; method: string; text: string }> =
        ((globalThis as unknown as {
          __cfConsoleTail?: Array<{ t: number; method: string; text: string }>;
        }).__cfConsoleTail ??= []);
      const TAIL_LIMIT = 300;
      const trueConsole = globalThis.console;
      const newConsole = Object.create(null);
      for (const method of methods) {
        newConsole[method] = (...args: unknown[]) => {
          const formatted = args.map((value) => {
            if (value instanceof Error) {
              // Error properties are non-enumerable — JSON.stringify yields
              // "{}". The stack includes name + message.
              return value.stack ?? `${value.name}: ${value.message}`;
            }
            if (value && typeof value === "object") {
              try {
                return JSON.stringify(value);
              } catch (_e) {
                // satisfy typescript's empty block
              }
            }
            return value;
          });
          try {
            tail.push({
              t: Date.now(),
              method,
              text: formatted.map(String).join(" ").slice(0, 400),
            });
            if (tail.length > TAIL_LIMIT) {
              tail.splice(0, tail.length - TAIL_LIMIT);
            }
          } catch (_e) {
            // Retention must never break the logging call itself.
          }
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

  setInteractionObserver(observer?: InteractionObserver): void {
    this.checkIsOk();
    this.page!.setInteractionObserver(observer);
  }

  setDefaultTypeDelay(delay: number): void {
    this.checkIsOk();
    this.page!.keyboard.setDefaultTypeDelay(delay);
  }

  async setViewportSize(
    size: { width: number; height: number },
  ): Promise<void> {
    this.checkIsOk();
    await this.page!.setViewportSize(size);
  }

  async startScreencast(options: {
    format?: "jpeg" | "png";
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
    everyNthFrame?: number;
  } = {}): Promise<void> {
    this.checkIsOk();
    await this.page!.unsafelyGetCelestialBindings().Page.startScreencast(
      options,
    );
  }

  async stopScreencast(): Promise<void> {
    this.checkIsOk();
    await this.page!.unsafelyGetCelestialBindings().Page.stopScreencast();
  }

  async acknowledgeScreencastFrame(sessionId: number): Promise<void> {
    this.checkIsOk();
    await this.page!.unsafelyGetCelestialBindings().Page.screencastFrameAck({
      sessionId,
    });
  }

  onScreencastFrame(
    listener: (frame: Page_screencastFrame) => void,
  ): () => void {
    this.checkIsOk();
    const celestial = this.page!.unsafelyGetCelestialBindings();
    const handler: EventListener = (event) => {
      listener((event as Page_screencastFrameEvent).detail);
    };
    celestial.addEventListener("Page.screencastFrame", handler);
    return () => celestial.removeEventListener("Page.screencastFrame", handler);
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

  // Passthru of `@astral/astral`'s `Page#reload`
  async reload(options?: WaitForOptions): Promise<void> {
    this.checkIsOk();
    await this.page!.reload(options);
  }

  // Passthru of `@astral/astral`'s `Page#waitForSelector`
  async waitForSelector(
    selector: string,
    options?: WaitForSelectorOptions & SelectorOptions,
  ): Promise<ElementHandle> {
    this.checkIsOk();
    return await this.page!.waitForSelector(selector, options);
  }

  // Passthru of `@astral/astral`'s `Page#waitForFunction`
  async waitForFunction<T, R extends readonly unknown[]>(
    func: EvaluateFunction<T, R>,
    evaluateOptions?: EvaluateOptions<R>,
  ): Promise<void> {
    this.checkIsOk();
    await this.page!.waitForFunction(func, evaluateOptions);
  }

  // Expose a CDP binding named `name` on the page's global object. Calling
  // `globalThis[name](payload)` in the page produces a `Runtime.bindingCalled`
  // notification that `onBindingCalled` delivers to the test process. This is
  // how an in-page notifier signals the moment a condition holds without the
  // test polling the DOM.
  async addBinding(name: string): Promise<void> {
    this.checkIsOk();
    await this.page!.unsafelyGetCelestialBindings().Runtime.addBinding({
      name,
    });
  }

  // Unsubscribe the current connection from a binding's notifications. The
  // bound function may remain on the page's global object; the unique per-wait
  // name keeps that harmless.
  async removeBinding(name: string): Promise<void> {
    this.checkIsOk();
    await this.page!.unsafelyGetCelestialBindings().Runtime.removeBinding({
      name,
    });
  }

  // Subscribe to every `Runtime.bindingCalled` notification, invoking `listener`
  // with the binding name and its payload. Returns an unsubscribe function.
  onBindingCalled(
    listener: (name: string, payload: string) => void,
  ): () => void {
    this.checkIsOk();
    const celestial = this.page!.unsafelyGetCelestialBindings();
    const handler: EventListener = (event) => {
      const { name, payload } =
        (event as CustomEvent<{ name: string; payload: string }>).detail;
      listener(name, payload);
    };
    celestial.addEventListener("Runtime.bindingCalled", handler);
    return () =>
      celestial.removeEventListener("Runtime.bindingCalled", handler);
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
