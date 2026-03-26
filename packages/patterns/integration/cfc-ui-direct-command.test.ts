import { env, Page, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { PieceController, PiecesController } from "@commontools/piece/ops";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-compiler";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

const INITIAL_DRAFT = "Summarize the latest inbox triage notes.";

describe("CFC UI direct-command integration", () => {
  const shell = new ShellIntegration({ pipeConsole: false });
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;
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
      "examples",
      "cfc-ui-direct-command.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath, rootPath),
    );

    piece = await cc.create(program, { start: true });

    const resultCell = cc.manager().getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});

    await piece.input.set(INITIAL_DRAFT, ["draft"]);
    await piece.input.set(0, ["submittedCount"]);
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    if (cc) await cc.dispose();
  });

  it("blocks untrusted UI clicks and allows trusted UI clicks", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

    await waitForSelector(
      page,
      '[data-ui-action="SubmitDirectCommand"]',
    );
    await waitForSelector(
      page,
      '[data-ui-action="SubmitDirectCommandUntrusted"]',
    );
    await waitForTextAtSelector(
      page,
      "#direct-command-count",
      "Submitted commands: 0",
    );

    await waitFor(async () => {
      return (
        await piece.result.get(["submittedCount"]) === 0 &&
        await piece.result.get(["draft"]) === INITIAL_DRAFT
      );
    });

    await dispatchCtButtonHostClick(page, "SubmitDirectCommandUntrusted");

    await waitFor(async () => {
      return (
        await piece.result.get(["submittedCount"]) === 0 &&
        await piece.result.get(["draft"]) === INITIAL_DRAFT
      );
    });
    await waitForTextAtSelector(
      page,
      "#direct-command-count",
      "Submitted commands: 0",
    );
    await waitFor(() =>
      Promise.resolve(
        shell.errorLogs().some((entry) =>
          entry.includes("CfcEventIntegrityViolationError") &&
          entry.includes("SubmitDirectCommand")
        ),
      )
    );

    shell.clearErrorLogs();

    await dispatchCtButtonHostClick(page, "SubmitDirectCommand");

    await waitFor(async () => {
      return (
        await piece.result.get(["submittedCount"]) === 1 &&
        await piece.result.get(["draft"]) === ""
      );
    });
    await waitForTextAtSelector(
      page,
      "#direct-command-count",
      "Submitted commands: 1",
    );

    assertEquals(await piece.result.get(["submittedCount"]), 1);
    assertEquals(await piece.result.get(["draft"]), "");
    assertEquals(shell.errorLogs(), []);
  });
});

async function waitForSelector(page: Page, selector: string): Promise<void> {
  await waitFor(async () => {
    try {
      return !!(await page.waitForSelector(selector, { strategy: "pierce" }));
    } catch {
      return false;
    }
  });
}

async function dispatchCtButtonHostClick(
  page: Page,
  action: string,
): Promise<void> {
  await waitFor(async () => {
    try {
      return await page.evaluate(
        (actionName) => {
          const vdomDebug = (globalThis as typeof globalThis & {
            commontools?: { vdom?: { registry?: Map<unknown, unknown> } };
          }).commontools?.vdom;
          const entry = vdomDebug?.registry?.values?.().next?.().value as
            | {
              renderer?: {
                getApplicator?: () => {
                  nodes?: Map<number, Node>;
                };
              };
            }
            | undefined;
          const applicator = entry?.renderer?.getApplicator?.();
          const host = applicator?.nodes
            ? [...applicator.nodes.values()].find((node) =>
              node instanceof HTMLElement &&
              node.getAttribute("data-ui-action") === actionName
            ) as HTMLElement | undefined
            : undefined;
          if (!host) return false;
          return host.dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              composed: true,
            }),
          );
        },
        { args: [action] },
      );
    } catch {
      return false;
    }
  });
}

async function waitForTextAtSelector(
  page: Page,
  selector: string,
  expectedText: string,
): Promise<void> {
  await waitFor(async () => {
    try {
      const element = await page.waitForSelector(selector, {
        strategy: "pierce",
      });
      const text = await element.innerText();
      return text?.trim() === expectedText;
    } catch {
      return false;
    }
  });
}
