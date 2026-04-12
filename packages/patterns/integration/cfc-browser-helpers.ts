import { Page, waitFor } from "@commonfabric/integration";

export async function clickTrustedAction(page: Page, action: string) {
  await waitFor(async () => {
    try {
      const visible = await scrollTrustedActionIntoView(page, action);
      if (!visible) {
        return false;
      }
      const button = await page.waitForSelector(
        `[data-ui-action="${action}"]`,
        { strategy: "pierce" },
      );
      await button.click();
      return true;
    } catch {
      return false;
    }
  }, { timeout: 10_000 });
}

export async function waitForText(
  page: Page,
  selector: string,
  text: string,
) {
  await waitFor(async () => {
    try {
      const node = await page.waitForSelector(selector, {
        strategy: "pierce",
      });
      return (await node.innerText())?.includes(text) === true;
    } catch {
      return false;
    }
  }, { timeout: 10_000 });
}

export async function waitForTextAbsent(
  page: Page,
  selector: string,
  text: string,
) {
  await waitFor(async () => {
    try {
      const node = await page.waitForSelector(selector, {
        strategy: "pierce",
      });
      return (await node.innerText())?.includes(text) !== true;
    } catch {
      return false;
    }
  }, { timeout: 10_000 });
}

async function scrollTrustedActionIntoView(
  page: Page,
  action: string,
): Promise<boolean> {
  return await page.evaluate((targetAction) => {
    function collect(
      root: Document | ShadowRoot,
      result: Element[],
      action: string,
    ): void {
      for (const element of root.querySelectorAll("*")) {
        if (element.getAttribute("data-ui-action") === action) {
          result.push(element);
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result, action);
        }
      }
    }

    const matches: Element[] = [];
    collect(document, matches, targetAction);
    const target = matches[0] as HTMLElement | undefined;
    if (!target) {
      return false;
    }
    target.scrollIntoView({ block: "center", inline: "center" });
    const rect = target.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      rect.bottom >= 0 && rect.right >= 0 &&
      rect.top <= globalThis.innerHeight &&
      rect.left <= globalThis.innerWidth;
  }, { args: [action] });
}
