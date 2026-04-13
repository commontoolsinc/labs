import { env, Page, waitFor } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { assert } from "@std/assert";

type BrowserWriteTraceEntry = {
  recordedAt: number;
  entityId: string;
  path: string[];
  writerActionId?: string;
  stack?: string;
};

type BrowserActionRunTraceEntry = {
  recordedAt: number;
  actionId: string;
  actionType: "effect" | "computation";
  parentActionId?: string;
  durationMs: number;
  declaredWrites: BrowserActionRunTraceAddress[];
  actualWrites: BrowserActionRunTraceAddress[];
};

type BrowserActionRunTraceAddress = {
  space: string;
  entityId: string;
  path: string[];
};

const { FRONTEND_URL, SPACE_NAME } = env;
const CAPTURE_TRIGGER_TRACE = (() => {
  try {
    return Deno.env.get("CF_CAPTURE_TRIGGER_TRACE") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_WRITE_TRACE_ORDER = (() => {
  try {
    return Deno.env.get("CF_CAPTURE_WRITE_TRACE_ORDER") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_RUNNER_TRIGGER_LOG = (() => {
  try {
    return Deno.env.get("CF_CAPTURE_RUNNER_TRIGGER_LOG") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_RUNNER_TRIGGER_COUNTS = (() => {
  try {
    return Deno.env.get("CF_CAPTURE_RUNNER_TRIGGER_COUNTS") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_WISH_FLOW_LOG = (() => {
  try {
    return Deno.env.get("CF_CAPTURE_WISH_FLOW_LOG") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_WISH_FLOW_COUNTS = (() => {
  try {
    return Deno.env.get("CF_CAPTURE_WISH_FLOW_COUNTS") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_SOURCE_LOCATION_LOG = (() => {
  try {
    return Deno.env.get("CF_CAPTURE_SOURCE_LOCATION_LOG") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_ACTION_RUN_SERIES = (() => {
  try {
    const raw = Deno.env.get("CF_CAPTURE_ACTION_RUN_SERIES");
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
})();
const CAPTURE_HOME_LOAD_SERIES = (() => {
  try {
    const raw = Deno.env.get("CF_CAPTURE_HOME_LOAD_SERIES");
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
})();
const NOTE_CREATE_TIMING_SERIES = (() => {
  try {
    const raw = Deno.env.get("CF_NOTE_CREATE_TIMING_SERIES");
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
})();
const CAPTURE_NOTE_CREATE_PROFILE_SERIES = (() => {
  try {
    const raw = Deno.env.get("CF_CAPTURE_NOTE_CREATE_PROFILE_SERIES");
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
})();

type NoteCreateTimingEntry = {
  noteIndex: number;
  noteTitle: string;
  noteCountBefore: number;
  noteCountAfter: number;
  createToViewMs: number;
  returnToHomeMs: number;
  totalMs: number;
};

type NoteCreateProfileEntry = {
  noteIndex: number;
  focusTiming: Array<{
    logger: string;
    key: string;
    count: number;
    totalTime: number;
    average: number;
    p50: number;
    p95: number;
    max: number;
  }>;
  topTiming: Array<{
    logger: string;
    key: string;
    count: number;
    totalTime: number;
    average: number;
    p50: number;
    p95: number;
    max: number;
  }>;
  settle: {
    executeCalls: number;
    totalDurationMs: number;
    maxDurationMs: number;
    latestDurationMs: number;
    maxIterations: number;
    latestIterations: number;
    recent: Array<{
      totalDurationMs: number;
      iterations: number;
      actionsRun: number;
    }>;
  };
};

describe("default-app flow test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  const spaceName = SPACE_NAME;

  it("should create a note via default app and see it in the space list", async () => {
    identity = await Identity.generate({ implementation: "noble" });

    const page = shell.page();

    // Navigate directly to the new space (no piece creation via cf tools)
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

    if (CAPTURE_WISH_FLOW_LOG) {
      console.log("Enable wish-flow logger...");
      await waitFor(async () => {
        return await armWishFlowLogger(page);
      });
    }

    if (CAPTURE_WISH_FLOW_COUNTS && !CAPTURE_RUNNER_TRIGGER_COUNTS) {
      console.log("Reset logger baselines...");
      await waitFor(async () => {
        return await resetLoggerBaselines(page);
      });
    }

    if (CAPTURE_SOURCE_LOCATION_LOG) {
      console.log("Enable source-location logger...");
      await waitFor(async () => {
        return await armSourceLocationLogger(page);
      });
    }

    const actionRunSeries: unknown[] = [];
    const homeLoadSeries: unknown[] = [];
    const noteCreateTimings: NoteCreateTimingEntry[] = [];
    const noteCreateProfiles: NoteCreateProfileEntry[] = [];
    const noteIterations = Math.max(
      CAPTURE_ACTION_RUN_SERIES > 0 ? CAPTURE_ACTION_RUN_SERIES : 1,
      CAPTURE_HOME_LOAD_SERIES,
      NOTE_CREATE_TIMING_SERIES,
      CAPTURE_NOTE_CREATE_PROFILE_SERIES,
    );

    if (CAPTURE_HOME_LOAD_SERIES > 0) {
      const homeLoadSummary = await collectHomeLoadSummaryFromFreshPage(
        shell,
        {
          frontendUrl: FRONTEND_URL,
          spaceName,
          expectNoteInList: false,
        },
      );
      assert(
        homeLoadSummary,
        "Expected initial home load summary to be available",
      );
      homeLoadSeries.push({
        noteCount: 0,
        ...(homeLoadSummary as Record<string, unknown>),
      });
      console.log(
        "Home load summary (0 notes):",
        JSON.stringify(homeLoadSummary, null, 2),
      );
    }

    for (let noteIndex = 1; noteIndex <= noteIterations; noteIndex++) {
      const noteTitlesBefore = await collectNoteTitlesInList(page);
      const noteCountBefore = noteTitlesBefore.length;

      if (noteIndex <= CAPTURE_NOTE_CREATE_PROFILE_SERIES) {
        console.log(
          `Reset note-create profiling baselines (note ${noteIndex})...`,
        );
        await waitFor(async () => {
          return await resetNoteCreateProfiling(page);
        });
      }

      if (CAPTURE_ACTION_RUN_SERIES > 0) {
        console.log(`Enable action run trace for note ${noteIndex}...`);
        await waitFor(async () => {
          return await armActionRunTrace(page);
        });
      }

      console.log(`Click notes drop down (note ${noteIndex})...`);
      await waitFor(async () => {
        return !!(await clickButtonWithText(page, "Notes"));
      });

      const noteCreateStartedAt = performance.now();
      console.log(`Click 'New Note' (note ${noteIndex})...`);
      await waitFor(async () => {
        return !!(await clickButtonWithText(page, "New Note"));
      });

      console.log(`Wait for note view (note ${noteIndex})...`);
      await waitFor(async () => {
        return await page.evaluate(() => {
          const state = globalThis.app?.serialize?.();
          return !!state &&
            !!state.view &&
            typeof state.view === "object" &&
            "pieceId" in state.view &&
            typeof state.view.pieceId === "string" &&
            state.view.pieceId.length > 0;
        });
      });

      await waitFor(async () => {
        return await waitForRuntimeIdle(page);
      });
      const noteViewReadyAt = performance.now();

      if (CAPTURE_ACTION_RUN_SERIES > 0) {
        const actionRunSummary = await collectActionRunSummary(page);
        assert(
          actionRunSummary,
          `Expected action run summary for note ${noteIndex}`,
        );
        actionRunSeries.push({
          noteIndex,
          ...(actionRunSummary as Record<string, unknown>),
        });
        console.log(
          `Action run summary (note ${noteIndex}):`,
          JSON.stringify(actionRunSummary, null, 2),
        );
      }

      if (noteIndex === 1 && CAPTURE_WRITE_TRACE_ORDER) {
        const writeTraceSummary = await collectWriteTraceOrderSummary(page);
        assert(
          writeTraceSummary,
          "Expected write trace summary to be available",
        );
        console.log(
          "Write trace order summary (create note):",
          JSON.stringify(writeTraceSummary, null, 2),
        );
      }

      if (noteIndex === 1 && CAPTURE_RUNNER_TRIGGER_LOG) {
        const runnerLogs = await collectCapturedConsoleLogs(
          page,
          "runner.trigger-flow",
        );
        assert(
          Array.isArray(runnerLogs) && runnerLogs.length > 0,
          "Expected runner trigger-flow logs to be available",
        );
        console.log(
          "Runner trigger-flow logs (create note):",
          JSON.stringify(runnerLogs, null, 2),
        );
      }

      if (noteIndex === 1 && CAPTURE_RUNNER_TRIGGER_COUNTS) {
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

      if (noteIndex === 1 && CAPTURE_WISH_FLOW_LOG) {
        const wishLogs = await collectCapturedConsoleLogs(page, "[WISH");
        assert(
          Array.isArray(wishLogs) && wishLogs.length > 0,
          "Expected runner wish-flow logs to be available",
        );
        console.log(
          "Runner wish-flow logs (create note):",
          JSON.stringify(wishLogs, null, 2),
        );
      }

      if (noteIndex === 1 && CAPTURE_WISH_FLOW_COUNTS) {
        const wishCounts = await collectWishFlowCounts(page);
        assert(wishCounts, "Expected runner wish-flow counts to be available");
        console.log(
          "Runner wish-flow counts (create note):",
          JSON.stringify(wishCounts, null, 2),
        );
      }

      if (noteIndex === 1 && CAPTURE_SOURCE_LOCATION_LOG) {
        const sourceLocationLogs = await collectSourceLocationSamples(page);
        console.log(
          "Builder source-location samples (create note):",
          JSON.stringify(sourceLocationLogs, null, 2),
        );
      }

      console.log(`Navigate back to space page (note ${noteIndex})...`);
      await waitFor(async () => {
        return await clickPieceLinkWithText(page, spaceName);
      });
      await shell.waitForState({ view: { spaceName }, identity });
      await waitFor(async () => {
        return await waitForRuntimeIdle(page);
      });

      console.log(`Wait for note count to increase (note ${noteIndex})...`);
      await waitFor(async () => {
        const noteTitles = await collectNoteTitlesInList(page);
        return noteTitles.length > noteCountBefore;
      });

      const noteTitlesAfter = await collectNoteTitlesInList(page);
      const newNoteTitles = noteTitlesAfter.filter((title) =>
        !noteTitlesBefore.includes(title)
      );
      assert(
        newNoteTitles.length > 0,
        `Expected a new note title in the list for note ${noteIndex}`,
      );

      const noteCreateFinishedAt = performance.now();
      const noteCreateTiming: NoteCreateTimingEntry = {
        noteIndex,
        noteTitle: newNoteTitles[0]!,
        noteCountBefore,
        noteCountAfter: noteTitlesAfter.length,
        createToViewMs: Number(
          (noteViewReadyAt - noteCreateStartedAt).toFixed(3),
        ),
        returnToHomeMs: Number(
          (noteCreateFinishedAt - noteViewReadyAt).toFixed(3),
        ),
        totalMs: Number(
          (noteCreateFinishedAt - noteCreateStartedAt).toFixed(3),
        ),
      };
      noteCreateTimings.push(noteCreateTiming);
      console.log(
        `Note creation timing (note ${noteIndex}):`,
        JSON.stringify(noteCreateTiming, null, 2),
      );

      if (noteIndex <= CAPTURE_NOTE_CREATE_PROFILE_SERIES) {
        const noteCreateProfile = await collectNoteCreateProfile(page);
        assert(
          noteCreateProfile,
          `Expected note-create profile for note ${noteIndex}`,
        );
        noteCreateProfiles.push({
          noteIndex,
          ...(noteCreateProfile as Omit<NoteCreateProfileEntry, "noteIndex">),
        });
      }

      if (noteIndex <= CAPTURE_HOME_LOAD_SERIES) {
        console.log(
          `Open fresh home page for load summary (${noteIndex} notes)...`,
        );
        const homeLoadSummary = await collectHomeLoadSummaryFromFreshPage(
          shell,
          {
            frontendUrl: FRONTEND_URL,
            spaceName,
            expectNoteInList: true,
          },
        );
        assert(
          homeLoadSummary,
          `Expected home load summary for ${noteIndex} notes`,
        );
        homeLoadSeries.push({
          noteCount: noteIndex,
          ...(homeLoadSummary as Record<string, unknown>),
        });
        console.log(
          `Home load summary (${noteIndex} notes):`,
          JSON.stringify(homeLoadSummary, null, 2),
        );
      }
    }

    const noteFound = await findNoteInList(page);
    assert(
      noteFound,
      "List should contain '📝 New Note #<hash>' after creating a note",
    );

    if (actionRunSeries.length > 0) {
      console.log(
        "Action run series comparison:",
        JSON.stringify(compareActionRunSeries(actionRunSeries), null, 2),
      );
    }

    if (homeLoadSeries.length > 0) {
      console.log(
        "Home load series comparison:",
        JSON.stringify(compareHomeLoadSeries(homeLoadSeries), null, 2),
      );
    }

    if (noteCreateTimings.length > 0) {
      console.log(
        "Note creation timing summary:",
        JSON.stringify(summarizeNoteCreateTimings(noteCreateTimings), null, 2),
      );
    }

    if (noteCreateProfiles.length > 0) {
      console.log(
        "Note creation profile summary:",
        JSON.stringify(compareNoteCreateProfiles(noteCreateProfiles), null, 2),
      );
    }

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
    const rt = globalThis.commonfabric?.rt;
    if (!rt) return false;
    await rt.setTriggerTraceEnabled(false);
    await rt.setTriggerTraceEnabled(true);
    return true;
  });
}

async function armWriteTrace(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric as {
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
  await ensureCapturedConsole(page);
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api) return false;

    await api.setLoggerEnabled(true, "runner.trigger-flow");
    await api.setLoggerLevel("debug", "runner.trigger-flow");
    return true;
  });
}

async function armWishFlowLogger(page: Page): Promise<boolean> {
  await ensureCapturedConsole(page);
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api) return false;

    await api.setLoggerEnabled(true, "runner.wish-flow");
    await api.setLoggerLevel("debug", "runner.wish-flow");
    return true;
  });
}

async function armSourceLocationLogger(page: Page): Promise<boolean> {
  await ensureCapturedConsole(page);
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api) return false;

    await api.setLoggerEnabled(true, "builder.source-location");
    await api.setLoggerLevel("debug", "builder.source-location");
    await api.setLoggerEnabled(true, "runner.source-location");
    await api.setLoggerLevel("debug", "runner.source-location");
    return true;
  });
}

async function resetLoggerBaselines(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api) return false;
    await api.resetLoggerBaselines();
    return true;
  });
}

async function resetNoteCreateProfiling(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api) return false;
    await api.resetLoggerBaselines();
    await api.setSettleStatsEnabled(false);
    await api.setSettleStatsEnabled(true);
    return true;
  });
}

async function collectTriggerTraceSummary(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const rt = globalThis.commonfabric?.rt;
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
          scheduledEffects: action.scheduledEffects.map((effect: {
            actionId: string;
          }) => effect.actionId),
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
    const api = globalThis.commonfabric as {
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
        const runnerLine = stack.match(/runner\.ts:(\d+)/)?.[1];
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

async function armActionRunTrace(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const rt = globalThis.commonfabric?.rt;
    if (!rt) return false;
    await rt.setActionRunTraceEnabled(false);
    await rt.setActionRunTraceEnabled(true);
    return true;
  });
}

async function waitForRuntimeIdle(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const rt = globalThis.commonfabric?.rt;
    if (!rt?.idle) return false;
    await rt.idle();
    return true;
  });
}

async function waitForHomePageReady(
  page: Page,
  options: { spaceName: string; expectNoteInList: boolean },
): Promise<void> {
  await waitFor(async () => {
    return await page.evaluate((spaceName: string) => {
      const app = globalThis.app;
      const rt = globalThis.commonfabric?.rt;
      const state = app?.serialize?.();
      const view = state?.view;
      return !!(
        rt &&
        state &&
        view &&
        typeof view === "object" &&
        "spaceName" in view &&
        view.spaceName === spaceName
      );
    }, { args: [options.spaceName] });
  });

  if (options.expectNoteInList) {
    await waitFor(() => findNoteInList(page));
  }

  await waitFor(async () => {
    return await waitForRuntimeIdle(page);
  });
}

async function collectHomeLoadSummaryFromFreshPage(
  shell: ShellIntegration,
  options: {
    frontendUrl: string;
    spaceName: string;
    expectNoteInList: boolean;
  },
): Promise<unknown> {
  const page = await shell.newPage();
  const startedAt = performance.now();

  try {
    await page.goto(`${options.frontendUrl}/${options.spaceName}`);
    await page.applyConsoleFormatter();
    await waitForHomePageReady(page, {
      spaceName: options.spaceName,
      expectNoteInList: options.expectNoteInList,
    });

    const homeLoadSummary = await collectHomeLoadSummary(page);
    if (!homeLoadSummary || typeof homeLoadSummary !== "object") {
      return homeLoadSummary;
    }
    return {
      loadDurationMs: Number((performance.now() - startedAt).toFixed(3)),
      ...(homeLoadSummary as Record<string, unknown>),
    };
  } finally {
    await page.close();
  }
}

async function collectActionRunSummary(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const rt = globalThis.commonfabric?.rt;
    if (!rt?.getActionRunTrace || !rt?.idle) return null;
    await rt.idle();
    const trace = await rt.getActionRunTrace() as BrowserActionRunTraceEntry[];
    const toTargetKey = (target: BrowserActionRunTraceAddress) =>
      `${target.space}/${target.entityId}/${target.path.join("/")}`;
    const getInstanceTargets = (entry: BrowserActionRunTraceEntry) => {
      const declaredTargets = (entry.declaredWrites ?? []).map(toTargetKey);
      if (declaredTargets.length > 0) return [...new Set(declaredTargets)];
      const actualTargets = (entry.actualWrites ?? []).map(toTargetKey);
      if (actualTargets.length > 0) return [...new Set(actualTargets)];
      return ["(no writes)"];
    };

    const byAction = new Map<string, {
      actionType: "effect" | "computation";
      count: number;
      totalDurationMs: number;
      maxDurationMs: number;
      parentActionIds: Set<string>;
    }>();
    const byActionInstance = new Map<string, {
      actionId: string;
      actionType: "effect" | "computation";
      instanceTargets: string[];
      count: number;
      totalDurationMs: number;
      maxDurationMs: number;
      parentActionIds: Set<string>;
    }>();

    for (const entry of trace) {
      const row = byAction.get(entry.actionId) ?? {
        actionType: entry.actionType,
        count: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        parentActionIds: new Set<string>(),
      };
      row.count += 1;
      row.totalDurationMs += entry.durationMs;
      row.maxDurationMs = Math.max(row.maxDurationMs, entry.durationMs);
      if (entry.parentActionId) {
        row.parentActionIds.add(entry.parentActionId);
      }
      byAction.set(entry.actionId, row);

      const instanceTargets = getInstanceTargets(entry);
      const instanceKey = `${entry.actionId}::${instanceTargets.join(" | ")}`;
      const instanceRow = byActionInstance.get(instanceKey) ?? {
        actionId: entry.actionId,
        actionType: entry.actionType,
        instanceTargets,
        count: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        parentActionIds: new Set<string>(),
      };
      instanceRow.count += 1;
      instanceRow.totalDurationMs += entry.durationMs;
      instanceRow.maxDurationMs = Math.max(
        instanceRow.maxDurationMs,
        entry.durationMs,
      );
      if (entry.parentActionId) {
        instanceRow.parentActionIds.add(entry.parentActionId);
      }
      byActionInstance.set(instanceKey, instanceRow);
    }

    const actions = [...byAction.entries()]
      .map(([actionId, row]) => ({
        actionId,
        actionType: row.actionType,
        count: row.count,
        totalDurationMs: Number(row.totalDurationMs.toFixed(3)),
        averageDurationMs: Number((row.totalDurationMs / row.count).toFixed(3)),
        maxDurationMs: Number(row.maxDurationMs.toFixed(3)),
        parentActionIds: [...row.parentActionIds].sort(),
      }))
      .sort((a, b) =>
        b.count - a.count ||
        b.totalDurationMs - a.totalDurationMs ||
        a.actionId.localeCompare(b.actionId)
      );
    const actionInstances = [...byActionInstance.values()]
      .map((row) => ({
        actionId: row.actionId,
        actionType: row.actionType,
        instanceTargets: row.instanceTargets,
        count: row.count,
        totalDurationMs: Number(row.totalDurationMs.toFixed(3)),
        averageDurationMs: Number((row.totalDurationMs / row.count).toFixed(3)),
        maxDurationMs: Number(row.maxDurationMs.toFixed(3)),
        parentActionIds: [...row.parentActionIds].sort(),
      }))
      .sort((a, b) =>
        b.count - a.count ||
        b.totalDurationMs - a.totalDurationMs ||
        a.actionId.localeCompare(b.actionId) ||
        a.instanceTargets.join(" | ").localeCompare(
          b.instanceTargets.join(" | "),
        )
      );

    return {
      traceLength: trace.length,
      uniqueActions: actions.length,
      uniqueActionInstances: actionInstances.length,
      effectsRun: trace.filter((entry) => entry.actionType === "effect").length,
      computationsRun: trace.filter((entry) =>
        entry.actionType === "computation"
      )
        .length,
      actions,
      actionInstances,
    };
  });
}

function compareActionRunSeries(series: unknown[]): unknown {
  const notes = series as Array<{
    noteIndex: number;
    traceLength: number;
    uniqueActions: number;
    uniqueActionInstances: number;
    effectsRun: number;
    computationsRun: number;
    actions: Array<{
      actionId: string;
      actionType: "effect" | "computation";
      count: number;
      totalDurationMs: number;
      averageDurationMs: number;
      maxDurationMs: number;
      parentActionIds: string[];
    }>;
    actionInstances: Array<{
      actionId: string;
      actionType: "effect" | "computation";
      instanceTargets: string[];
      count: number;
      totalDurationMs: number;
      averageDurationMs: number;
      maxDurationMs: number;
      parentActionIds: string[];
    }>;
  }>;

  const byAction = new Map<string, {
    actionType: "effect" | "computation";
    counts: Record<number, number>;
    totalDurationMs: Record<number, number>;
  }>();
  const byActionInstance = new Map<string, {
    actionId: string;
    actionType: "effect" | "computation";
    instanceTargets: string[];
    counts: Record<number, number>;
    totalDurationMs: Record<number, number>;
  }>();

  for (const note of notes) {
    for (const action of note.actions) {
      const row = byAction.get(action.actionId) ?? {
        actionType: action.actionType,
        counts: {},
        totalDurationMs: {},
      };
      row.counts[note.noteIndex] = action.count;
      row.totalDurationMs[note.noteIndex] = action.totalDurationMs;
      byAction.set(action.actionId, row);
    }
    for (const actionInstance of note.actionInstances) {
      const instanceKey = `${actionInstance.actionId}::${
        actionInstance.instanceTargets.join(" | ")
      }`;
      const row = byActionInstance.get(instanceKey) ?? {
        actionId: actionInstance.actionId,
        actionType: actionInstance.actionType,
        instanceTargets: actionInstance.instanceTargets,
        counts: {},
        totalDurationMs: {},
      };
      row.counts[note.noteIndex] = actionInstance.count;
      row.totalDurationMs[note.noteIndex] = actionInstance.totalDurationMs;
      byActionInstance.set(instanceKey, row);
    }
  }

  const noteIndices = notes.map((note) => note.noteIndex);
  const rows = [...byAction.entries()].map(([actionId, row]) => {
    const counts = noteIndices.map((noteIndex) => row.counts[noteIndex] ?? 0);
    const durations = noteIndices.map((noteIndex) =>
      row.totalDurationMs[noteIndex] ?? 0
    );
    return {
      actionId,
      actionType: row.actionType,
      counts,
      durationsMs: durations.map((value) => Number(value.toFixed(3))),
      deltaLastVsFirst: counts[counts.length - 1]! - counts[0]!,
    };
  }).sort((a, b) =>
    b.deltaLastVsFirst - a.deltaLastVsFirst ||
    (b.counts[b.counts.length - 1] ?? 0) -
      (a.counts[a.counts.length - 1] ?? 0) ||
    a.actionId.localeCompare(b.actionId)
  );
  const instanceRows = [...byActionInstance.values()].map((row) => {
    const counts = noteIndices.map((noteIndex) => row.counts[noteIndex] ?? 0);
    const durations = noteIndices.map((noteIndex) =>
      row.totalDurationMs[noteIndex] ?? 0
    );
    return {
      actionId: row.actionId,
      actionType: row.actionType,
      instanceTargets: row.instanceTargets,
      counts,
      durationsMs: durations.map((value) => Number(value.toFixed(3))),
      deltaLastVsFirst: counts[counts.length - 1]! - counts[0]!,
    };
  }).sort((a, b) =>
    b.deltaLastVsFirst - a.deltaLastVsFirst ||
    (b.counts[b.counts.length - 1] ?? 0) -
      (a.counts[a.counts.length - 1] ?? 0) ||
    a.actionId.localeCompare(b.actionId) ||
    a.instanceTargets.join(" | ").localeCompare(b.instanceTargets.join(" | "))
  );

  return {
    notes: notes.map((note) => ({
      noteIndex: note.noteIndex,
      traceLength: note.traceLength,
      uniqueActions: note.uniqueActions,
      uniqueActionInstances: note.uniqueActionInstances,
      effectsRun: note.effectsRun,
      computationsRun: note.computationsRun,
    })),
    increasedOnLaterRuns: rows.filter((row) => row.deltaLastVsFirst > 0).slice(
      0,
      25,
    ),
    unchangedAcrossRuns: rows.filter((row) =>
      row.counts.every((count) => count === row.counts[0])
    ).slice(0, 25),
    onlyInLaterRuns: rows.filter((row) =>
      row.counts[0] === 0 &&
      row.counts.slice(1).some((count) => count > 0)
    ).slice(0, 25),
    noteActionInstancesIncreasedOnLaterRuns: instanceRows.filter((row) =>
      row.actionId.includes("/notes/note.tsx") && row.deltaLastVsFirst > 0
    ).slice(0, 25),
    noteActionInstancesUnchangedAcrossRuns: instanceRows.filter((row) =>
      row.actionId.includes("/notes/note.tsx") &&
      row.counts.every((count) => count === row.counts[0])
    ).slice(0, 25),
  };
}

function summarizeNoteCreateTimings(
  series: NoteCreateTimingEntry[],
): unknown {
  const summarizeValues = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (value: number) =>
      sorted[
        Math.min(
          sorted.length - 1,
          Math.max(0, Math.ceil(sorted.length * value) - 1),
        )
      ] ?? 0;

    const sum = sorted.reduce((total, current) => total + current, 0);
    return {
      minMs: Number((sorted[0] ?? 0).toFixed(3)),
      avgMs: Number((sum / Math.max(sorted.length, 1)).toFixed(3)),
      p50Ms: Number(percentile(0.5).toFixed(3)),
      p95Ms: Number(percentile(0.95).toFixed(3)),
      maxMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)),
    };
  };

  return {
    count: series.length,
    totals: summarizeValues(series.map((entry) => entry.totalMs)),
    createToView: summarizeValues(series.map((entry) => entry.createToViewMs)),
    returnToHome: summarizeValues(series.map((entry) => entry.returnToHomeMs)),
    notes: series,
  };
}

function compareNoteCreateProfiles(
  series: NoteCreateProfileEntry[],
): unknown {
  const noteIndices = series.map((entry) => entry.noteIndex);
  const byTimingKey = new Map<string, {
    logger: string;
    key: string;
    totalTimes: Record<number, number>;
    averages: Record<number, number>;
    counts: Record<number, number>;
    p95s: Record<number, number>;
  }>();

  for (const entry of series) {
    for (const row of entry.focusTiming) {
      const key = `${row.logger}:${row.key}`;
      const existing = byTimingKey.get(key) ?? {
        logger: row.logger,
        key: row.key,
        totalTimes: {},
        averages: {},
        counts: {},
        p95s: {},
      };
      existing.totalTimes[entry.noteIndex] = row.totalTime;
      existing.averages[entry.noteIndex] = row.average;
      existing.counts[entry.noteIndex] = row.count;
      existing.p95s[entry.noteIndex] = row.p95;
      byTimingKey.set(key, existing);
    }
  }

  const focusTimingGrowth = [...byTimingKey.values()]
    .map((row) => {
      const totals = noteIndices.map((noteIndex) =>
        row.totalTimes[noteIndex] ?? 0
      );
      const averages = noteIndices.map((noteIndex) =>
        row.averages[noteIndex] ?? 0
      );
      const counts = noteIndices.map((noteIndex) => row.counts[noteIndex] ?? 0);
      const p95s = noteIndices.map((noteIndex) => row.p95s[noteIndex] ?? 0);
      return {
        logger: row.logger,
        key: row.key,
        totalTimes: totals,
        averages,
        counts,
        p95s,
        deltaLastVsFirst: Number(
          (
            (totals[totals.length - 1] ?? 0) -
            (totals[0] ?? 0)
          ).toFixed(3),
        ),
      };
    })
    .sort((a, b) =>
      b.deltaLastVsFirst - a.deltaLastVsFirst ||
      (b.totalTimes[b.totalTimes.length - 1] ?? 0) -
        (a.totalTimes[a.totalTimes.length - 1] ?? 0) ||
      `${a.logger}:${a.key}`.localeCompare(`${b.logger}:${b.key}`)
    );

  const lastEntry = series[series.length - 1];

  return {
    notes: series.map((entry) => ({
      noteIndex: entry.noteIndex,
      settleExecuteCalls: entry.settle.executeCalls,
      settleTotalDurationMs: entry.settle.totalDurationMs,
      settleMaxDurationMs: entry.settle.maxDurationMs,
      settleMaxIterations: entry.settle.maxIterations,
    })),
    focusTimingGrowth,
    focusTimingAtMaxNoteCount: lastEntry?.focusTiming ?? [],
    topTimingAtMaxNoteCount: lastEntry?.topTiming ?? [],
    settleAtMaxNoteCount: lastEntry?.settle ?? null,
  };
}

async function collectHomeLoadSummary(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const rt = globalThis.commonfabric?.rt;
    if (!rt?.getLoggerCounts || !rt?.getGraphSnapshot || !rt?.idle) return null;
    await rt.idle();

    const { timing } = await rt.getLoggerCounts();
    const graph = await rt.getGraphSnapshot();

    type TimingRow = {
      count: number;
      totalTime: number;
      average: number;
      p50: number;
      p95: number;
      max: number;
    };

    const schedulerTiming = (timing["scheduler"] ?? {}) as Record<
      string,
      TimingRow
    >;
    const topSchedulerTiming = Object.entries(schedulerTiming)
      .sort((a, b) => (b[1].totalTime ?? 0) - (a[1].totalTime ?? 0))
      .slice(0, 16)
      .map(([key, value]) => ({
        key,
        count: value.count ?? 0,
        totalTime: Number((value.totalTime ?? 0).toFixed(3)),
        average: Number((value.average ?? 0).toFixed(3)),
        p50: Number((value.p50 ?? 0).toFixed(3)),
        p95: Number((value.p95 ?? 0).toFixed(3)),
        max: Number((value.max ?? 0).toFixed(3)),
      }));

    type GraphNode = {
      id: string;
      type: "effect" | "computation" | "input" | "inactive";
      stats?: {
        runCount: number;
        totalTime: number;
        averageTime: number;
        lastRunTime: number;
      };
    };

    const typedNodes = graph.nodes as GraphNode[];
    const actionNodes = typedNodes.filter((node) =>
      (node.type === "effect" || node.type === "computation") && node.stats
    );
    const byActionId = new Map<string, {
      actionId: string;
      actionType: "effect" | "computation";
      runCount: number;
      totalTime: number;
      averageTime: number;
    }>();

    for (const node of actionNodes) {
      const stats = node.stats;
      if (!stats) continue;
      const actionType = node.type === "effect" ? "effect" : "computation";
      const existing = byActionId.get(node.id);
      if (!existing || stats.runCount > existing.runCount) {
        byActionId.set(node.id, {
          actionId: node.id,
          actionType,
          runCount: stats.runCount,
          totalTime: stats.totalTime,
          averageTime: stats.averageTime,
        });
      }
    }

    const topActions = [...byActionId.values()]
      .sort((a, b) =>
        b.runCount - a.runCount ||
        b.totalTime - a.totalTime ||
        a.actionId.localeCompare(b.actionId)
      )
      .slice(0, 20)
      .map((row) => ({
        actionId: row.actionId,
        actionType: row.actionType,
        runCount: row.runCount,
        totalTime: Number(row.totalTime.toFixed(3)),
        averageTime: Number(row.averageTime.toFixed(3)),
      }));

    return {
      graph: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        computations: typedNodes.filter((node) => node.type === "computation")
          .length,
        effects: typedNodes.filter((node) => node.type === "effect").length,
        inputs: typedNodes.filter((node) => node.type === "input").length,
        inactive: typedNodes.filter((node) => node.type === "inactive").length,
      },
      topSchedulerTiming,
      topActions,
    };
  });
}

async function collectNoteCreateProfile(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api?.getLoggerCounts || !api?.getSettleStatsHistory || !api?.idle) {
      return null;
    }

    await api.idle();

    type TimingRow = {
      count: number;
      totalTime: number;
      average: number;
      p50: number;
      p95: number;
      max: number;
    };

    const { timing } = await api.getLoggerCounts();
    const focusKeys = [
      ["scheduler", "scheduler/execute"],
      ["scheduler", "scheduler/execute/settle"],
      ["scheduler", "scheduler/execute/event"],
      ["scheduler", "scheduler/run"],
      ["scheduler", "scheduler/run/action"],
      ["scheduler", "scheduler/run/commit"],
      ["traverse", "traverse"],
      ["runner", "action/readInputs"],
      ["runner", "action/postRun"],
      ["runner", "action/populateDependencies"],
    ] as const;

    const focusTiming = focusKeys
      .map(([loggerName, key]) => {
        const row = (timing[loggerName] ?? {})[key] as TimingRow | undefined;
        if (!row) return null;
        return {
          logger: loggerName,
          key,
          count: row.count ?? 0,
          totalTime: Number((row.totalTime ?? 0).toFixed(3)),
          average: Number((row.average ?? 0).toFixed(3)),
          p50: Number((row.p50 ?? 0).toFixed(3)),
          p95: Number((row.p95 ?? 0).toFixed(3)),
          max: Number((row.max ?? 0).toFixed(3)),
        };
      })
      .filter((row) => row !== null);

    const topTiming = Object.entries(timing)
      .filter(([loggerName]) =>
        [
          "scheduler",
          "traverse",
          "storage.cache",
          "worker-reconciler",
          "runner",
        ].includes(loggerName)
      )
      .flatMap(([loggerName, rows]) =>
        Object.entries(rows as Record<string, TimingRow>).map(([key, row]) => ({
          logger: loggerName,
          key,
          count: row.count ?? 0,
          totalTime: Number((row.totalTime ?? 0).toFixed(3)),
          average: Number((row.average ?? 0).toFixed(3)),
          p50: Number((row.p50 ?? 0).toFixed(3)),
          p95: Number((row.p95 ?? 0).toFixed(3)),
          max: Number((row.max ?? 0).toFixed(3)),
        }))
      )
      .sort((a, b) =>
        b.totalTime - a.totalTime ||
        b.count - a.count ||
        `${a.logger}:${a.key}`.localeCompare(`${b.logger}:${b.key}`)
      )
      .slice(0, 20);

    type SettleHistoryEntry = {
      recordedAt: number;
      stats: {
        iterations: Array<{
          workSetSize: number;
          orderSize: number;
          actionsRun: number;
          durationMs: number;
        }>;
        totalDurationMs: number;
      };
    };

    const settleHistory = await api
      .getSettleStatsHistory() as SettleHistoryEntry[];
    const recentHistory = settleHistory.slice(-8);
    const settle = {
      executeCalls: settleHistory.length,
      totalDurationMs: Number(
        recentHistory.reduce(
          (sum, entry) => sum + entry.stats.totalDurationMs,
          0,
        )
          .toFixed(3),
      ),
      maxDurationMs: Number(
        Math.max(
          0,
          ...recentHistory.map((entry) => entry.stats.totalDurationMs),
        ).toFixed(3),
      ),
      latestDurationMs: Number(
        (recentHistory[recentHistory.length - 1]?.stats.totalDurationMs ?? 0)
          .toFixed(3),
      ),
      maxIterations: Math.max(
        0,
        ...recentHistory.map((entry) => entry.stats.iterations.length),
      ),
      latestIterations:
        recentHistory[recentHistory.length - 1]?.stats.iterations.length ?? 0,
      recent: recentHistory.map((entry) => ({
        totalDurationMs: Number(entry.stats.totalDurationMs.toFixed(3)),
        iterations: entry.stats.iterations.length,
        actionsRun: entry.stats.iterations.reduce(
          (sum, iteration) => sum + iteration.actionsRun,
          0,
        ),
      })),
    };

    return {
      focusTiming,
      topTiming,
      settle,
    };
  });
}

function compareHomeLoadSeries(series: unknown[]): unknown {
  const loads = series as Array<{
    noteCount: number;
    loadDurationMs: number;
    graph: {
      nodes: number;
      edges: number;
      computations: number;
      effects: number;
      inputs: number;
      inactive: number;
    };
    topSchedulerTiming: Array<{
      key: string;
      count: number;
      totalTime: number;
      average: number;
      p50: number;
      p95: number;
      max: number;
    }>;
    topActions: Array<{
      actionId: string;
      actionType: "effect" | "computation";
      runCount: number;
      totalTime: number;
      averageTime: number;
    }>;
  }>;

  const noteCounts = loads.map((load) => load.noteCount);
  const byTimingKey = new Map<string, {
    totals: Record<number, number>;
    counts: Record<number, number>;
  }>();
  const byActionId = new Map<string, {
    actionType: "effect" | "computation";
    runCounts: Record<number, number>;
    totalTimes: Record<number, number>;
  }>();

  for (const load of loads) {
    for (const row of load.topSchedulerTiming) {
      const existing = byTimingKey.get(row.key) ?? {
        totals: {},
        counts: {},
      };
      existing.totals[load.noteCount] = row.totalTime;
      existing.counts[load.noteCount] = row.count;
      byTimingKey.set(row.key, existing);
    }

    for (const row of load.topActions) {
      const existing = byActionId.get(row.actionId) ?? {
        actionType: row.actionType,
        runCounts: {},
        totalTimes: {},
      };
      existing.runCounts[load.noteCount] = row.runCount;
      existing.totalTimes[load.noteCount] = row.totalTime;
      byActionId.set(row.actionId, existing);
    }
  }

  const timingGrowth = [...byTimingKey.entries()]
    .map(([key, row]) => {
      const totals = noteCounts.map((noteCount) => row.totals[noteCount] ?? 0);
      const counts = noteCounts.map((noteCount) => row.counts[noteCount] ?? 0);
      return {
        key,
        totals,
        counts,
        deltaLastVsFirst: totals[totals.length - 1]! - totals[0]!,
      };
    })
    .sort((a, b) =>
      b.deltaLastVsFirst - a.deltaLastVsFirst ||
      (b.totals[b.totals.length - 1] ?? 0) -
        (a.totals[a.totals.length - 1] ?? 0) ||
      a.key.localeCompare(b.key)
    );

  const actionGrowth = [...byActionId.entries()]
    .map(([actionId, row]) => {
      const runCounts = noteCounts.map((noteCount) =>
        row.runCounts[noteCount] ?? 0
      );
      const totalTimes = noteCounts.map((noteCount) =>
        row.totalTimes[noteCount] ?? 0
      );
      return {
        actionId,
        actionType: row.actionType,
        runCounts,
        totalTimes,
        deltaLastVsFirst: runCounts[runCounts.length - 1]! - runCounts[0]!,
      };
    })
    .sort((a, b) =>
      b.deltaLastVsFirst - a.deltaLastVsFirst ||
      (b.runCounts[b.runCounts.length - 1] ?? 0) -
        (a.runCounts[a.runCounts.length - 1] ?? 0) ||
      a.actionId.localeCompare(b.actionId)
    );

  return {
    loads: loads.map((load) => ({
      noteCount: load.noteCount,
      loadDurationMs: load.loadDurationMs,
      graph: load.graph,
    })),
    loadDurationGrowth: {
      values: loads.map((load) => ({
        noteCount: load.noteCount,
        loadDurationMs: load.loadDurationMs,
      })),
      deltaLastVsFirst: Number(
        (
          (loads[loads.length - 1]?.loadDurationMs ?? 0) -
          (loads[0]?.loadDurationMs ?? 0)
        ).toFixed(3),
      ),
    },
    schedulerTimingGrowth: timingGrowth.filter((row) =>
      row.deltaLastVsFirst > 0
    )
      .slice(0, 20),
    actionRunGrowth: actionGrowth.filter((row) => row.deltaLastVsFirst > 0)
      .slice(0, 20),
    topLoadActionsAtMaxNoteCount: actionGrowth
      .sort((a, b) =>
        (b.runCounts[b.runCounts.length - 1] ?? 0) -
          (a.runCounts[a.runCounts.length - 1] ?? 0) ||
        a.actionId.localeCompare(b.actionId)
      )
      .slice(0, 20),
  };
}

async function collectCapturedConsoleLogs(
  page: Page,
  substring: string,
): Promise<unknown> {
  const logs = await page.evaluate(() => {
    const globalState = globalThis as typeof globalThis & {
      __cfCapturedConsoleLogs?: Array<{ method: string; text: string }>;
    };
    return globalState.__cfCapturedConsoleLogs ?? [];
  }) as Array<{ method: string; text: string }>;

  return logs
    .filter((entry) => entry.text.includes(substring))
    .slice(-80);
}

async function collectRunnerTriggerFlowCounts(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
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

async function collectWishFlowCounts(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api) return null;

    const { counts, timing } = await api.getLoggerCounts();
    const loggerCounts = counts["runner.wish-flow"];
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
        .slice(0, 16)
        .map(([key, value]) => ({
          key,
          total: value.total ?? 0,
          debug: value.debug ?? 0,
          info: value.info ?? 0,
          warn: value.warn ?? 0,
          error: value.error ?? 0,
        }));

    type TimingRow = {
      count: number;
      average: number;
      p50: number;
      p95: number;
      max: number;
      lastTime: number;
    };
    const timingRows = (timing["runner.wish-flow"] ?? {}) as Record<
      string,
      TimingRow
    >;
    const toTimingRows = (prefix: string) =>
      Object.entries(timingRows)
        .filter(([key]) => key.startsWith(prefix))
        .sort((a, b) => (b[1].average ?? 0) - (a[1].average ?? 0))
        .slice(0, 16)
        .map(([key, value]) => ({
          key,
          count: value.count ?? 0,
          average: Number((value.average ?? 0).toFixed(3)),
          p50: Number((value.p50 ?? 0).toFixed(3)),
          p95: Number((value.p95 ?? 0).toFixed(3)),
          max: Number((value.max ?? 0).toFixed(3)),
          lastTime: Number((value.lastTime ?? 0).toFixed(3)),
        }));

    return {
      start: toRows("wish/start/"),
      startSource: toRows("wish/start-source/"),
      resolve: toRows("wish/resolve/"),
      resolveSource: toRows("wish/resolve-source/"),
      resolveMs: toRows("wish/resolve-ms/"),
      searchHashtag: toRows("wish/search-hashtag/"),
      sync: toRows("wish/sync/"),
      syncSource: toRows("wish/sync-source/"),
      syncMs: toRows("wish/sync-ms/"),
      sendFast: toRows("wish/send-fast/"),
      sendFastSource: toRows("wish/send-fast-source/"),
      launchSuggestion: toRows("wish/launch-suggestion/"),
      runSuggestion: toRows("wish/run-suggestion/"),
      runSuggestionSource: toRows("wish/run-suggestion-source/"),
      errors: toRows("wish/error/"),
      freeform: toRows("wish/freeform/"),
      resolveTiming: toTimingRows("wish/resolve/"),
      resolveSourceTiming: toTimingRows("wish/resolve-source/"),
      syncTiming: toTimingRows("wish/sync/"),
      syncSourceTiming: toTimingRows("wish/sync-source/"),
    };
  });
}

async function collectSourceLocationSamples(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api) return null;

    const { flags } = await api.getLoggerCounts();
    const builderSamples =
      (flags["builder.source-location"]?.sample ?? {}) as Record<
        string,
        {
          raw?: string;
          frame?: { file?: string; line?: number; col?: number };
          mapped?: {
            source?: string | null;
            line?: number | null;
            column?: number | null;
            name?: string | null;
          } | null;
          parsedFrames?: Array<{
            index?: number;
            raw?: string;
            frame?: { file?: string; line?: number; col?: number };
          }>;
        }
      >;
    const runnerSamples =
      (flags["runner.source-location"]?.sample ?? {}) as Record<
        string,
        {
          name?: string;
          raw?: string;
          frame?: { file?: string; line?: number; col?: number };
          mapped?: {
            source?: string | null;
            line?: number | null;
            column?: number | null;
            name?: string | null;
          } | null;
          parsedFrames?: Array<{
            index?: number;
            raw?: string;
            frame?: { file?: string; line?: number; col?: number };
          }>;
        }
      >;

    const normalizeSamples = (
      samples: Record<
        string,
        {
          name?: string;
          raw?: string;
          frame?: { file?: string; line?: number; col?: number };
          mapped?: {
            source?: string | null;
            line?: number | null;
            column?: number | null;
            name?: string | null;
          } | null;
          parsedFrames?: Array<{
            index?: number;
            raw?: string;
            frame?: { file?: string; line?: number; col?: number };
          }>;
        }
      >,
    ) =>
      Object.entries(samples)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-12)
        .map(([id, sample]) => ({
          id,
          name: sample.name,
          raw: sample.raw,
          frame: sample.frame,
          mapped: sample.mapped,
          parsedFrames: sample.parsedFrames?.slice(0, 5),
        }));

    return {
      builder: normalizeSamples(builderSamples),
      runner: normalizeSamples(runnerSamples),
    };
  });
}

async function ensureCapturedConsole(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const globalState = globalThis as typeof globalThis & {
      __cfCapturedConsoleLogs?: Array<{ method: string; text: string }>;
      __cfConsolePatched?: boolean;
    };

    if (!globalState.__cfConsolePatched) {
      globalState.__cfCapturedConsoleLogs = [];
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
          globalState.__cfCapturedConsoleLogs?.push({ method, text });
          if ((globalState.__cfCapturedConsoleLogs?.length ?? 0) > 500) {
            globalState.__cfCapturedConsoleLogs?.splice(0, 100);
          }
          return original(...args);
        };
      }
      globalState.__cfConsolePatched = true;
    } else {
      globalState.__cfCapturedConsoleLogs = [];
    }

    return true;
  });
}

// Helper to find and click a button by text using piercing selectors
async function clickButtonWithText(
  page: Page,
  searchText: string,
): Promise<boolean> {
  try {
    // Search cf-button, button, and a elements with piercing selector
    const buttons = await page.$$("cf-button, button, a", {
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

async function clickPieceLinkWithText(
  page: Page,
  searchText: string,
): Promise<boolean> {
  try {
    const links = await page.$$(
      "#header-space, #header-space-link, .header-space, a",
      {
        strategy: "pierce",
      },
    );
    for (const link of links) {
      const text = await link.innerText();
      if (text?.trim().includes(searchText)) {
        await link.click();
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
  return (await collectNoteTitlesInList(page)).length > 0;
}

async function collectNoteTitlesInList(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(() => {
      const titles = new Set<string>();

      function search(root: Document | ShadowRoot): void {
        const allElements = root.querySelectorAll("*");
        for (const el of allElements) {
          const text = el.textContent;
          if (text) {
            for (
              const match of text.matchAll(/📝 New Note #[a-z0-9]+/g)
            ) {
              titles.add(match[0]);
            }
          }
          if (el.shadowRoot) {
            search(el.shadowRoot);
          }
        }
      }
      search(document);
      return [...titles].sort();
    });
  } catch (_) {
    return [];
  }
}
