import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { env, waitForCondition } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";

import "../src/globals.ts";

const { FRONTEND_URL, SPACE_NAME } = env;
const ASYNC_FAILURE_MESSAGE = "The selected piece failed while it was starting";
const ASYNC_FAILURE_SOURCE = `
  import { computed, pattern, UI } from "commonfabric";

  export default pattern(() => {
    const failed = computed(() => {
      throw new Error("${ASYNC_FAILURE_MESSAGE}");
    });
    return { [UI]: <div>{failed}</div> };
  });
`;

describe("shell load errors", () => {
  const shell = new ShellIntegration({
    allowedConsoleErrors: [
      "[AppView] Failed to load space root pattern:",
      "[AppView] Failed to load selected piece:",
      ASYNC_FAILURE_MESSAGE,
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

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: identity.did() },
      identity,
    });
    await waitForCondition(page, () => {
      const root = document.querySelector("x-root-view");
      const appView = root?.shadowRoot?.querySelector("x-app-view") as
        | {
          rt?: {
            createPiece(
              space: string,
              source: string,
              options: { run: boolean },
            ): Promise<{ id(): string }>;
          };
        }
        | null;
      return !!appView?.rt;
    });
    const pieceId = await page.evaluate(async (space, source) => {
      const root = document.querySelector("x-root-view");
      const appView = root?.shadowRoot?.querySelector("x-app-view") as
        | {
          rt?: {
            createPiece(
              space: string,
              source: string,
              options: { run: boolean },
            ): Promise<{ id(): string }>;
          };
        }
        | null;
      if (!appView?.rt) throw new Error("Runtime was not ready");
      const piece = await appView.rt.createPiece(space, source, { run: false });
      return piece.id();
    }, { args: [identity.did(), ASYNC_FAILURE_SOURCE] });
    await page.evaluate(async (space, pieceId) => {
      await globalThis.app.setView({ spaceDid: space, pieceId });
    }, { args: [identity.did(), pieceId] });

    await waitForCondition(
      page,
      (probe, expectedMessage) =>
        probe.collect(".runtime-error").some((element) => {
          const text = probe.deepText(element).replace(/\s+/g, " ").trim();
          return text.includes("This piece encountered an error") &&
            text.includes(expectedMessage);
        }),
      { args: [ASYNC_FAILURE_MESSAGE] },
    );
  });
});
