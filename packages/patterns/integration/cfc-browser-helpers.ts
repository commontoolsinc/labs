import { Page, waitFor } from "@commonfabric/integration";
import { toIndentedDebugString } from "@commonfabric/data-model/value-debug";

const DEFAULT_CFC_BROWSER_TIMEOUT = 30_000;
const CLICK_TARGET_ATTR = "data-cfc-click-target";

export async function clickTrustedAction(
  page: Page,
  action: string,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  const token = `trusted-action-${crypto.randomUUID()}`;
  let probe: TrustedActionProbe | undefined;
  try {
    await waitFor(async () => {
      try {
        const marked = await markVisibleTrustedAction(page, action, token);
        if (!marked) {
          probe = await readTrustedActionProbe(page, action);
          return false;
        }
        const button = await page.waitForSelector(
          `[${CLICK_TARGET_ATTR}="${token}"]`,
          { strategy: "pierce", timeout: 1_000 },
        );
        await button.click();
        return true;
      } catch {
        probe = await readTrustedActionProbe(page, action);
        await clearTrustedActionMark(page, token).catch(() => {});
        return false;
      }
    }, { timeout, delay: 250 });
  } catch (cause) {
    probe ??= await readTrustedActionProbe(page, action).catch(() => undefined);
    // Indented for readable test-log output
    throw new Error(
      `Timed out clicking trusted action "${action}". Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  } finally {
    await clearTrustedActionMark(page, token).catch(() => {});
  }
}

export async function clickTrustedActionAndWaitForText(
  page: Page,
  action: string,
  selector: string,
  text: string,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  let actionProbe: TrustedActionProbe | undefined;
  let textProbe: TextProbe | undefined;
  try {
    await waitFor(async () => {
      if (await textIsPresent(page, selector, text)) {
        return true;
      }
      try {
        await clickTrustedAction(page, action, { timeout: 2_000 });
      } catch {
        actionProbe = await readTrustedActionProbe(page, action).catch(() =>
          undefined
        );
        textProbe = await readTextProbe(page, selector).catch(() => undefined);
        return false;
      }
      const updated = await textIsPresent(page, selector, text);
      if (!updated) {
        textProbe = await readTextProbe(page, selector).catch(() => undefined);
      }
      return updated;
    }, { timeout, delay: 1_000 });
  } catch (cause) {
    actionProbe ??= await readTrustedActionProbe(page, action).catch(() =>
      undefined
    );
    textProbe ??= await readTextProbe(page, selector).catch(() => undefined);
    throw new Error(
      `Timed out clicking trusted action "${action}" until "${selector}" contained "${text}". Last probes: ${
        toIndentedDebugString({ actionProbe, textProbe })
      }`,
      { cause },
    );
  }
}

export async function waitForText(
  page: Page,
  selector: string,
  text: string,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  let probe: TextProbe | undefined;
  try {
    await waitFor(async () => {
      try {
        const node = await page.waitForSelector(selector, {
          strategy: "pierce",
          timeout: 1_000,
        });
        return (await node.innerText())?.includes(text) === true;
      } catch {
        probe = await readTextProbe(page, selector);
        return false;
      }
    }, { timeout, delay: 250 });
  } catch (cause) {
    probe ??= await readTextProbe(page, selector).catch(() => undefined);
    throw new Error(
      `Timed out waiting for "${selector}" to contain "${text}". Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  }
}

export async function waitForTextAbsent(
  page: Page,
  selector: string,
  text: string,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  let probe: TextProbe | undefined;
  try {
    await waitFor(async () => {
      try {
        const node = await page.waitForSelector(selector, {
          strategy: "pierce",
          timeout: 1_000,
        });
        return (await node.innerText())?.includes(text) !== true;
      } catch {
        probe = await readTextProbe(page, selector);
        return false;
      }
    }, { timeout, delay: 250 });
  } catch (cause) {
    probe ??= await readTextProbe(page, selector).catch(() => undefined);
    throw new Error(
      `Timed out waiting for "${selector}" not to contain "${text}". Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  }
}

export async function fillCfInput(
  page: Page,
  selector: string,
  value: string,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  let probe: CfInputProbe | undefined;
  try {
    await waitFor(async () => {
      try {
        const field = await page.waitForSelector(selector, {
          strategy: "pierce",
          timeout: 1_000,
        });
        probe = await field.evaluate(
          async (
            element: Element,
            nextValue: string,
          ): Promise<CfInputProbe> => {
            const input = element instanceof HTMLInputElement
              ? element
              : element.shadowRoot?.querySelector("input");
            if (!(input instanceof HTMLInputElement)) {
              return {
                selector: element.tagName.toLowerCase(),
                found: false,
                value: "",
                cellValue: undefined,
                hasCell: false,
                disabled: false,
                readOnly: false,
                visible: false,
                hostTagName: element.tagName.toLowerCase(),
              };
            }

            const rect = input.getBoundingClientRect();
            const style = globalThis.getComputedStyle(input);
            const visible = rect.width > 0 && rect.height > 0 &&
              rect.bottom >= 0 && rect.right >= 0 &&
              rect.top <= globalThis.innerHeight &&
              rect.left <= globalThis.innerWidth &&
              style.visibility !== "hidden" &&
              style.display !== "none";
            const root = input.getRootNode();
            const host = root instanceof ShadowRoot ? root.host : element;
            const hostWithCell = host as Element & {
              value?: {
                get?: () => unknown;
                set?: (value: string) => Promise<void>;
                sync?: () => Promise<unknown>;
              };
              requestUpdate?: () => void | Promise<void>;
            };
            const readCellValue = () =>
              typeof hostWithCell.value?.get === "function"
                ? hostWithCell.value.get()
                : undefined;
            if (!visible || input.disabled || input.readOnly) {
              return {
                selector: input.tagName.toLowerCase(),
                found: true,
                value: input.value,
                cellValue: readCellValue(),
                hasCell: hostWithCell.value !== undefined,
                disabled: input.disabled,
                readOnly: input.readOnly,
                visible,
                hostTagName: hostWithCell.tagName.toLowerCase(),
              };
            }

            input.scrollIntoView({ block: "center", inline: "center" });
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve))
            );
            input.focus();
            const valueSetter = Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              "value",
            )?.set;
            if (valueSetter) {
              valueSetter.call(input, nextValue);
            } else {
              input.value = nextValue;
            }
            input.dispatchEvent(
              new Event("input", { bubbles: true, composed: true }),
            );
            input.dispatchEvent(
              new Event("change", { bubbles: true, composed: true }),
            );
            input.blur();

            if (typeof hostWithCell.value?.set === "function") {
              await hostWithCell.value.set(nextValue);
            }
            const syncedCellValue =
              typeof hostWithCell.value?.sync === "function"
                ? await hostWithCell.value.sync()
                : readCellValue();
            if (typeof hostWithCell.requestUpdate === "function") {
              await hostWithCell.requestUpdate.call(hostWithCell);
            }
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve))
            );

            return {
              selector: input.tagName.toLowerCase(),
              found: true,
              value: input.value,
              cellValue: syncedCellValue,
              hasCell: hostWithCell.value !== undefined,
              disabled: input.disabled,
              readOnly: input.readOnly,
              visible,
              hostTagName: hostWithCell.tagName.toLowerCase(),
            };
          },
          { args: [value] },
        );
        return probe.found && probe.visible && !probe.disabled &&
          !probe.readOnly &&
          (probe.hasCell ? probe.cellValue === value : probe.value === value);
      } catch {
        return false;
      }
    }, { timeout, delay: 250 });
  } catch (cause) {
    throw new Error(
      `Timed out filling cf input "${selector}" with "${value}". Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  }
}

export async function waitForRuntimeIdle(
  page: Page,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  await waitFor(async () => {
    return await page.evaluate(async () => {
      const rt = globalThis.commonfabric?.rt;
      if (!rt?.idle) return false;
      await rt.idle();
      return true;
    });
  }, { timeout, delay: 250 });
}

async function textIsPresent(
  page: Page,
  selector: string,
  text: string,
): Promise<boolean> {
  try {
    return await page.evaluate((targetSelector, targetText) => {
      function collect(root: Document | ShadowRoot, result: Element[]): void {
        for (const element of root.querySelectorAll("*")) {
          try {
            if (element.matches(targetSelector)) {
              result.push(element);
            }
          } catch {
            // Invalid selectors are reported through the empty probe.
          }
          if (element.shadowRoot) {
            collect(element.shadowRoot, result);
          }
        }
      }

      function deepText(root: ParentNode): string {
        let content = "";
        if (root instanceof HTMLElement) {
          content = root.innerText ?? root.textContent ?? "";
        } else if (root instanceof ShadowRoot) {
          content = root.textContent ?? "";
        }
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) {
            content += ` ${deepText(element.shadowRoot)}`;
          }
        }
        return content;
      }

      const matches: Element[] = [];
      collect(document, matches);
      return matches.some((element) => deepText(element).includes(targetText));
    }, { args: [selector, text] });
  } catch {
    return false;
  }
}

type TrustedActionProbe = {
  action: string;
  lastClick?: {
    trusted: boolean;
    path: Array<{
      tagName: string;
      id: string;
      dataset: Record<string, string>;
    }>;
  };
  matches: Array<{
    tagName: string;
    text: string;
    rect: { width: number; height: number; top: number; left: number };
    disabled: boolean;
    visible: boolean;
    clickTarget: {
      tagName: string;
      text: string;
      rect: { width: number; height: number; top: number; left: number };
      disabled: boolean;
      visible: boolean;
    };
  }>;
  bodyText: string;
};

type TextProbe = {
  selector: string;
  matches: Array<{
    tagName: string;
    text: string;
    rect: { width: number; height: number; top: number; left: number };
    visible: boolean;
  }>;
  bodyText: string;
};

type CfInputProbe = {
  selector: string;
  found: boolean;
  value: string;
  cellValue: unknown;
  hasCell: boolean;
  disabled: boolean;
  readOnly: boolean;
  visible: boolean;
  hostTagName: string;
};

async function markVisibleTrustedAction(
  page: Page,
  action: string,
  token: string,
): Promise<boolean> {
  return await page.evaluate(async (targetAction, targetToken, targetAttr) => {
    function collect(
      root: Document | ShadowRoot,
      result: Element[],
    ): void {
      for (const element of root.querySelectorAll("*")) {
        if (element.getAttribute("data-ui-action") === targetAction) {
          result.push(element);
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    function isVisible(element: HTMLElement): boolean {
      const rect = element.getBoundingClientRect();
      const style = globalThis.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        rect.bottom >= 0 && rect.right >= 0 &&
        rect.top <= globalThis.innerHeight &&
        rect.left <= globalThis.innerWidth &&
        style.visibility !== "hidden" &&
        style.display !== "none";
    }

    function isDisabled(element: HTMLElement): boolean {
      return element.hasAttribute("disabled") ||
        element.getAttribute("aria-disabled") === "true";
    }

    const matches: Element[] = [];
    collect(document, matches);
    for (const element of matches) {
      const target = element as HTMLElement;
      target.scrollIntoView({ block: "center", inline: "center" });
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
      const clickTarget =
        (target.shadowRoot?.querySelector("[data-cf-button]") as
          | HTMLElement
          | null) ?? target;
      if (
        isVisible(target) && isVisible(clickTarget) &&
        !isDisabled(target) && !isDisabled(clickTarget)
      ) {
        clickTarget.setAttribute(targetAttr, targetToken);
        clickTarget.addEventListener(
          "click",
          (event) => {
            (globalThis as typeof globalThis & {
              __lastCfcTrustedActionClick?: TrustedActionProbe["lastClick"];
            }).__lastCfcTrustedActionClick = {
              trusted: event.isTrusted,
              path: event.composedPath().flatMap((node) => {
                if (!(node instanceof HTMLElement)) {
                  return [];
                }
                const dataset: Record<string, string> = {};
                for (const key in node.dataset) {
                  dataset[key] = node.dataset[key] ?? "";
                }
                return [{
                  tagName: node.tagName.toLowerCase(),
                  id: node.id,
                  dataset,
                }];
              }),
            };
          },
          { capture: true, once: true },
        );
        return true;
      }
    }
    return false;
  }, { args: [action, token, CLICK_TARGET_ATTR] });
}

async function clearTrustedActionMark(
  page: Page,
  token: string,
): Promise<void> {
  await page.evaluate((targetToken, targetAttr) => {
    function collect(
      root: Document | ShadowRoot,
      result: Element[],
    ): void {
      for (const element of root.querySelectorAll("*")) {
        if (element.getAttribute(targetAttr) === targetToken) {
          result.push(element);
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    const matches: Element[] = [];
    collect(document, matches);
    for (const element of matches) {
      element.removeAttribute(targetAttr);
    }
  }, { args: [token, CLICK_TARGET_ATTR] });
}

async function readTrustedActionProbe(
  page: Page,
  action: string,
): Promise<TrustedActionProbe> {
  return await page.evaluate((targetAction) => {
    function collect(
      root: Document | ShadowRoot,
      result: Element[],
    ): void {
      for (const element of root.querySelectorAll("*")) {
        if (element.getAttribute("data-ui-action") === targetAction) {
          result.push(element);
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    function isVisible(element: HTMLElement): boolean {
      const rect = element.getBoundingClientRect();
      const style = globalThis.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        rect.bottom >= 0 && rect.right >= 0 &&
        rect.top <= globalThis.innerHeight &&
        rect.left <= globalThis.innerWidth &&
        style.visibility !== "hidden" &&
        style.display !== "none";
    }

    function isDisabled(element: HTMLElement): boolean {
      return element.hasAttribute("disabled") ||
        element.getAttribute("aria-disabled") === "true";
    }

    const matches: Element[] = [];
    collect(document, matches);
    const lastClick = (globalThis as typeof globalThis & {
      __lastCfcTrustedActionClick?: TrustedActionProbe["lastClick"];
    }).__lastCfcTrustedActionClick;
    return {
      action: targetAction,
      ...(lastClick ? { lastClick } : {}),
      matches: matches.map((element) => {
        const target = element as HTMLElement;
        const clickTarget =
          (target.shadowRoot?.querySelector("[data-cf-button]") as
            | HTMLElement
            | null) ?? target;
        const rect = target.getBoundingClientRect();
        const clickRect = clickTarget.getBoundingClientRect();
        return {
          tagName: target.tagName.toLowerCase(),
          text: (target.textContent ?? "").trim().slice(0, 200),
          rect: {
            width: rect.width,
            height: rect.height,
            top: rect.top,
            left: rect.left,
          },
          disabled: isDisabled(target) || isDisabled(clickTarget),
          visible: isVisible(target) && isVisible(clickTarget),
          clickTarget: {
            tagName: clickTarget.tagName.toLowerCase(),
            text: (clickTarget.textContent ?? "").trim().slice(0, 200),
            rect: {
              width: clickRect.width,
              height: clickRect.height,
              top: clickRect.top,
              left: clickRect.left,
            },
            disabled: isDisabled(clickTarget),
            visible: isVisible(clickTarget),
          },
        };
      }),
      bodyText: (document.body?.innerText ?? "").slice(0, 1_000),
    };
  }, { args: [action] });
}

async function readTextProbe(
  page: Page,
  selector: string,
): Promise<TextProbe> {
  return await page.evaluate((targetSelector) => {
    function collect(
      root: Document | ShadowRoot,
      result: Element[],
    ): void {
      for (const element of root.querySelectorAll("*")) {
        try {
          if (element.matches(targetSelector)) {
            result.push(element);
          }
        } catch {
          // Invalid selectors are reported through the empty probe.
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    function isVisible(element: HTMLElement): boolean {
      const rect = element.getBoundingClientRect();
      const style = globalThis.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        rect.bottom >= 0 && rect.right >= 0 &&
        rect.top <= globalThis.innerHeight &&
        rect.left <= globalThis.innerWidth &&
        style.visibility !== "hidden" &&
        style.display !== "none";
    }

    function deepText(root: ParentNode): string {
      let content = "";
      if (root instanceof HTMLElement) {
        content = root.innerText ?? root.textContent ?? "";
      } else if (root instanceof ShadowRoot) {
        content = root.textContent ?? "";
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
          content += ` ${deepText(element.shadowRoot)}`;
        }
      }
      return content;
    }

    const matches: Element[] = [];
    collect(document, matches);
    return {
      selector: targetSelector,
      matches: matches.map((element) => {
        const target = element as HTMLElement;
        const rect = target.getBoundingClientRect();
        return {
          tagName: target.tagName.toLowerCase(),
          text: deepText(target).trim().slice(
            0,
            500,
          ),
          rect: {
            width: rect.width,
            height: rect.height,
            top: rect.top,
            left: rect.left,
          },
          visible: isVisible(target),
        };
      }),
      bodyText: (document.body?.innerText ?? "").slice(0, 1_000),
    };
  }, { args: [selector] });
}
