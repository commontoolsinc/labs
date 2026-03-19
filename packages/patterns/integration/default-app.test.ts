import { env, Page, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commontools/identity";
import { assert } from "@std/assert";

type BrowserWriteTraceEntry = {
  recordedAt: number;
  entityId: string;
  path: string[];
  writerActionId?: string;
  stack?: string;
};

const { FRONTEND_URL, SPACE_NAME } = env;
const CAPTURE_TRIGGER_TRACE = (() => {
  try {
    return Deno.env.get("CT_CAPTURE_TRIGGER_TRACE") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_WRITE_TRACE_ORDER = (() => {
  try {
    return Deno.env.get("CT_CAPTURE_WRITE_TRACE_ORDER") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_RUNNER_TRIGGER_LOG = (() => {
  try {
    return Deno.env.get("CT_CAPTURE_RUNNER_TRIGGER_LOG") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_RUNNER_TRIGGER_COUNTS = (() => {
  try {
    return Deno.env.get("CT_CAPTURE_RUNNER_TRIGGER_COUNTS") === "1";
  } catch {
    return false;
  }
})();

describe("default-app flow test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  const spaceName = SPACE_NAME;

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

    if (CAPTURE_WRITE_TRACE_ORDER) {
      console.log("Enable write trace...");
      await waitFor(async () => {
        return await armWriteTrace(page);
      });
    }

    if (CAPTURE_RUNNER_TRIGGER_LOG) {
      console.log("Enable runner trigger-flow logger...");
      await waitFor(async () => {
        return await armRunnerTriggerLogger(page);
      });
    }

    if (CAPTURE_RUNNER_TRIGGER_COUNTS) {
      console.log("Reset logger baselines...");
      await waitFor(async () => {
        return await resetLoggerBaselines(page);
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

    if (CAPTURE_WRITE_TRACE_ORDER) {
      const writeTraceSummary = await collectWriteTraceOrderSummary(page);
      assert(writeTraceSummary, "Expected write trace summary to be available");
      console.log(
        "Write trace order summary (create note):",
        JSON.stringify(writeTraceSummary, null, 2),
      );
    }

    if (CAPTURE_RUNNER_TRIGGER_LOG) {
      const runnerLogs = await collectCapturedConsoleLogs(
        page,
        "runner.trigger-flow",
      );
      assert(runnerLogs, "Expected runner trigger-flow logs to be available");
      console.log(
        "Runner trigger-flow logs (create note):",
        JSON.stringify(runnerLogs, null, 2),
      );
    }

    if (CAPTURE_RUNNER_TRIGGER_COUNTS) {
      const runnerCounts = await collectRunnerTriggerFlowCounts(page);
      assert(
        runnerCounts,
        "Expected runner trigger-flow counts to be available",
      );
      console.log(
        "Runner trigger-flow counts (create note):",
        JSON.stringify(runnerCounts, null, 2),
      );
    }

    // Navigate back to the space page and wait for new note to appear.
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

async function armWriteTrace(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const api = globalThis.commontools as {
      watchWrites?: (options: {
        space?: string;
        path?: string[];
        match?: "exact" | "prefix";
        label?: string;
      }) => Promise<unknown>;
      space?: string;
    } | undefined;
    if (!api?.watchWrites) return false;
    await api.watchWrites({
      space: api.space,
      path: [],
      match: "exact",
      label: "root writes",
    });
    return true;
  });
}

async function armRunnerTriggerLogger(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const api = globalThis.commontools?.rt;
    const globalState = globalThis as typeof globalThis & {
      __ctCapturedConsoleLogs?: Array<{ method: string; text: string }>;
      __ctConsolePatched?: boolean;
    };
    if (!api) return false;

    if (!globalState.__ctConsolePatched) {
      globalState.__ctCapturedConsoleLogs = [];
      const methods = ["debug", "info", "warn", "error", "log"] as const;
      for (const method of methods) {
        const original = console[method].bind(console);
        console[method] = (...args: unknown[]) => {
          const text = args.map((arg) => {
            if (typeof arg === "string") return arg;
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          }).join(" ");
          globalState.__ctCapturedConsoleLogs?.push({ method, text });
          if ((globalState.__ctCapturedConsoleLogs?.length ?? 0) > 500) {
            globalState.__ctCapturedConsoleLogs?.splice(0, 100);
          }
          return original(...args);
        };
      }
      globalState.__ctConsolePatched = true;
    } else {
      globalState.__ctCapturedConsoleLogs = [];
    }

    await api.setLoggerEnabled(true, "runner.trigger-flow");
    await api.setLoggerLevel("debug", "runner.trigger-flow");
    return true;
  });
}

async function resetLoggerBaselines(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const api = globalThis.commontools?.rt;
    if (!api) return false;
    await api.resetLoggerBaselines();
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

async function collectWriteTraceOrderSummary(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const api = globalThis.commontools as {
      getWriteStackTrace?: () => Promise<BrowserWriteTraceEntry[]>;
      readCell?: (options: { id: string }) => Promise<unknown>;
    } | undefined;
    if (!api?.getWriteStackTrace || !api.readCell) return null;
    const readCell = api.readCell;

    const trace = await api.getWriteStackTrace();
    const rootTrace = trace
      .filter((entry) => entry.path.length === 0)
      .sort((a, b) => a.recordedAt - b.recordedAt);

    function classifyStack(stack?: string): string {
      if (!stack) return "unknown";
      if (stack.includes("_CellImpl.setSourceCell")) {
        return "setup:setSourceCell";
      }
      if (
        stack.includes("_CellImpl.setRawUntyped") &&
        stack.includes("Runner.setupInternal")
      ) {
        const runnerLine = stack.match(/runner\\.ts:(\\d+)/)?.[1];
        if (runnerLine) {
          const line = Number(runnerLine);
          if (line >= 300 && line < 330) {
            return "setup:processCell.setRawUntyped";
          }
          if (line >= 330 && line < 360) {
            return "setup:resultCell.setRawUntyped";
          }
        }
        return "setup:setRawUntyped";
      }
      if (stack.includes("_CellImpl.setRawUntyped")) {
        return "raw:setRawUntyped";
      }
      if (stack.includes("sendValueToBinding")) {
        return "diff:sendValueToBinding";
      }
      if (stack.includes("_CellImpl.push")) {
        return "diff:Cell.push";
      }
      if (stack.includes("_CellImpl.send")) {
        return "diff:Cell.send";
      }
      if (stack.includes("_CellImpl.set")) {
        return "diff:Cell.set";
      }
      if (stack.includes("applyChangeSet")) {
        return "diff:applyChangeSet";
      }
      return "other";
    }

    function interestingCallPath(stack?: string): string[] {
      if (!stack) return [];
      const lines = stack.split("\n").map((line) => line.trim());
      const interesting = lines.filter((line) =>
        line.includes("handler:") ||
        line.includes("raw:") ||
        line.includes("postRun") ||
        line.includes("Runner.instantiatePatternNode") ||
        line.includes("Runner.run") ||
        line.includes("Runner.setupInternal") ||
        line.includes("sendValueToBinding") ||
        line.includes("diffAndUpdate") ||
        line.includes("applyChangeSet") ||
        line.includes("_CellImpl.push") ||
        line.includes("_CellImpl.send") ||
        line.includes("_CellImpl.setSourceCell") ||
        line.includes("_CellImpl.setRawUntyped") ||
        line.includes("_CellImpl.set")
      );
      return interesting.slice(0, 8);
    }

    function summarizeValue(value: unknown): Record<string, unknown> {
      if (value === undefined) return { kind: "undefined" };
      if (value === null) return { kind: "null" };
      if (typeof value === "boolean") return { kind: "boolean", value };
      if (typeof value === "number") return { kind: "number", value };
      if (typeof value === "string") {
        return {
          kind: "string",
          preview: value.length > 120 ? `${value.slice(0, 117)}...` : value,
        };
      }
      if (Array.isArray(value)) return { kind: "array", length: value.length };
      if (typeof value !== "object") return { kind: typeof value };

      const record = value as Record<string, unknown>;
      const internal = typeof record.internal === "object" && record.internal
        ? record.internal as Record<string, unknown>
        : undefined;
      return {
        kind: "object",
        topKeys: Object.keys(record).slice(0, 8),
        internalKeys: internal ? Object.keys(internal).slice(0, 8) : [],
      };
    }

    const groups = new Map<string, typeof rootTrace>();
    for (const entry of rootTrace) {
      const existing = groups.get(entry.entityId) ?? [];
      existing.push(entry);
      groups.set(entry.entityId, existing);
    }

    const sequences = await Promise.all(
      [...groups.entries()]
        .filter(([, entries]) => entries.length > 1)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 12)
        .map(async ([entityId, entries]) => {
          const currentValue = await readCell({ id: entityId });
          const firstRecordedAt = entries[0]?.recordedAt ?? 0;
          return {
            entityId,
            count: entries.length,
            currentValue: summarizeValue(currentValue),
            sequence: entries.map((entry, index) => ({
              order: index + 1,
              dtMs: Number((entry.recordedAt - firstRecordedAt).toFixed(3)),
              kind: classifyStack(entry.stack),
              writerActionId: entry.writerActionId,
              callPath: interestingCallPath(entry.stack),
            })),
          };
        }),
    );

    return {
      entryCount: trace.length,
      rootEntryCount: rootTrace.length,
      repeatedEntityCount: sequences.length,
      sequences,
    };
  });
}

async function collectCapturedConsoleLogs(
  page: Page,
  substring: string,
): Promise<unknown> {
  const logs = await page.evaluate(() => {
    const globalState = globalThis as typeof globalThis & {
      __ctCapturedConsoleLogs?: Array<{ method: string; text: string }>;
    };
    return globalState.__ctCapturedConsoleLogs ?? [];
  }) as Array<{ method: string; text: string }>;

  return logs
    .filter((entry) => entry.text.includes(substring))
    .slice(-80);
}

async function collectRunnerTriggerFlowCounts(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const api = globalThis.commontools?.rt;
    if (!api) return null;

    const { counts } = await api.getLoggerCounts();
    const loggerCounts = counts["runner.trigger-flow"];
    if (!loggerCounts) return null;
    type CountRow = {
      total: number;
      debug: number;
      info: number;
      warn: number;
      error: number;
    };
    const keyedCounts = loggerCounts as Record<string, CountRow>;

    const toRows = (prefix: string) =>
      Object.entries(keyedCounts)
        .filter(([key]) => key.startsWith(prefix))
        .sort((a, b) => (b[1].total ?? 0) - (a[1].total ?? 0))
        .slice(0, 12)
        .map(([key, value]) => ({
          key,
          total: value.total ?? 0,
          debug: value.debug ?? 0,
          info: value.info ?? 0,
          warn: value.warn ?? 0,
          error: value.error ?? 0,
        }));

    return {
      runnerRun: toRows("runner-run/"),
      setupInternal: toRows("setup-internal/"),
      instantiatePatternNode: toRows("instantiate-pattern-node/"),
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
