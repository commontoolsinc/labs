import { env, Page, waitFor } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { PiecesController } from "@commonfabric/piece/ops";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { clickTrustedAction, waitForText } from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("cfc spec gallery integration test", () => {
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
      "cfc-spec-gallery",
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

  it("drives the trusted forward, command, and safe-link surfaces", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

    await clickTrustedAction(page, "TrustedPrepareForward");
    await waitForText(page, "#trusted-forward-prepared", "Prepared for");
    await waitForText(page, "#forward-stage", "prepared");
    await clickTrustedAction(page, "TrustedForwardNote");
    await waitForText(
      page,
      "#trusted-forward-result",
      "Only the bounded itinerary excerpt will be forwarded.",
    );
    await waitForText(page, "#forward-stage", "forwarded");

    await clickTrustedAction(page, "TrustedCaptureDirectCommand");
    await waitForText(page, "#research-stage", "captured");
    await clickTrustedAction(page, "TrustedPrepareResearchBrief");
    await waitForText(page, "#trusted-command-prepared", "Prepared outbound");
    await waitForText(page, "#research-stage", "prepared");
    await clickTrustedAction(page, "TrustedAuthorizeResearchSend");
    await waitForText(
      page,
      "#trusted-command-result",
      "Authorized outbound message",
    );
    await waitForText(page, "#research-stage", "sent");

    await clickTrustedAction(page, "TrustedPrepareSafeLink");
    await waitForText(page, "#trusted-safe-link-prepared", "?view=summary");
    await waitForText(page, "#safe-link-stage", "prepared");
    await clickTrustedAction(page, "TrustedReleaseSafeLink");
    await waitForText(
      page,
      "#trusted-safe-link-result",
      "?view=summary",
    );
    await waitForText(page, "#safe-link-stage", "released");
  });

  it("renders disclaimer-style labels without a trusted click", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

    await waitForCfcLabelText(page, [
      "prompt-influence",
      "source-provenance",
      "fact-check-required",
    ]);
  });
});

async function waitForCfcLabelText(page: Page, expected: string[]) {
  let probe: CfcLabelProbe | undefined;
  try {
    await waitFor(async () => {
      probe = await readCfcLabelProbe(page);
      const labels = probe.labels;

      return expected.every((label) =>
        labels.some((rendered) => rendered.includes(label))
      );
    }, { timeout: 15_000 });
  } catch (cause) {
    throw new Error(
      `Timed out waiting for CFC labels. Last probe: ${
        JSON.stringify(probe, null, 2)
      }`,
      { cause },
    );
  }
}

type CfcLabelProbe = {
  registered: boolean;
  labels: string[];
  hosts: Array<{
    surface: string | null;
    lightText: string;
    shadowText: string;
    hasValue: boolean;
    hasGetCfcLabel: boolean;
    valueConstructor: string | undefined;
    ref: unknown;
    cfcLabel: unknown;
  }>;
};

async function readCfcLabelProbe(page: Page): Promise<CfcLabelProbe> {
  return await page.evaluate(async () => {
    function collect(root: Document | ShadowRoot, result: Element[]): void {
      for (const element of root.querySelectorAll("*")) {
        if (element.tagName.toLowerCase() === "cf-cfc-label") {
          result.push(element);
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    const elements: Element[] = [];
    collect(document, elements);
    const hosts = await Promise.all(elements.map(async (element) => {
      const value = (element as unknown as { value?: unknown }).value;
      const ref = typeof (value as { ref?: unknown } | undefined)?.ref ===
          "function"
        ? (value as { ref(): unknown }).ref()
        : undefined;
      const cfcLabel = typeof (
          value as { getCfcLabel?: unknown } | undefined
        )?.getCfcLabel === "function"
        ? await (value as { getCfcLabel(): Promise<unknown> }).getCfcLabel()
          .catch((error) => String(error))
        : undefined;
      return {
        surface: element.getAttribute("data-cfc-label-surface"),
        lightText: element.textContent ?? "",
        shadowText: element.shadowRoot?.textContent ?? "",
        hasValue: value !== undefined,
        hasGetCfcLabel: typeof (
          value as { getCfcLabel?: unknown } | undefined
        )?.getCfcLabel === "function",
        valueConstructor: value && typeof value === "object"
          ? value.constructor?.name
          : undefined,
        ref,
        cfcLabel,
      };
    }));

    return {
      registered: customElements.get("cf-cfc-label") !== undefined,
      labels: hosts.map((host) => host.shadowText || host.lightText),
      hosts,
    };
  });
}
