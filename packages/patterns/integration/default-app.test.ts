import { env, Page, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commontools/identity";
import { assert } from "@std/assert";

const { FRONTEND_URL } = env;
const CAPTURE_TRIGGER_TRACE = (() => {
  try {
    return Deno.env.get("CT_CAPTURE_TRIGGER_TRACE") === "1";
  } catch {
    return false;
  }
})();

describe("default-app flow test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  const spaceName = `test-space-${crypto.randomUUID()}`;

  it("should create a note via default app and see it in the space list", async () => {
    identity = await Identity.generate({ implementation: "noble" });

    const page = shell.page();

    // Navigate directly to the new space (no piece creation via ct tools)
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName },
      identity,
    });

    if (CAPTURE_TRIGGER_TRACE) {
      console.log("Enable trigger trace...");
      await waitFor(async () => {
        return await armTriggerTrace(page);
      });
    }

    // Wait for "Notes" dropdown button to appear and click it
    console.log("Click notes drop down...");
    await waitFor(async () => {
      return !!(await clickButtonWithText(page, "Notes"));
    });

    // Wait for dropdown to open and click "New Note"
    console.log("Click 'New Note'...");
    await waitFor(async () => {
      return !!(await clickButtonWithText(page, "New Note"));
    });

    // Wait for the note page to load by checking for the note title
    console.log("Look for '📝 New Note'...");
    await waitFor(async () => {
      const el = await page.waitForSelector(".header-piece-trigger", {
        strategy: "pierce",
      });
      const innerText = await el.innerText();
      return innerText?.includes("📝 New Note");
    });

    // Navigate back to the space page via header breadcrumb
    console.log("Navigate back to space page...");
    await waitFor(async () => {
      const el = await page.waitForSelector(".header-space", {
        strategy: "pierce",
      });
      const text = await el.innerText();
      if (text?.trim() === spaceName) {
        await el.click();
        return true;
      }
      return false;
    });
    await shell.waitForState({ view: { spaceName }, identity });

    // Check that the list contains a note item
    console.log("Wait for note in list...");
    await waitFor(() => findNoteInList(page));

    // Final assertion using the same helper
    const noteFound = await findNoteInList(page);
    assert(
      noteFound,
      "List should contain '📝 New Note #<hash>' after creating a note",
    );

    if (CAPTURE_TRIGGER_TRACE) {
      const triggerSummary = await collectTriggerTraceSummary(page);
      assert(triggerSummary, "Expected trigger trace summary to be available");
      console.log(
        "Trigger trace summary:",
        JSON.stringify(triggerSummary, null, 2),
      );
    }
  });
});

async function armTriggerTrace(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const rt = globalThis.commontools?.rt;
    if (!rt) return false;
    await rt.setTriggerTraceEnabled(false);
    await rt.setTriggerTraceEnabled(true);
    return true;
  });
}

async function collectTriggerTraceSummary(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const rt = globalThis.commontools?.rt;
    if (!rt) return null;

    const trace = await rt.getTriggerTrace();
    type TriggerSample = {
      writerActionId?: string;
      change: string;
      decision: string;
      scheduledEffects: string[];
    };

    const counts = new Map<string, number>();
    const samples = new Map<string, TriggerSample[]>();

    const pushSample = (actionId: string, sample: TriggerSample) => {
      counts.set(actionId, (counts.get(actionId) ?? 0) + 1);
      const existing = samples.get(actionId) ?? [];
      if (existing.length < 3) {
        existing.push(sample);
      }
      samples.set(actionId, existing);
    };

    for (const entry of trace) {
      const change = `${entry.space}/${entry.entityId}/${entry.path.join("/")}`;
      for (const action of entry.triggered) {
        pushSample(action.actionId, {
          writerActionId: entry.writerActionId,
          change,
          decision: action.decision,
          scheduledEffects: action.scheduledEffects.map((effect) =>
            effect.actionId
          ),
        });
        for (const effect of action.scheduledEffects) {
          pushSample(effect.actionId, {
            writerActionId: entry.writerActionId,
            change,
            decision: `scheduled-by:${action.actionId}`,
            scheduledEffects: [],
          });
        }
      }
    }

    return {
      entryCount: trace.length,
      repeatedActions: [...counts.entries()]
        .filter(([, count]) => count > 1)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([actionId, count]) => ({
          actionId,
          count,
          samples: samples.get(actionId) ?? [],
        })),
    };
  });
}

// Helper to find and click a button by text using piercing selectors
async function clickButtonWithText(
  page: Page,
  searchText: string,
): Promise<boolean> {
  try {
    // Search ct-button, button, and a elements with piercing selector
    const buttons = await page.$$("ct-button, button, a", {
      strategy: "pierce",
    });
    for (const button of buttons) {
      const text = await button.innerText();
      if (text?.trim().includes(searchText)) {
        await button.click();
        return true;
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

// Helper to find note in list using regex pattern
async function findNoteInList(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      function search(root: Document | ShadowRoot): boolean {
        const allElements = root.querySelectorAll("*");
        for (const el of allElements) {
          const text = el.textContent;
          // Match pattern: emoji + "New Note #" + hash chars
          if (text && /📝 New Note #[a-z0-9]+/.test(text)) {
            return true;
          }
          if (el.shadowRoot) {
            if (search(el.shadowRoot)) {
              return true;
            }
          }
        }
        return false;
      }
      return search(document);
    });
  } catch (_) {
    return false;
  }
}
