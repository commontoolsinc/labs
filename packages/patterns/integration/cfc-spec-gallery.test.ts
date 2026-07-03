import { env, Page, waitForCondition } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickTrustedActionAndWaitForText,
  waitForText,
} from "./cfc-browser-helpers.ts";

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
    cc = await initializePiecesController({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });

    // Pre-create the space-root (default) pattern so the browser's
    // `pattern:getSpaceRoot` storage-RESUMEs it instead of taking the create
    // path and cold-compiling default-app inside its worker — see the
    // beforeAll comment in lunch-poll-vote.test.ts.
    await cc.ensureDefaultPattern();

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

    await clickTrustedActionAndWaitForText(
      page,
      "TrustedPrepareForward",
      "#trusted-forward-prepared",
      "Prepared for",
    );
    await waitForText(page, "#forward-stage", "prepared");
    await clickTrustedActionAndWaitForText(
      page,
      "TrustedForwardNote",
      "#trusted-forward-result",
      "Only the bounded itinerary excerpt will be forwarded.",
    );
    await waitForText(page, "#forward-stage", "forwarded");

    await clickTrustedActionAndWaitForText(
      page,
      "TrustedCaptureDirectCommand",
      "#research-stage",
      "captured",
    );
    await waitForText(page, "#research-stage", "captured");
    await clickTrustedActionAndWaitForText(
      page,
      "TrustedPrepareResearchBrief",
      "#trusted-command-prepared",
      "Prepared outbound",
    );
    await waitForText(page, "#research-stage", "prepared");
    await clickTrustedActionAndWaitForText(
      page,
      "TrustedAuthorizeResearchSend",
      "#trusted-command-result",
      "Authorized outbound message",
    );
    await waitForText(page, "#research-stage", "sent");

    await clickTrustedActionAndWaitForText(
      page,
      "TrustedPrepareSafeLink",
      "#trusted-safe-link-prepared",
      "?view=summary",
    );
    await waitForText(page, "#safe-link-stage", "prepared");
    await clickTrustedActionAndWaitForText(
      page,
      "TrustedReleaseSafeLink",
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
      "SourceProvenance",
      "fact-check-required",
    ]);
  });
});

async function waitForCfcLabelText(page: Page, expected: string[]) {
  try {
    await waitForCondition(page, (probe, expected) => {
      const labels = probe.collect("cf-cfc-label").map((element) => {
        const shadowText = element.shadowRoot?.textContent ?? "";
        const lightText = element.textContent ?? "";
        return shadowText || lightText;
      });

      return expected.every((label) =>
        labels.some((rendered) => rendered.includes(label))
      );
    }, { args: [expected] });
  } catch (cause) {
    const probe = await readCfcLabelProbe(page);
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
      const value = (element as Element & { value?: unknown }).value;
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
