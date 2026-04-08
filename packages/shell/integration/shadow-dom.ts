import { waitFor } from "@commonfabric/integration";
import type { Page } from "@commonfabric/integration";

export function pierce(page: Page, selector: string, timeout?: number) {
  return page.waitForSelector(selector, {
    strategy: "pierce",
    ...(timeout != null ? { timeout } : {}),
  });
}

export async function clickPierce(
  page: Page,
  selector: string,
): Promise<void> {
  await waitFor(async () => {
    return await page.evaluate((targetSelector: string) => {
      function findClickableHost(
        root: Document | ShadowRoot,
        selector: string,
      ): HTMLElement | null {
        const matches: HTMLElement[] = [];

        for (const match of root.querySelectorAll(selector)) {
          if (match instanceof HTMLElement && isVisible(match)) {
            matches.push(match);
          }
        }

        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) {
            const nested = findClickableHost(el.shadowRoot, selector);
            if (nested) {
              matches.push(nested);
            }
          }
        }

        return matches.at(-1) ?? null;
      }

      function isVisible(el: HTMLElement): boolean {
        const rect = el.getBoundingClientRect();
        const style = globalThis.getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      }

      const host = findClickableHost(document, targetSelector);
      if (!host) {
        return false;
      }

      const button = host.shadowRoot?.querySelector("button");
      if (button instanceof HTMLButtonElement) {
        if (button.disabled || !isVisible(button)) {
          return false;
        }
        button.click();
        return true;
      }

      if (!isVisible(host)) {
        return false;
      }

      host.click();
      return true;
    }, { args: [selector] });
  });
}
