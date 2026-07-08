import {
  env,
  Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { waitForText } from "./cfc-browser-helpers.ts";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";
import { defer, type Deferred } from "@commonfabric/utils/defer";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("nested counter integration test", () => {
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
  // resolves the waiter when the target lands. A fresh deferred per call keeps
  // the sequential value checks independent.
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
    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "examples",
      "nested-counter.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await cc.manager().runtime.harness
      .resolve(
        new FileSystemProgramResolver(sourcePath, rootPath),
      );

    piece = await cc.create(
      program, // We operate on the piece in this thread
      { start: true },
    );

    // In pull mode, create a sink to keep the piece reactive when inputs change.
    // The sink also drives awaitResultValue: it records the latest committed
    // value and resolves a pending waiter when its target is reached.
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

    // Verify via direct operations that the nested structure works
    assertEquals(await piece.result.get(["value"]), 0);
  });

  it("should click the increment button and update the counter", async () => {
    const page = shell.page();

    // Click increment button (second button - first is decrement)
    await clickNthButton(page, "[data-cf-button]", 1);

    // Wait for the piece result to reflect the increment.
    await awaitResultValue(1);
    await waitForCounter(page, "Counter is the 1st number");
  });

  it("should update counter value via direct operations and verify UI", async () => {
    const page = shell.page();

    // Set value to 5 via direct operation
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

    await waitForCounter(page, "Counter is the 5th number");
  });

  it("should verify nested counter has multiple counter displays", async () => {
    const page = shell.page();

    // Both nested counter displays (there are two) must show the same value.
    await waitForCondition(page, (probe, expected) => {
      const results = probe.collect("#counter-result");
      return results.length === 2 &&
        results.every((el) => probe.deepText(el).trim() === expected);
    }, { args: ["Counter is the 5th number"] });
  });
});

async function waitForCounter(page: Page, text: string) {
  await waitForText(page, "#counter-result", text);
}

// Clicks the nth button matching selector: wait until that button is present
// and interactive (scrolled into view with a stable box model), then dispatch a
// single trusted click on it. The wait re-checks on each DOM mutation while the
// page settles (re-renders, layout shifts, hydration) rather than re-clicking.
const NTH_BUTTON_CLICK_TARGET_ATTR = "data-cfc-nth-button-target";

async function clickNthButton(
  page: Page,
  selector: string,
  index: number,
): Promise<void> {
  const token = `cfc-nth-button-${crypto.randomUUID()}`;
  try {
    await waitForCondition(page, async (
      probe: ProbeApi,
      sel: string,
      idx: number,
      tok: string,
      attr: string,
    ) => {
      const target = probe.collect(sel)[idx];
      if (!target) return false;
      target.scrollIntoView({ block: "center", inline: "center" });
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
      if (!probe.isVisible(target)) return false;
      target.setAttribute(attr, tok);
      return true;
    }, { args: [selector, index, token, NTH_BUTTON_CLICK_TARGET_ATTR] });
  } catch (cause) {
    throw new Error(
      `Unable to find button #${index} matching "${selector}"`,
      { cause },
    );
  }
  try {
    const clickTarget = await page.waitForSelector(
      `[${NTH_BUTTON_CLICK_TARGET_ATTR}="${token}"]`,
      { strategy: "pierce" },
    );
    await clickTarget.click();
  } finally {
    await page.evaluate((targetToken, targetAttr) => {
      function collect(root: Document | ShadowRoot, result: Element[]): void {
        for (const element of root.querySelectorAll("*")) {
          if (element.getAttribute(targetAttr) === targetToken) {
            result.push(element);
          }
          if (element.shadowRoot) collect(element.shadowRoot, result);
        }
      }
      const matches: Element[] = [];
      collect(document, matches);
      for (const element of matches) element.removeAttribute(targetAttr);
    }, { args: [token, NTH_BUTTON_CLICK_TARGET_ATTR] }).catch(() => {});
  }
}
