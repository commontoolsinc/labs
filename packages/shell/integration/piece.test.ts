import { env, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import "../src/globals.ts";
import { Identity } from "@commontools/identity";
import { PieceController, PiecesController } from "@commontools/piece/ops";
import { FileSystemProgramResolver } from "@commontools/js-compiler";

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
        pieceId,
      },
      identity,
    });

    const waitForPieceValue = async (expected: number) => {
      await waitFor(async () => {
        return await page.evaluate(async (expected, expectedPieceId) => {
          const rootView = document.querySelector("x-root-view");
          const appView = rootView?.shadowRoot?.querySelector("x-app-view") as
            | {
              _patterns?: {
                value?: {
                  activePattern?: {
                    id(): string;
                    cell(): {
                      key(name: string): {
                        sync(): Promise<unknown>;
                        get(): unknown;
                      };
                    };
                  };
                };
              };
            }
            | null;
          const activePattern = appView?._patterns?.value?.activePattern;
          if (!activePattern || activePattern.id() !== expectedPieceId) {
            return false;
          }

          const valueCell = activePattern.cell().key("value");
          await valueCell.sync();
          return valueCell.get() === expected;
        }, { args: [expected, pieceId] });
      });
    };

    const clickDecrement = async () => {
      await waitFor(async () => {
        return await page.evaluate(async (expectedPieceId) => {
          const rootView = document.querySelector("x-root-view");
          const appView = rootView?.shadowRoot?.querySelector("x-app-view") as
            | {
              _patterns?: {
                value?: {
                  activePattern?: {
                    id(): string;
                    cell(): {
                      key(name: string): {
                        send(value: unknown): Promise<void>;
                      };
                    };
                  };
                };
              };
            }
            | null;
          const activePattern = appView?._patterns?.value?.activePattern;
          if (!activePattern || activePattern.id() !== expectedPieceId) {
            return false;
          }
          await activePattern.cell().key("decrement").send(undefined);
          return true;
        }, { args: [pieceId] });
      });
    };

    await waitForPieceValue(0);

    await clickDecrement();
    await waitForPieceValue(-1);

    await clickDecrement();
    await waitForPieceValue(-2);
  });
});
