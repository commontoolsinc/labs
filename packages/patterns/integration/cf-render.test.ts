import {
  env,
  Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";
import { clickNthCfButton, waitForText } from "./cfc-browser-helpers.ts";
import { defer, type Deferred } from "@commonfabric/utils/defer";
import { toIndentedDebugString } from "@commonfabric/data-model/value-debug";

/** The text of every rendered `#counter-result`, for failure reporting. */
function readCounterTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    function collect(root: Document | ShadowRoot, out: Element[]): void {
      for (const element of root.querySelectorAll("*")) {
        if (element.matches("#counter-result")) out.push(element);
        if (element.shadowRoot) collect(element.shadowRoot, out);
      }
    }
    const matches: Element[] = [];
    collect(document, matches);
    return matches.map((element) => (element.textContent ?? "").trim());
  });
}

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("cf-render integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;
  let pieceSinkCancel: (() => void) | undefined;
  // The piece's committed result value, tracked by the result-cell sink below,
  // and a one-shot waiter the sink resolves when the value reaches a target.
  let latestResultValue: number | undefined;
  let resultWaiter: { target: number; deferred: Deferred } | undefined;

  // Resolve once the piece's committed result value equals `target`. The sink
  // fires with the current value on registration and on every committed change,
  // so a value already at the target resolves immediately; otherwise the sink
  // resolves the waiter when the target lands.
  const awaitResultValue = (target: number): Promise<void> => {
    if (latestResultValue === target) return Promise.resolve();
    const deferred = defer();
    resultWaiter = { target, deferred };
    return deferred.promise;
  };

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    piece = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "examples",
          "cf-render.tsx",
        ),
      ),
      // We operate on the piece in this thread
      { start: true },
    );

    // In pull mode, create a sink to keep the piece reactive when inputs
    // change. The sink also drives awaitResultValue: it records the latest
    // committed value and resolves a pending waiter when its target is
    // reached.
    const resultCell = cc.manager().getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink((value) => {
      latestResultValue = (value as { value?: number } | undefined)?.value;
      if (resultWaiter && latestResultValue === resultWaiter.target) {
        resultWaiter.deferred.resolve();
        resultWaiter = undefined;
      }
    });
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    if (cc) await cc.dispose();
  });

  it("should load the nested counter piece and verify initial state", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

    await waitForText(page, "#counter-result", "Counter is the 0th number");

    // Verify via direct operations that the cf-render structure works
    assertEquals(await piece.result.get(["value"]), 0);
  });

  it("should click the increment button and update the counter", async () => {
    const page = shell.page();

    // Click increment button (second button - first is decrement)
    await clickNthCfButton(page, "[data-cf-button]", 1);

    // Wait for the piece result to reflect the increment.
    await awaitResultValue(1);
    assertEquals(await piece.result.get(["value"]), 1);
  });

  it("should update counter value via direct operations and verify UI", async () => {
    const page = shell.page();

    await piece.result.set(5, ["value"]);

    // Verify we can read the value back via operations
    assertEquals(
      await piece.result.get(["value"]),
      5,
      "Value should be 5 in backend",
    );

    // Navigate to the piece to see if UI reflects the change
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

    await waitForText(page, "#counter-result", "Counter is the 5th number");
  });

  it("should verify exactly THREE counters display", async () => {
    const page = shell.page();

    // The piece renders one counter through cf-render and two others; all
    // three must be present, and the first must show the updated value.
    const expected = "Counter is the 5th number";
    try {
      await waitForCondition(page, (probe: ProbeApi, want: string) => {
        const results = probe.collect("#counter-result");
        return results.length === 3 &&
          probe.deepText(results[0]).trim() === want;
      }, { args: [expected] });
    } catch (cause) {
      const seen = await readCounterTexts(page).catch(() => undefined);
      throw new Error(
        `Expected three #counter-result elements with the first reading ${
          JSON.stringify(expected)
        }; saw ${toIndentedDebugString(seen)}`,
        { cause },
      );
    }
  });
});

/**
 * Tests for cf-render subpath behavior.
 *
 * This tests the fix where subpath cells like .key("sidebarUI") that
 * intentionally return undefined were being incorrectly blocked by the
 * async-loading detection logic.
 *
 * Root cells (path=[]) wait for undefined to become defined (async loading).
 * Subpath cells (path=["key"]) render immediately even if undefined.
 */
describe("cf-render subpath handling", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    piece = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "examples",
          "cf-render-subpath.tsx",
        ),
      ),
      { start: true },
    );
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should render main UI without blocking on undefined sidebarUI", async () => {
    // This test verifies the fix for the cf-render regression.
    // Before the fix, cf-render would wait forever for undefined subpath cells
    // like .key("sidebarUI") to become defined, blocking the main UI.
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

    // The main UI should render despite sidebarUI being undefined
    await waitForText(page, "#main-ui", "This is the main UI");

    // Verify the title is rendered
    await waitForText(page, "h1", "Test Pattern");
  });

  it("should verify [TILE_UI] exists in the pattern", async () => {
    // Verify the tile variant exists (a valid subpath property)
    const tileUI = await piece.result.get(["$TILE_UI"]);
    assertEquals(
      typeof tileUI,
      "object",
      "[TILE_UI] should be a VNode object",
    );
  });

  it("should render correctly without sidebarUI property", async () => {
    // This test verifies that the pattern renders even though sidebarUI
    // is not defined (or defined as undefined). The cf-render fix ensures
    // that subpath cells like .key("sidebarUI") don't block the main render.
    const page = shell.page();

    // Navigate to the piece
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

    // The main UI should be visible - this proves rendering wasn't blocked
    await waitForText(page, "#main-ui", "This is the main UI");

    // Verify the paragraph is visible
    await waitForText(page, "p", "sidebarUI is intentionally undefined");
  });
});
