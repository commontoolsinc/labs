import { env, waitForCondition } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { Identity } from "@commonfabric/identity";
import { NotificationType } from "@commonfabric/runtime-client";
import { describe, it } from "@std/testing/bdd";
import "../src/globals.ts";

const { FRONTEND_URL, SPACE_NAME } = env;

describe("shell load errors", () => {
  const shell = new ShellIntegration({
    allowedConsoleErrors: [
      "[AppView] Failed to load space root pattern:",
      "[AppView] Failed to load selected piece:",
      "[RuntimeClient Error]",
    ],
  });
  shell.bindLifecycle();

  it("shows an informative alert when a space cannot be loaded", async () => {
    const page = shell.page();
    const identity = await Identity.generate({ implementation: "noble" });

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: identity.did() },
      identity,
    });
    await page.evaluate(async () => {
      const root = document.querySelector("x-root-view");
      const appView = root?.shadowRoot?.querySelector("x-app-view") as
        | {
          rt?: {
            getSpaceRootPattern: (...args: unknown[]) => Promise<unknown>;
          };
          _spaceRootPattern?: {
            run(): void;
            taskComplete: Promise<unknown>;
          };
        }
        | null;
      const runtime = appView?.rt;
      const task = appView?._spaceRootPattern;
      if (!runtime || !task) throw new Error("App view was not ready");

      const getSpaceRootPattern = runtime.getSpaceRootPattern;
      runtime.getSpaceRootPattern = () =>
        Promise.reject(new Error("Space storage is unavailable"));
      try {
        task.run();
        await task.taskComplete;
      } catch {
        // The task's error state is the condition this test renders.
      } finally {
        runtime.getSpaceRootPattern = getSpaceRootPattern;
      }
    });

    await waitForCondition(
      page,
      (probe) =>
        probe.collect(".load-error").some((element) => {
          const text = probe.deepText(element).replace(/\s+/g, " ").trim();
          return text.includes("We could not load this space") &&
            text.includes("Space storage is unavailable");
        }),
    );
    await waitForCondition(
      page,
      (probe) => probe.collect('[role="alert"]').length === 1,
    );
  });

  it("shows an informative alert when a piece cannot be loaded", async () => {
    const page = shell.page();
    const identity = await Identity.generate({ implementation: "noble" });

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: "fid1:missing:piece",
      },
      identity,
    });

    await waitForCondition(
      page,
      (probe) =>
        probe.collect(".load-error").some((element) => {
          const text = probe.deepText(element).replace(/\s+/g, " ").trim();
          return text.includes("We could not load this piece") &&
            text.includes("Error details");
        }),
    );
    await waitForCondition(
      page,
      (probe) => probe.collect('[role="alert"]').length === 1,
    );
    await waitForCondition(
      page,
      (probe) =>
        probe.collect(".load-error-details code").some((element) =>
          probe.deepText(element).trim().length > 0
        ),
    );
  });

  it("shows an asynchronous runtime failure for the selected piece", async () => {
    const page = shell.page();
    const identity = await Identity.generate({ implementation: "noble" });
    const pieceId = "fid1:UagUTyzWNqugXzSpu3JH4Sso9lF_tmGQgwtdIL87mZs";

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: identity.did(), pieceId },
      identity,
    });
    await page.evaluate((type, pieceId, space) => {
      const root = document.querySelector("x-root-view") as
        | {
          _handleRuntimeError?: (event: {
            type: string;
            message: string;
            pieceId: string;
            space: string;
          }) => void;
        }
        | null;
      if (!root?._handleRuntimeError) {
        throw new Error("Root view was not ready");
      }
      root._handleRuntimeError({
        type,
        message: "The selected piece failed while it was starting",
        pieceId: `of:${pieceId}`,
        space,
      });
    }, {
      args: [NotificationType.ErrorReport, pieceId, identity.did()],
    });

    await waitForCondition(
      page,
      (probe) =>
        probe.collect(".runtime-error").some((element) => {
          const text = probe.deepText(element).replace(/\s+/g, " ").trim();
          return text.includes("This piece encountered an error") &&
            text.includes("The selected piece failed while it was starting");
        }),
    );
  });
});
