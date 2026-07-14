import type { ElementHandle, InteractionObserver } from "@astral/astral";
import type { Page } from "../page.ts";
import type { PresentationConfig } from "./config.ts";

const controllers = new WeakMap<Page, PresentationInteractions>();

export class PresentationInteractions {
  readonly #page: Page;
  readonly #config: Extract<PresentationConfig, { enabled: true }>;
  readonly #participant: { label: string; color: string };

  constructor(
    page: Page,
    config: Extract<PresentationConfig, { enabled: true }>,
    participant: { label: string; color: string },
  ) {
    this.#page = page;
    this.#config = config;
    this.#participant = participant;
  }

  install(): void {
    this.#page.setDefaultTypeDelay(this.#config.typingDelayMs);
    const observer: InteractionObserver = {
      beforeClick: (_element, point) => this.#moveCursor(point.x, point.y),
      afterClick: () => this.#pulseCursor(),
      beforeType: (element) => this.#moveCursorToElement(element),
    };
    this.#page.setInteractionObserver(observer);
    controllers.set(this.#page, this);
  }

  uninstall(): void {
    this.#page.setInteractionObserver(undefined);
    this.#page.setDefaultTypeDelay(0);
    controllers.delete(this.#page);
  }

  async prepareDocument(): Promise<void> {
    await this.#ensureOverlay();
  }

  async showCaption(label: string): Promise<void> {
    await this.#ensureOverlay();
    await this.#page.evaluate((label) => {
      const host = document.getElementById("__cf_demo_presentation_overlay");
      const caption = host?.shadowRoot?.getElementById("caption") as
        | HTMLElement
        | undefined;
      if (!caption) return;
      caption.textContent = label;
      caption.style.opacity = "1";
    }, { args: [label] });
  }

  async clearCaption(): Promise<void> {
    await this.#page.evaluate(() => {
      const host = document.getElementById("__cf_demo_presentation_overlay");
      const caption = host?.shadowRoot?.getElementById("caption") as
        | HTMLElement
        | undefined;
      if (!caption) return;
      caption.style.opacity = "0";
    });
  }

  async typeIntoCfInput(
    selector: string,
    value: string,
    timeout: number,
  ): Promise<void> {
    const host = await this.#page.waitForSelector(selector, {
      strategy: "pierce",
      timeout,
    });
    await this.#moveCursorToElement(host);
    const focused = await host.evaluate((element: Element) => {
      const input = element instanceof HTMLInputElement
        ? element
        : element.shadowRoot?.querySelector("input");
      if (
        !(input instanceof HTMLInputElement) || input.disabled || input.readOnly
      ) {
        return false;
      }
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (setter) setter.call(input, "");
      else input.value = "";
      input.dispatchEvent(
        new Event("input", { bubbles: true, composed: true }),
      );
      input.focus();
      return true;
    });
    if (!focused) {
      throw new Error(`"${selector}" did not resolve to a fillable input`);
    }
    await this.#page.keyboard.type(value);
    const committed = await host.evaluate(
      async (element: Element, value: string) => {
        const input = element instanceof HTMLInputElement
          ? element
          : element.shadowRoot?.querySelector("input");
        if (!(input instanceof HTMLInputElement)) return false;
        input.dispatchEvent(
          new Event("change", { bubbles: true, composed: true }),
        );
        input.blur();
        const root = input.getRootNode();
        const owner = (root instanceof ShadowRoot ? root.host : element) as
          & Element
          & {
            commit?: () => Promise<void>;
            requestUpdate?: () => void | Promise<void>;
          };
        await owner.commit?.();
        await owner.requestUpdate?.();
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        return input.value === value;
      },
      { args: [value] },
    );
    if (!committed) {
      throw new Error(
        `presentation typing did not commit "${value}" to "${selector}"`,
      );
    }
  }

  async hold(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async #moveCursorToElement(element: ElementHandle): Promise<void> {
    const box = await element.boundingBox();
    if (!box) return;
    await this.#moveCursor(box.x + box.width / 2, box.y + box.height / 2);
  }

  async #moveCursor(x: number, y: number): Promise<void> {
    await this.#ensureOverlay();
    await this.#page.evaluate(async (x, y, duration) => {
      const rootId = "__cf_demo_presentation_overlay";
      const host = document.getElementById(rootId)!;
      const cursor = host.shadowRoot!.getElementById("cursor") as HTMLElement;
      cursor.style.transitionDuration = `${duration}ms`;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
      cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      await new Promise((resolve) => setTimeout(resolve, duration));
    }, { args: [x, y, this.#config.cursorTravelMs] });
    await this.hold(this.#config.cursorSettleMs);
  }

  async #ensureOverlay(): Promise<void> {
    await this.#page.evaluate((label, color) => {
      const rootId = "__cf_demo_presentation_overlay";
      if (document.getElementById(rootId)) return;
      const host = document.createElement("div");
      host.id = rootId;
      host.setAttribute("aria-hidden", "true");
      Object.assign(host.style, {
        position: "fixed",
        inset: "0",
        pointerEvents: "none",
        zIndex: "2147483647",
      });
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `<style>
        #cursor {
          position: fixed; left: 0; top: 0; width: 18px; height: 24px;
          transform: translate3d(24px, 24px, 0);
          transition-property: transform;
          transition-timing-function: cubic-bezier(.2,.8,.2,1);
          filter: drop-shadow(0 1px 2px rgba(0,0,0,.7));
        }
        #cursor::before {
          content: ""; display: block; width: 0; height: 0;
          border-top: 20px solid white; border-right: 13px solid transparent;
          transform: rotate(-20deg);
        }
        #cursor.pulse { filter: drop-shadow(0 0 7px #60a5fa); }
        #label {
          position: fixed; top: 16px; left: 16px; padding: 7px 12px;
          border-radius: 999px; color: white; background: var(--accent);
          font: 600 15px/1.2 system-ui, sans-serif;
          box-shadow: 0 2px 8px rgba(0,0,0,.3);
        }
        #caption {
          position: fixed; left: 50%; bottom: 22px; max-width: min(760px, 80vw);
          transform: translateX(-50%); padding: 10px 16px; border-radius: 10px;
          color: white; background: rgba(15,23,42,.88);
          font: 600 17px/1.35 system-ui, sans-serif; text-align: center;
          box-shadow: 0 3px 14px rgba(0,0,0,.35); opacity: 0;
          transition: opacity 180ms ease;
        }
      </style><div id="label"></div><div id="caption"></div><div id="cursor"></div>`;
      const labelElement = shadow.getElementById("label") as HTMLElement;
      labelElement.textContent = label;
      labelElement.style.setProperty("--accent", color);
      document.documentElement.append(host);
    }, { args: [this.#participant.label, this.#participant.color] });
  }

  async #pulseCursor(): Promise<void> {
    await this.#page.evaluate(async (duration) => {
      const host = document.getElementById("__cf_demo_presentation_overlay");
      const cursor = host?.shadowRoot?.getElementById("cursor");
      if (!cursor) return;
      cursor.classList.add("pulse");
      await new Promise((resolve) => setTimeout(resolve, duration));
      cursor.classList.remove("pulse");
    }, { args: [this.#config.clickPulseMs] });
  }
}

export function installPresentationInteractions(
  page: Page,
  config: Extract<PresentationConfig, { enabled: true }>,
  participant: { label: string; color: string },
): PresentationInteractions {
  const existing = controllers.get(page);
  if (existing) return existing;
  const controller = new PresentationInteractions(page, config, participant);
  controller.install();
  return controller;
}

export function presentationInteractions(
  page: Page,
): PresentationInteractions | undefined {
  return controllers.get(page);
}
