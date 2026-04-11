import { env, Page, waitFor } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { PiecesController } from "@commonfabric/piece/ops";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("cfc render policy demo integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: Awaited<ReturnType<PiecesController["create"]>>;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });

    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "cfc-render-policy-demo",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath, rootPath),
    );
    piece = await cc.create(program, { start: true });

    const resultCell = cc.manager().getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("blocks raw confidential content and reveals it through the trusted surface", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

    await waitForText(page, "#raw-health-attempt", "Content hidden by policy");
    await waitForText(
      page,
      "#trusted-health-surface",
      "Content hidden by policy",
    );
    await waitForTextAbsent(
      page,
      "#raw-health-attempt",
      "Sensitive health data:",
    );

    await clickTrustedAction(page, "TrustedRevealHealthData");
    await waitForText(page, "#reveal-state", "Reveal enabled");
    await waitForText(
      page,
      "#trusted-health-visible",
      "Sensitive health data: migraine treatment plan",
    );
    await waitForTextAbsent(
      page,
      "#raw-health-attempt",
      "Sensitive health data:",
    );
  });
});

async function clickTrustedAction(page: Page, action: string) {
  const button = await page.waitForSelector(`[data-ui-action="${action}"]`, {
    strategy: "pierce",
  });
  await button.click();
}

async function waitForText(page: Page, selector: string, text: string) {
  let probe: TextProbe | undefined;
  try {
    await waitFor(async () => {
      try {
        const node = await page.waitForSelector(selector, {
          strategy: "pierce",
        });
        const innerText = await node.innerText();
        probe = { selector, innerText, pageText: undefined };
        if (innerText?.includes(text) === true) {
          return true;
        }
        probe = await readTextProbe(page, selector);
        return false;
      } catch {
        probe = await readTextProbe(page, selector);
        return false;
      }
    }, { timeout: 10_000 });
  } catch (cause) {
    throw new Error(
      `Timed out waiting for ${selector} to contain ${JSON.stringify(text)}. ${
        JSON.stringify(probe, null, 2)
      }`,
      { cause },
    );
  }
}

async function waitForTextAbsent(page: Page, selector: string, text: string) {
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

type TextProbe = {
  selector: string;
  innerText: string | undefined;
  pageText: string | undefined;
  boundaries?: Array<{
    text: string;
    attributes: Record<string, string>;
    hasValue: boolean;
    valueConstructor: string | undefined;
    ref: unknown;
  }>;
};

async function readTextProbe(
  page: Page,
  selector: string,
): Promise<TextProbe> {
  return await page.evaluate((targetSelector) => {
    function collect(
      root: Document | ShadowRoot,
      result: Element[],
      selector: string,
    ): void {
      for (const element of root.querySelectorAll("*")) {
        if (element.matches(selector)) {
          result.push(element);
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result, selector);
        }
      }
    }

    const matches: Element[] = [];
    collect(document, matches, targetSelector);
    const boundaryElements: Element[] = [];
    collect(document, boundaryElements, "cf-cfc-render-boundary");
    const boundaries = boundaryElements.map((element) => {
      const value = (element as unknown as { value?: unknown }).value;
      const ref = typeof (value as { ref?: unknown } | undefined)?.ref ===
          "function"
        ? (value as { ref(): unknown }).ref()
        : undefined;
      return {
        text: (element as HTMLElement).innerText,
        attributes: Object.fromEntries(
          Array.from(element.attributes).map((attr) => [attr.name, attr.value]),
        ),
        hasValue: value !== undefined,
        valueConstructor: value && typeof value === "object"
          ? value.constructor?.name
          : undefined,
        ref,
      };
    });
    return {
      selector: targetSelector,
      innerText: (matches[0] as HTMLElement | undefined)?.innerText,
      pageText: document.body?.innerText,
      boundaries,
    };
  }, { args: [selector] });
}
