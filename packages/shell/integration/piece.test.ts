import { env, waitFor } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import "../src/globals.ts";
import { Identity } from "@commonfabric/identity";
import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";

const { API_URL, SPACE_NAME, FRONTEND_URL } = env;

describe("shell piece tests", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let pieceId: string;
  let piece: PieceController;
  let identity: Identity;
  let cc: PiecesController;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "..",
      "patterns",
      "counter",
      "counter.tsx",
    );
    const program = await cc.manager().runtime.harness
      .resolve(
        new FileSystemProgramResolver(sourcePath),
      );
    piece = await cc.create(
      program,
      { start: true },
    );
    pieceId = piece.id;

    const resultCell = cc.manager().getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});

    await waitFor(async () => (await piece.result.get(["value"])) === 0);
    await waitFor(async () => {
      const reloadedPiece = await cc.get(pieceId, true);
      return (await reloadedPiece.result.get(["value"])) === 0;
    });
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    if (cc) await cc.dispose();
  });

  it("can view and interact with a piece", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
      },
      identity,
    });

    const logDebugSnapshot = async (label: string) => {
      console.log(label, {
        shellState: await shell.state(),
        pieceValue: await piece.result.get(["value"]),
        page: await page.evaluate(() => {
          const rootView = document.querySelector("x-root-view");
          const typedRootView = rootView as
            | {
              _rt?: {
                status?: unknown;
                value?: unknown;
                error?: {
                  message?: string;
                };
              };
              app?: {
                identity?: unknown;
              };
            }
            | null;
          const appView = rootView?.shadowRoot?.querySelector("x-app-view") as
            | {
              _patterns?: {
                status?: unknown;
                value?: {
                  activePattern?: {
                    id(): string;
                  };
                };
              };
              _selectedPattern?: {
                status?: unknown;
                value?: {
                  id(): string;
                };
              };
              _spaceRootPattern?: {
                status?: unknown;
                value?: {
                  id(): string;
                };
              };
              _patternError?: {
                message?: string;
              };
            }
            | null;
          return {
            href: globalThis.location.href,
            hasRuntime: !!globalThis.commonfabric?.rt,
            hasRootView: !!rootView,
            rootRuntimeStatus: typedRootView?._rt?.status,
            hasRootRuntimeValue: !!typedRootView?._rt?.value,
            rootRuntimeError: typedRootView?._rt?.error?.message,
            rootHasIdentity: !!typedRootView?.app?.identity,
            hasAppView: !!appView,
            patternsStatus: appView?._patterns?.status,
            selectedPatternStatus: appView?._selectedPattern?.status,
            spaceRootPatternStatus: appView?._spaceRootPattern?.status,
            activePatternId: appView?._patterns?.value?.activePattern?.id?.(),
            selectedPatternId: appView?._selectedPattern?.value?.id?.(),
            spaceRootPatternId: appView?._spaceRootPattern?.value?.id?.(),
            patternError: appView?._patternError?.message,
            bodyText: document.body.textContent?.trim().slice(0, 200),
          };
        }),
      });
    };

    try {
      await waitFor(async () => {
        return await page.evaluate(() => !!globalThis.commonfabric?.rt);
      });
    } catch (error) {
      await logDebugSnapshot("shell piece runtime debug");
      throw error;
    }

    await page.evaluate(async (spaceName, pieceId) => {
      await globalThis.app.setView({ spaceName, pieceId });
    }, { args: [SPACE_NAME, pieceId] });
    await shell.waitForState({
      view: {
        spaceName: SPACE_NAME,
        pieceId,
      },
      identity,
    });

    const waitForActivePattern = async () => {
      await waitFor(async () => {
        return await page.evaluate((expectedPieceId) => {
          const rootView = document.querySelector("x-root-view");
          const appView = rootView?.shadowRoot?.querySelector("x-app-view") as
            | {
              _patterns?: {
                value?: {
                  activePattern?: {
                    id(): string;
                  };
                };
              };
            }
            | null;
          const activePattern = appView?._patterns?.value?.activePattern;
          return activePattern?.id() === expectedPieceId;
        }, { args: [pieceId] });
      });
    };

    try {
      await waitForActivePattern();
    } catch (error) {
      await logDebugSnapshot("shell piece test debug");
      throw error;
    }
    await waitFor(async () => (await piece.result.get(["value"])) === 0);

    await clickPieceButton(page, "#counter-decrement");
    try {
      await waitFor(async () => (await piece.result.get(["value"])) === -1);
    } catch (error) {
      await logDebugSnapshot("shell piece decrement debug");
      throw error;
    }

    await clickPieceButton(page, "#counter-decrement");
    try {
      await waitFor(async () => (await piece.result.get(["value"])) === -2);
    } catch (error) {
      await logDebugSnapshot("shell piece decrement debug");
      throw error;
    }
  });
});

function clickPieceButton(
  page: ReturnType<ShellIntegration["page"]>,
  selector: string,
) {
  return waitFor(async () => {
    try {
      const button = await page.waitForSelector(selector, {
        strategy: "pierce",
      });
      await button.click();
      return true;
    } catch (_) {
      return false;
    }
  });
}
