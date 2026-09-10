import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { env, waitForCondition } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";

import "../src/globals.ts";

import { clickPierce } from "./shadow-dom.ts";

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

  it("opens the space's menu over the surface a piece failed to load into", async () => {
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
        probe.collect(".load-error").some((element) =>
          probe.deepText(element).includes("We could not load this piece")
        ),
    );

    // The click lands at the foot of the viewport, four pixels above the
    // bottom edge, which is also the margin the menu keeps from that edge. So
    // a menu placed from its own measured height comes to rest with its bottom
    // exactly on that margin, however tall the space heading makes it, and its
    // left edge still at the click.
    const space = await page.evaluate(() => {
      const rootView = document.querySelector("x-root-view");
      const appView = rootView?.shadowRoot?.querySelector("x-app-view") as
        | (Element & { space?: string })
        | null;
      const surface = appView?.shadowRoot?.querySelector("x-body-view")
        ?.shadowRoot?.querySelector(".load-error");
      if (!appView?.space) throw new Error("the app view names no space");
      if (!surface) throw new Error("no load-error surface to right-click");
      surface.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          composed: true,
          cancelable: true,
          clientX: 40,
          clientY: globalThis.innerHeight - 4,
        }),
      );
      return appView.space;
    });

    const menu = await waitForCondition(page, (probe, heading: string) => {
      const root = document.querySelector("cf-piece-menu")?.shadowRoot;
      const element = root?.querySelector(".menu");
      if (!element || !probe.isRendered(element)) return false;
      const text = probe.deepText(element).replace(/\s+/g, " ").trim();
      if (!text.includes(heading)) return false;
      const entries: Record<string, boolean> = {};
      for (const button of root!.querySelectorAll("button[test-id]")) {
        entries[button.getAttribute("test-id")!] =
          (button as HTMLButtonElement).disabled;
      }
      const box = element.getBoundingClientRect();
      return {
        piece: text.startsWith("Piece unavailable"),
        entries,
        left: Math.round(box.left),
        gap: Math.round(globalThis.innerHeight - box.bottom),
      };
    }, { args: [`Space ${space}`] });

    expect(menu).toEqual({
      piece: true,
      entries: {
        "piece-menu-source": true,
        "piece-menu-origin": true,
        "piece-menu-data": true,
        "piece-menu-actions": true,
        "piece-menu-clone-fresh": true,
        "piece-menu-clone-copy-data": true,
        "piece-menu-space-access": false,
      },
      left: 40,
      gap: 4,
    });

    // The rights the panel shows were read through the space and the runtime
    // the menu was handed, there being no piece to read them through. The
    // panel names that space in its subject line, and lists the wildcard entry
    // every space carries. Which capability this identity holds is not
    // asserted: the tests share one space, and the first to reach it owns it.
    await clickPierce(page, '[test-id="piece-menu-space-access"]');
    await waitForCondition(
      page,
      (probe, subject: string) =>
        probe.collect('[test-id="piece-panel-access"]').some((panel) => {
          const text = probe.deepText(panel).replace(/\s+/g, " ");
          return text.includes(`Space access rights ${subject}`) &&
            text.includes("Anyone (*)");
        }),
      { args: [space] },
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
