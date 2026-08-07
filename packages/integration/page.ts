import {
  ConsoleEvent,
  DialogEvent,
  ElementHandle as AstralElementHandle,
  EvaluateFunction,
  EvaluateOptions,
  GoToOptions,
  Keyboard,
  KeyboardTypeOptions,
  Page as AstralPage,
  PageEventMap,
  ScreenshotOptions,
  WaitForOptions,
  WaitForSelectorOptions,
} from "@astral/astral";
import type {
  ElementHandle,
  InteractionObserver,
  ScreencastFrame,
  SelectorOptions,
} from "./astral-adapter.ts";
import {
  queryAllPierce,
  queryPierce,
  waitForPierceSelector,
} from "./astral-adapter.ts";
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
  private afterNavigation?: () => Promise<void> | void;
  private interactionObserver?: InteractionObserver;
  private defaultTypeDelay = 0;
  private decoratedElements = new WeakSet<AstralElementHandle>();
  private patchedKeyboard?: Keyboard;
  private originalKeyboardType?: Keyboard["type"];

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

  // Returns Astral's keyboard with `type` patched to apply the configured
  // default delay when a call omits one.
  get keyboard(): Keyboard {
    this.checkIsOk();
    const keyboard = this.page!.keyboard;
    if (this.patchedKeyboard !== keyboard) {
      this.patchedKeyboard = keyboard;
      this.originalKeyboardType = keyboard.type.bind(keyboard);
      Object.defineProperty(keyboard, "type", {
        configurable: true,
        writable: true,
        value: (
          text: Parameters<Keyboard["type"]>[0],
          options: KeyboardTypeOptions = {},
        ) =>
          this.originalKeyboardType!(text, {
            ...options,
            delay: options.delay ?? this.defaultTypeDelay,
          }),
      });
    }
    return keyboard;
  }

  setInteractionObserver(observer?: InteractionObserver): void {
    this.checkIsOk();
    this.interactionObserver = observer;
  }

  setDefaultTypeDelay(delay: number): void {
    this.checkIsOk();
    this.defaultTypeDelay = delay;
  }

  setAfterNavigationHook(hook?: () => Promise<void> | void): void {
    this.afterNavigation = hook;
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
    listener: (frame: ScreencastFrame) => void,
  ): () => void {
    this.checkIsOk();
    const celestial = this.page!.unsafelyGetCelestialBindings();
    const handler: EventListener = (event) => {
      listener((event as CustomEvent<ScreencastFrame>).detail);
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
    await this.afterNavigation?.();
  }

  // Passthru of `@astral/astral`'s `Page#reload`
  async reload(options?: WaitForOptions): Promise<void> {
    this.checkIsOk();
    await this.page!.reload(options);
    await this.afterNavigation?.();
  }

  // Passthru of `@astral/astral`'s `Page#waitForSelector`.
  //
  // With `strategy: "pierce"` the wait is driven by page events and takes no
  // timeout, and it resolves against the same elements `$` with that strategy
  // returns: light-DOM elements and elements inside open shadow roots alike.
  async waitForSelector(
    selector: string,
    options?: WaitForSelectorOptions & SelectorOptions,
  ): Promise<ElementHandle> {
    this.checkIsOk();
    if (options?.strategy === "pierce") {
      if (options.timeout !== undefined) {
        throw new TypeError(
          "Pierce-selector waits are event-driven and do not accept a timeout",
        );
      }
      return this.decorateElement(
        await waitForPierceSelector(this.page!, selector),
      );
    }
    const astralOptions = options?.timeout === undefined
      ? undefined
      : { timeout: options.timeout };
    return this.decorateElement(
      await this.page!.waitForSelector(selector, astralOptions),
    );
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
    const element = opts?.strategy === "pierce"
      ? await queryPierce(this.page!, selector)
      : await this.page!.$(selector);
    return this.decorateElement(element);
  }

  // Passthru of `@astral/astral`'s `Page#$$`
  async $$(selector: string, opts?: SelectorOptions): Promise<ElementHandle[]> {
    this.checkIsOk();
    const elements = opts?.strategy === "pierce"
      ? await queryAllPierce(this.page!, selector)
      : await this.page!.$$(selector);
    return elements.map((element) => this.decorateElement(element));
  }

  // Extended method: Dispatch one trusted click at a viewport point.
  //
  // For a caller that has already worked out where to click — a wait that
  // measured its target at the instant the target was ready, say — this is the
  // dispatch on its own, with no measurement of its own to go stale.
  // The interaction observer sees this dispatch as it sees an element's, with
  // no element to name, so a presentation recording still moves and pulses its
  // cursor over a click aimed by coordinates.
  async clickPoint(point: { x: number; y: number }): Promise<void> {
    this.checkIsOk();
    await this.dispatchObservedClick(undefined, point);
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

  private decorateElement(element: null): null;
  private decorateElement(element: AstralElementHandle): ElementHandle;
  private decorateElement(
    element: AstralElementHandle | null,
  ): ElementHandle | null;
  private decorateElement(
    element: AstralElementHandle | null,
  ): ElementHandle | null {
    if (!element) return null;
    if (this.decoratedElements.has(element)) return element as ElementHandle;
    this.decoratedElements.add(element);

    const nativeQuery = element.$.bind(element);
    const nativeQueryAll = element.$$.bind(element);
    const nativeWaitForSelector = element.waitForSelector.bind(element);
    Object.defineProperties(element, {
      $: {
        configurable: true,
        value: async (selector: string, options?: SelectorOptions) => {
          this.checkIsOk();
          const child = options?.strategy === "pierce"
            ? await queryPierce(this.page!, selector, element)
            : await nativeQuery(selector);
          return this.decorateElement(child);
        },
      },
      $$: {
        configurable: true,
        value: async (selector: string, options?: SelectorOptions) => {
          this.checkIsOk();
          const children = options?.strategy === "pierce"
            ? await queryAllPierce(this.page!, selector, false, element)
            : await nativeQueryAll(selector);
          return children.map((child) => this.decorateElement(child));
        },
      },
      click: {
        configurable: true,
        value: (
          options?: Parameters<AstralElementHandle["click"]>[0],
        ) => this.clickElement(element, options),
      },
      type: {
        configurable: true,
        value: (text: string, options?: KeyboardTypeOptions) =>
          this.typeIntoElement(element, text, options),
      },
      waitForSelector: {
        configurable: true,
        value: async (
          selector: string,
          options?: WaitForSelectorOptions & SelectorOptions,
        ) => {
          this.checkIsOk();
          if (options?.strategy === "pierce") {
            if (options.timeout !== undefined) {
              throw new TypeError(
                "Pierce-selector waits are event-driven and do not accept a timeout",
              );
            }
            return this.decorateElement(
              await waitForPierceSelector(this.page!, selector, element),
            );
          }
          const astralOptions = options?.timeout === undefined
            ? undefined
            : { timeout: options.timeout };
          return this.decorateElement(
            await nativeWaitForSelector(selector, astralOptions),
          );
        },
      },
    });
    return element as ElementHandle;
  }

  private async clickElement(
    element: AstralElementHandle,
    options?: Parameters<AstralElementHandle["click"]>[0],
  ): Promise<void> {
    const aim = await aimAtElement(element, options?.offset);
    if ("unclickable" in aim) {
      throw new Error(`Cannot click ${describeAimTarget(aim)}`);
    }
    await this.dispatchObservedClick(
      element as ElementHandle,
      { x: aim.x, y: aim.y },
      options,
    );
  }

  // Dispatch one trusted click at `point`, with the interaction observer told
  // before and after. The observer's failure is reported only when the click
  // itself succeeded, so a recording problem never masks a click problem.
  private async dispatchObservedClick(
    element: ElementHandle | undefined,
    point: { x: number; y: number },
    options?: Parameters<AstralElementHandle["click"]>[0],
  ): Promise<void> {
    await this.interactionObserver?.beforeClick?.(element, point);
    let actionError: unknown;
    try {
      await this.page!.mouse.click(point.x, point.y, options);
    } catch (error) {
      actionError = error;
    }
    try {
      await this.interactionObserver?.afterClick?.(element, point, actionError);
    } catch (observerError) {
      if (actionError === undefined) throw observerError;
    }
    if (actionError !== undefined) throw actionError;
  }

  private async typeIntoElement(
    element: AstralElementHandle,
    text: string,
    options?: KeyboardTypeOptions,
  ): Promise<void> {
    await element.focus();
    await this.interactionObserver?.beforeType?.(
      element as ElementHandle,
      text,
    );
    let actionError: unknown;
    try {
      await this.keyboard.type(text, options);
    } catch (error) {
      actionError = error;
    }
    try {
      await this.interactionObserver?.afterType?.(
        element as ElementHandle,
        text,
        actionError,
      );
    } catch (observerError) {
      if (actionError === undefined) throw observerError;
    }
    if (actionError !== undefined) throw actionError;
  }
}

/**
 * Where a trusted click should land, or why it cannot land at all.
 *
 * The point is in viewport coordinates, which is what `Input.dispatchMouseEvent`
 * takes, and is measured after the element has been scrolled into view.
 */
export type AimResult =
  | { x: number; y: number }
  | {
    unclickable: "detached" | "not-rendered" | "unresolvable";
    tag?: string;
    id?: string;
    rootHost?: string;
    display?: string;
    visibility?: string;
    width?: number;
    height?: number;
    detail?: string;
  };

/**
 * Scroll `element` into view and measure the point to click, both inside a
 * single page turn.
 *
 * Aiming is one turn on purpose. Scrolling and measuring as two protocol
 * commands leaves the page free to relayout or rebuild between them, and the
 * second command then measures something other than what the first scrolled to.
 * Doing both in the page means the coordinates describe the element as it was
 * at one instant, and the only remaining gap is the one dispatch that follows.
 *
 * An element with no layout box yields `unclickable` naming what is wrong with
 * it, rather than an empty measurement the caller has to guess at.
 */
async function aimAtElement(
  element: AstralElementHandle,
  offset?: { x: number; y: number },
): Promise<AimResult> {
  try {
    return await element.evaluate(
      (
        el: Element,
        offsetX: number | null,
        offsetY: number | null,
      ): AimResult => {
        const describe = () => ({
          tag: el.tagName.toLowerCase(),
          id: el.id,
          rootHost: (el.getRootNode() as ShadowRoot).host?.tagName
            ?.toLowerCase(),
        });
        if (!el.isConnected) {
          return { unclickable: "detached", ...describe() };
        }
        // Instant, because a page-level `scroll-behavior: smooth` would leave
        // the element still moving when the rect below is read.
        el.scrollIntoView({
          block: "nearest",
          inline: "nearest",
          behavior: "instant",
        });
        const style = globalThis.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (
          style.display === "none" || style.visibility === "hidden" ||
          rect.width === 0 || rect.height === 0
        ) {
          return {
            unclickable: "not-rendered",
            ...describe(),
            display: style.display,
            visibility: style.visibility,
            width: rect.width,
            height: rect.height,
          };
        }
        if (offsetX === null || offsetY === null) {
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }

        // Astral defines an offset from the content quad's top-left point, not
        // from the border box returned by getBoundingClientRect(). Reconstruct
        // that point from the element's own 2D transform so the one-turn aim
        // preserves published ElementHandle.click({ offset }) behavior without
        // returning to the stale DOM-agent handle path.
        const pixels = (value: string) => Number.parseFloat(value) || 0;
        const insetX = pixels(style.borderLeftWidth) +
          pixels(style.paddingLeft);
        const insetY = pixels(style.borderTopWidth) +
          pixels(style.paddingTop);
        let matrix = new DOMMatrixReadOnly();
        try {
          if (style.transform !== "none") {
            matrix = new DOMMatrixReadOnly(style.transform);
          }
        } catch {
          // A browser that exposes an unparsable transform still gets the
          // untransformed content-box correction below.
        }

        if (el instanceof HTMLElement && matrix.is2D) {
          const width = el.offsetWidth;
          const height = el.offsetHeight;
          const corners = [
            { x: 0, y: 0 },
            { x: width, y: 0 },
            { x: width, y: height },
            { x: 0, y: height },
          ].map(({ x, y }) => ({
            x: matrix.a * x + matrix.c * y,
            y: matrix.b * x + matrix.d * y,
          }));
          const borderOrigin = {
            x: rect.x - Math.min(...corners.map(({ x }) => x)),
            y: rect.y - Math.min(...corners.map(({ y }) => y)),
          };
          return {
            x: borderOrigin.x + matrix.a * insetX + matrix.c * insetY +
              offsetX,
            y: borderOrigin.y + matrix.b * insetX + matrix.d * insetY +
              offsetY,
          };
        }

        return {
          x: rect.x + insetX + offsetX,
          y: rect.y + insetY + offsetY,
        };
      },
      { args: [offset?.x ?? null, offset?.y ?? null] },
    );
  } catch (error) {
    // A handle whose node the DOM agent no longer knows about cannot be
    // resolved to a page object at all. That happens to every outstanding
    // handle the moment anything else queries the document, so it is a
    // separate condition from an element that is present but unclickable.
    return { unclickable: "unresolvable", detail: String(error) };
  }
}

/** The human-readable half of an {@link AimResult} that cannot be clicked. */
function describeAimTarget(aim: Extract<AimResult, { unclickable: string }>) {
  const named = aim.id ? `${aim.tag}#${aim.id}` : aim.tag ?? "the element";
  const inside = aim.rootHost ? ` inside <${aim.rootHost}>` : "";
  switch (aim.unclickable) {
    case "detached":
      return `${named}${inside}: it is no longer in the document`;
    case "not-rendered":
      return `${named}${inside}: it has no layout box ` +
        `(display: ${aim.display}, visibility: ${aim.visibility}, ` +
        `${aim.width}x${aim.height})`;
    default:
      return `the element: its handle no longer resolves to a node ` +
        `(${aim.detail})`;
  }
}
