import { Page, waitFor } from "@commonfabric/integration";

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
    throw new Error(
      `Timed out clicking trusted action "${action}". Last probe: ${
        JSON.stringify(probe, null, 2)
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
        JSON.stringify({ actionProbe, textProbe }, null, 2)
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
        JSON.stringify(probe, null, 2)
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
        JSON.stringify(probe, null, 2)
      }`,
      { cause },
    );
  }
}

async function textIsPresent(
  page: Page,
  selector: string,
  text: string,
): Promise<boolean> {
  try {
    const node = await page.waitForSelector(selector, {
      strategy: "pierce",
      timeout: 500,
    });
    return (await node.innerText())?.includes(text) === true;
  } catch {
    return false;
  }
}

type TrustedActionProbe = {
  action: string;
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
    return {
      action: targetAction,
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

    const matches: Element[] = [];
    collect(document, matches);
    return {
      selector: targetSelector,
      matches: matches.map((element) => {
        const target = element as HTMLElement;
        const rect = target.getBoundingClientRect();
        return {
          tagName: target.tagName.toLowerCase(),
          text: (target.innerText ?? target.textContent ?? "").trim().slice(
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
