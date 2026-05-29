import { env, Page } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  clickTrustedAction,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
const SHARED_PROFILE_TIMEOUT = 30_000;
const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

describe("shared profile integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let secondIdentity: Identity;
  let cc: PiecesController;
  let sharedSpaceDid: string;
  let pieceId: string;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    secondIdentity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });
    sharedSpaceDid = cc.manager().getSpace();

    const demoSource = await Deno.readTextFile(
      join(
        import.meta.dirname!,
        "..",
        "shared-profile-demo",
        "main.tsx",
      ),
    );
    const piece = await cc.create(
      `${demoSource}\n// integration instance ${crypto.randomUUID()}\n`,
      { start: true },
    );
    pieceId = piece.id;
    const resultCell = cc.manager().getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("uses each user's home profile when rendering a shared pattern", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: sharedSpaceDid as `did:${string}:${string}`, pieceId },
      identity,
    });
    await waitForText(page, "#shared-profile-name", "No profile");

    await submitProfileCreate(
      page,
      "cf-input",
      "Ada Lovelace",
    );
    await waitForText(page, "#shared-profile-name", "Ada Lovelace");
    await waitForSelector(page, "#shared-profile-wish-ui cf-cell-link");

    await shell.login(secondIdentity);
    await shell.waitForState({
      identity: secondIdentity,
      view: { spaceDid: sharedSpaceDid as `did:${string}:${string}`, pieceId },
    });
    await waitForText(page, "#shared-profile-name", "No profile");

    await submitProfileCreate(
      page,
      "cf-input",
      "Grace Hopper",
    );
    await waitForText(page, "#shared-profile-name", "Grace Hopper");
    await waitForSelector(page, "#shared-profile-wish-ui cf-cell-link");
  });
});

async function waitForSelector(page: Page, selector: string) {
  try {
    await page.waitForSelector(selector, {
      strategy: "pierce",
      timeout: SHARED_PROFILE_TIMEOUT,
    });
  } catch (cause) {
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "")
      .catch(() => "");
    const probe = await readProfileCreateProbe(page).catch(() => undefined);
    throw new Error(
      `Unable to find ${selector}. Body: ${bodyText.slice(0, 1000)} Probe: ${
        JSON.stringify(probe)
      }`,
      { cause },
    );
  }
}

async function submitProfileCreate(
  page: Page,
  inputSelector: string,
  message: string,
) {
  await fillAllProfileCreateInputs(page, inputSelector, message);
  await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
  await waitForRuntimeIdle(page);
}

async function fillAllProfileCreateInputs(
  page: Page,
  inputSelector: string,
  message: string,
) {
  try {
    await page.waitForSelector(inputSelector, {
      strategy: "pierce",
      timeout: SHARED_PROFILE_TIMEOUT,
    });
  } catch (cause) {
    const snapshot = await readProfileCreateProbe(page).catch(() => undefined);
    throw new Error(
      `Unable to find profile create input "${inputSelector}". Probe: ${
        JSON.stringify(snapshot)
      }`,
      { cause },
    );
  }
  const filled = await page.evaluate(
    async (selector, value): Promise<number> => {
      function collect(root: Document | ShadowRoot, result: Element[]): void {
        for (const element of root.querySelectorAll("*")) {
          try {
            if (element.matches(selector)) {
              result.push(element);
            }
          } catch {
            // Invalid selectors are reported through the zero filled count.
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
      let count = 0;
      for (const element of matches) {
        const host = element as HTMLElement & {
          value?: {
            set?: (value: string) => Promise<void>;
            sync?: () => Promise<unknown>;
          };
          requestUpdate?: () => void | Promise<void>;
        };
        const input = element instanceof HTMLInputElement
          ? element
          : element.shadowRoot?.querySelector("input");
        if (!(input instanceof HTMLInputElement) || !isVisible(input)) {
          continue;
        }
        input.focus();
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        if (valueSetter) {
          valueSetter.call(input, value);
        } else {
          input.value = value;
        }
        input.dispatchEvent(
          new Event("input", { bubbles: true, composed: true }),
        );
        input.dispatchEvent(
          new Event("change", { bubbles: true, composed: true }),
        );
        if (typeof host.value?.set === "function") {
          await host.value.set(value);
        }
        if (typeof host.value?.sync === "function") {
          await host.value.sync();
        }
        if (typeof host.requestUpdate === "function") {
          await host.requestUpdate();
        }
        input.blur();
        count++;
      }
      return count;
    },
    { args: [inputSelector, message] },
  );
  if (filled === 0) {
    throw new Error(`Profile create input not filled: ${inputSelector}`);
  }
}

async function readProfileCreateProbe(page: Page) {
  return await page.evaluate(() => {
    function collect(root: Document | ShadowRoot, result: Element[]): void {
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    function deepText(root: Document | ShadowRoot | Element): string {
      let text = root.textContent ?? "";
      const elements = "querySelectorAll" in root
        ? Array.from(root.querySelectorAll("*"))
        : [];
      for (const element of elements) {
        if (element.shadowRoot) {
          text += ` ${deepText(element.shadowRoot)}`;
        }
      }
      return text.replace(/\s+/g, " ").trim();
    }

    const elements: Element[] = [];
    collect(document, elements);
    return {
      text: deepText(document).slice(0, 2000),
      tags: elements
        .map((element) => element.tagName.toLowerCase())
        .filter((tag) =>
          tag.startsWith("cf-") || tag === "input" || tag === "button"
        )
        .slice(0, 200),
      renders: Array.from(elements)
        .filter((element) => element.tagName.toLowerCase() === "cf-render")
        .map((element) => {
          const render = element as HTMLElement & {
            cell?: {
              id?: () => string;
              get?: () => unknown;
              sync?: () => Promise<unknown>;
            };
          };
          let value: unknown;
          try {
            value = render.cell?.get?.();
          } catch (error) {
            value = error instanceof Error ? error.message : String(error);
          }
          return {
            id: render.cell?.id?.(),
            value: typeof value === "object" && value !== null
              ? Object.keys(value as Record<string, unknown>)
              : value,
            attrs: Array.from(element.attributes).map((attr) => [
              attr.name,
              attr.value,
            ]),
            text: deepText(element).slice(0, 500),
          };
        }),
      links: Array.from(elements)
        .filter((element) => element.tagName.toLowerCase() === "cf-cell-link")
        .map((element) => {
          const link = element as HTMLElement & {
            cell?: {
              id?: () => string;
              get?: () => unknown;
              key?: (path: string) => { get?: () => unknown };
            };
          };
          return {
            id: link.cell?.id?.(),
            name: link.cell?.key?.("name")?.get?.(),
            initialNameApplied: link.cell?.key?.("initialNameApplied")?.get?.(),
            keys: (() => {
              const value = link.cell?.get?.();
              return typeof value === "object" && value !== null
                ? Object.keys(value as Record<string, unknown>)
                : value;
            })(),
            text: deepText(element).slice(0, 500),
          };
        }),
      wishText: Array.from(elements)
        .filter((element) => element.id === "shared-profile-wish-ui")
        .map((element) => deepText(element).slice(0, 1000)),
    };
  });
}
