import {
  awaitViewSettled,
  env,
  Page,
  type ProbeApi,
  waitFor,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { assert, assertEquals } from "@std/assert";
import {
  collectSchedulerLoadSummary,
  waitForActiveSpaceRoot,
  waitForRuntimeIdle,
  waitForRuntimeSynced,
} from "../cfc-browser-helpers.ts";
import { resolveSpaceDid } from "@commonfabric/lib-shell";

const { FRONTEND_URL } = env;
// Keep these as guardrails rather than exact budgets; CI reload runs vary
// slightly while still exercising persisted scheduler-state reuse.
const NOTEBOOK_RELOAD_TOTAL_ACTION_RUN_LIMIT = 150;
const NOTEBOOK_RELOAD_COMPUTATION_RUN_LIMIT = 90;
const NOTEBOOK_RELOAD_TIMEOUT_MS = 180_000;

const EXPECT_PERSISTENT_SCHEDULER_STATE = (() => {
  const raw = Deno.env.get("CF_EXPECT_PERSISTENT_SCHEDULER_STATE");
  return raw === "1" || raw === "true" || raw === "yes";
})();

describe("default-app notebook reload integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  // Re-enabled (CT-1623): map/flatmap/filter result containers (and nested
  // pattern result cells) are now identified by the reserved output spot — a
  // stable, position-derived identity — instead of the serialized `op` / inputs
  // cell, which dragged in the session-varying `program` and forced per-row
  // cell ids to churn across reloads. Persisted scheduler state now rehydrates,
  // dropping reload action runs well under this shard's budget (was ~167 > 150;
  // now ~80-95).
  it("reloads every rapidly created notebook note in a separate shard", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const notebookSpaceName = globalThis.crypto.randomUUID();
    const notebookSpaceDid = await resolveSpaceDid(
      identity,
      notebookSpaceName,
    );
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: notebookSpaceName },
      identity,
    });

    await waitForActiveSpaceRoot(page, notebookSpaceDid);
    await waitForRuntimeIdle(page);
    await clickButtonWithText(page, "Notes");
    await awaitViewSettled(page);
    await clickButtonWithText(page, "New Notebook");
    await waitForCondition(page, async () => {
      const commonfabric = globalThis.commonfabric as
        | { readCell?: (options: { id: string }) => Promise<unknown> }
        | undefined;
      const view = globalThis.app?.serialize?.()?.view;
      const pieceId = view && typeof view === "object" && "pieceId" in view &&
          typeof view.pieceId === "string"
        ? view.pieceId
        : undefined;
      if (!pieceId || !commonfabric?.readCell) return false;
      let current: unknown;
      const originalLog = console.log;
      try {
        console.log = () => {};
        current = await commonfabric.readCell({ id: pieceId });
      } finally {
        console.log = originalLog;
      }
      return (current as { isNotebook?: unknown } | undefined)
        ?.isNotebook === true;
    });

    await waitForCondition(
      page,
      () => typeof globalThis.commonfabric?.viewSettled === "function",
    );
    await awaitViewSettled(page);
    assert(
      await clickButtonWithTitle(page, "New Note"),
      "Expected New Note click to succeed",
    );
    await waitFor(async () => {
      await awaitViewSettled(page);
      return !!(await findButtonWithText(page, "Create Another"));
    });
    await waitFor(async () => await resetEventInvocationTrace(page));

    const noteCreates = 7;
    for (let i = 0; i < noteCreates - 1; i++) {
      assert(
        await clickButtonWithText(page, "Create Another"),
        `Expected Create Another click ${i + 1} to succeed`,
      );
    }
    assert(
      await clickButtonWithExactText(page, "Create"),
      "Expected final Create click to succeed",
    );

    await waitForCondition(page, notebookSourceStateMatches, {
      args: [noteCreates],
      timeout: NOTEBOOK_RELOAD_TIMEOUT_MS,
    });

    await waitForRuntimeSynced(page, { timeout: NOTEBOOK_RELOAD_TIMEOUT_MS });

    const startedAt = performance.now();
    await page.reload({ waitUntil: "load" });
    await page.applyConsoleFormatter();
    await shell.login(identity);

    await waitForCondition(page, notebookReloadRendered, {
      args: [noteCreates],
      timeout: NOTEBOOK_RELOAD_TIMEOUT_MS,
    });
    await waitForRuntimeIdle(page, { timeout: NOTEBOOK_RELOAD_TIMEOUT_MS });

    const reloadRenderState = await collectNotebookRenderState(page);
    assertEquals(reloadRenderState.noteCount, noteCreates);
    assertEquals(reloadRenderState.renderedNoteChips, noteCreates);
    const browserMetrics = await collectBrowserLoadMetrics(page);

    const schedulerSummary = await collectSchedulerLoadSummary(page);
    assert(
      schedulerSummary,
      "Expected notebook reload to expose scheduler load summary",
    );
    const reloadSummary = {
      reloadToRenderedMs: Number((performance.now() - startedAt).toFixed(3)),
      browser: browserMetrics,
      ...schedulerSummary,
    };
    console.log(
      "Notebook reload scheduler summary:",
      JSON.stringify(reloadSummary, null, 2),
    );

    if (!EXPECT_PERSISTENT_SCHEDULER_STATE) return;

    assert(
      schedulerSummary.graph.actionRuns <=
        NOTEBOOK_RELOAD_TOTAL_ACTION_RUN_LIMIT,
      `Expected notebook reload to stay within <= ${NOTEBOOK_RELOAD_TOTAL_ACTION_RUN_LIMIT} total action runs, saw ${schedulerSummary.graph.actionRuns}`,
    );
    assert(
      schedulerSummary.graph.computationRunsFromStats <=
        NOTEBOOK_RELOAD_COMPUTATION_RUN_LIMIT,
      `Expected notebook reload to reuse persisted scheduler state with <= ${NOTEBOOK_RELOAD_COMPUTATION_RUN_LIMIT} computation runs, saw ${schedulerSummary.graph.computationRunsFromStats}`,
    );
  });
});

// Captures real, user-perceived reload render timing — paint metrics
// (FCP/LCP = "time to pixel rendered"), long-task pressure, and a DOM
// quiet-period settle time — so reload perf is observable independently of
// scheduler action counts.
async function collectBrowserLoadMetrics(page: Page): Promise<{
  domContentLoadedEventEndMs?: number;
  loadEventEndMs?: number;
  firstPaintMs?: number;
  firstContentfulPaintMs?: number;
  largestContentfulPaintMs?: number;
  longTaskCount?: number;
  longTaskTotalMs?: number;
  postRenderStableMs: number;
}> {
  return await page.evaluate(async () => {
    const round = (value: number | undefined) =>
      value === undefined ? undefined : Number(value.toFixed(3));
    const supported = PerformanceObserver.supportedEntryTypes ?? [];
    const observeBuffered = async (type: string) => {
      if (!supported.includes(type)) return [] as PerformanceEntry[];
      const entries: PerformanceEntry[] = [];
      const observer = new PerformanceObserver((list) => {
        entries.push(...list.getEntries());
      });
      observer.observe({ type, buffered: true });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      observer.disconnect();
      return entries;
    };

    const navigation = performance.getEntriesByType("navigation")
      .at(-1) as PerformanceNavigationTiming | undefined;
    const paint = performance.getEntriesByType("paint");
    const firstPaint = paint.find((entry) => entry.name === "first-paint");
    const firstContentfulPaint = paint.find((entry) =>
      entry.name === "first-contentful-paint"
    );
    const largestContentfulPaint = (await observeBuffered(
      "largest-contentful-paint",
    )).at(-1);
    const longTasks = await observeBuffered("longtask");

    const postRenderStableMs = await new Promise<number>((resolve) => {
      let settled = false;
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (settled) return;
        settled = true;
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        observer.disconnect();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(performance.now()))
        );
      };
      const resetQuietTimer = () => {
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        quietTimer = setTimeout(done, 100);
      };
      const observer = new MutationObserver(resetQuietTimer);
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      resetQuietTimer();
      const maxTimer = setTimeout(done, 1_000);
    });

    return {
      domContentLoadedEventEndMs: round(navigation?.domContentLoadedEventEnd),
      loadEventEndMs: round(navigation?.loadEventEnd),
      firstPaintMs: round(firstPaint?.startTime),
      firstContentfulPaintMs: round(firstContentfulPaint?.startTime),
      largestContentfulPaintMs: round(largestContentfulPaint?.startTime),
      longTaskCount: longTasks.length,
      longTaskTotalMs: round(
        longTasks.reduce((sum, entry) => sum + entry.duration, 0),
      ),
      postRenderStableMs: round(postRenderStableMs)!,
    };
  });
}

async function resetEventInvocationTrace(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric as {
      rt?: {
        setTelemetryEnabled?: (enabled: boolean) => Promise<void>;
        on?: (event: string, handler: (marker: unknown) => void) => void;
        off?: (event: string, handler: (marker: unknown) => void) => void;
        idle?: () => Promise<void>;
      };
      __eventInvocationTrace?: unknown[];
      __eventInvocationTraceHandler?: (marker: unknown) => void;
    } | undefined;
    const rt = api?.rt;
    if (!api || !rt?.setTelemetryEnabled || !rt.on || !rt.off) return false;

    if (api.__eventInvocationTraceHandler) {
      rt.off("telemetry", api.__eventInvocationTraceHandler);
    }

    api.__eventInvocationTrace = [];
    api.__eventInvocationTraceHandler = (marker: unknown) => {
      const type = marker && typeof marker === "object"
        ? (marker as { type?: unknown }).type
        : undefined;
      if (
        type === "scheduler.invocation" ||
        type === "scheduler.event.commit" ||
        type === "scheduler.event.preflight"
      ) {
        api.__eventInvocationTrace?.push(marker);
      }
    };
    rt.on("telemetry", api.__eventInvocationTraceHandler);
    await rt.setTelemetryEnabled(true);
    await rt.idle?.();
    return true;
  });
}

// Serialized into the page by waitForCondition: drain the worker, read the
// notebook's argument and internal cells, and report whether the rapidly
// created notes have all landed — `expectedCount` notes present, the new-note
// prompt closed, and the "create another" flag cleared. Inlines the collection
// that collectNotebookSourceState performs (including its runtime idle) so the
// wait resolves the instant the source state converges rather than on a poll.
const notebookSourceStateMatches = async (
  _probe: ProbeApi,
  expectedCount: number,
): Promise<boolean> => {
  const api = globalThis.commonfabric as {
    rt?: { idle?: () => Promise<void> };
    readCell?: (options: {
      id: string;
      path?: string[];
      meta?: "argument" | "internal";
    }) => Promise<unknown>;
  } | undefined;
  await api?.rt?.idle?.();

  const view = globalThis.app?.serialize?.()?.view;
  const notebookEntityId = view && typeof view === "object" &&
      "pieceId" in view && typeof view.pieceId === "string"
    ? view.pieceId
    : undefined;
  if (!notebookEntityId || !api?.readCell) return false;

  const resolveInternalManifest = async (
    manifest: unknown,
  ): Promise<Record<string, unknown>> => {
    const resolved: Record<string, unknown> = {};
    if (!Array.isArray(manifest)) return resolved;
    for (const entry of manifest) {
      if (entry === null || typeof entry !== "object") continue;
      const { partialCause, link } = entry as {
        partialCause?: unknown;
        link?: { sync?: () => Promise<unknown> };
      };
      const key = typeof partialCause === "string"
        ? partialCause
        : JSON.stringify(partialCause) ?? String(partialCause);
      if (link && typeof link.sync === "function") {
        resolved[key] = await link.sync();
      }
    }
    return resolved;
  };

  let notebookArgument: unknown;
  let notebookInternalManifest: unknown;
  const originalLog = console.log;
  try {
    console.log = () => {};
    notebookArgument = await api.readCell({
      id: notebookEntityId,
      meta: "argument",
    });
    notebookInternalManifest = await api.readCell({
      id: notebookEntityId,
      meta: "internal",
    });
  } finally {
    console.log = originalLog;
  }
  const notebookInternal = await resolveInternalManifest(
    notebookInternalManifest,
  );

  const argumentNotes = (notebookArgument as { notes?: unknown[] } | undefined)
    ?.notes;
  const argumentNotesLength = Array.isArray(argumentNotes)
    ? argumentNotes.length
    : undefined;
  const internal = notebookInternal as {
    noteCount?: unknown;
    showNewNotePrompt?: unknown;
    usedCreateAnotherNote?: unknown;
  };
  return argumentNotesLength === expectedCount &&
    internal.noteCount === expectedCount &&
    internal.showNewNotePrompt === false &&
    internal.usedCreateAnotherNote === false;
};

// Serialized into the page by waitForCondition: report whether the reloaded
// notebook has rehydrated to `expectedCount` notes — the piece cell reads back
// as a notebook with that noteCount, and that many "📝 New Note" chips are
// rendered across the document and every shadow root. Inlines the readCell and
// cf-chip collection that collectNotebookRenderState performs.
const notebookReloadRendered = async (
  probe: ProbeApi,
  expectedCount: number,
): Promise<boolean> => {
  const commonfabric = globalThis.commonfabric as
    | { readCell?: (options: { id: string }) => Promise<unknown> }
    | undefined;
  const view = globalThis.app?.serialize?.()?.view;
  const pieceId = view && typeof view === "object" && "pieceId" in view &&
      typeof view.pieceId === "string"
    ? view.pieceId
    : undefined;
  if (!pieceId || !commonfabric?.readCell) return false;
  let current: { isNotebook?: unknown; noteCount?: unknown } | undefined;
  const originalLog = console.log;
  try {
    console.log = () => {};
    current = await commonfabric.readCell({ id: pieceId }) as typeof current;
  } finally {
    console.log = originalLog;
  }
  if (current?.isNotebook !== true || current.noteCount !== expectedCount) {
    return false;
  }
  const renderedNoteChips = probe.collect("cf-chip").filter((element) => {
    const label = String(
      (element as { label?: unknown }).label ??
        element.getAttribute("label") ?? "",
    ).trim();
    return label.startsWith("📝 New Note");
  }).length;
  return renderedNoteChips === expectedCount;
};

// Marker attribute a click predicate stamps on the button it resolved, so the
// test can then resolve that exact element and dispatch a single trusted click
// on it. Mirrors the CLICK_TARGET_ATTR flow of clickCfButton in
// cfc-browser-helpers.ts.
const NOTE_BUTTON_CLICK_TARGET_ATTR = "data-cfc-note-button-target";

// Serialized into the page by waitForCondition: find the first rendered
// button/link whose text or title matches, scroll it into view, and stamp its
// inner click target with `token`. "Rendered" means laid out and not
// display:none/visibility:hidden — the same elements the innerText scan the
// poll used could see — and is viewport-independent, so a match below the fold
// is scrolled in rather than skipped. Returns false until a match exists, so
// the wait re-checks on the next DOM mutation instead of the caller retrying a
// bare find-and-click loop.
const markNoteButton = async (
  probe: ProbeApi,
  selector: string,
  match: "includes" | "exact" | "title",
  needle: string,
  token: string,
  attr: string,
): Promise<boolean> => {
  const isRendered = (element: Element): boolean => {
    const style = globalThis.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const target = probe.collect(selector).find((element) => {
    if (!isRendered(element)) return false;
    if (match === "title") return element.getAttribute("title") === needle;
    const text = (element.textContent ?? "").trim();
    return match === "exact" ? text === needle : text.includes(needle);
  }) as HTMLElement | undefined;
  if (!target) return false;
  target.scrollIntoView({ block: "center", inline: "center" });
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );
  const clickTarget = (target.shadowRoot?.querySelector("[data-cf-button]") as
    | HTMLElement
    | null) ?? target;
  if (!clickTarget.isConnected || !isRendered(clickTarget)) return false;
  clickTarget.setAttribute(attr, token);
  return true;
};

// Remove every element carrying `attr=token`, descending through shadow roots.
async function clearNoteButtonMark(
  page: Page,
  token: string,
): Promise<void> {
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
  }, { args: [token, NOTE_BUTTON_CLICK_TARGET_ATTR] }).catch(() => {});
}

// Wait for a matching button to be present and interactive, then dispatch a
// single trusted click on it. Throws if no matching button becomes clickable.
async function settleAndClickNoteButton(
  page: Page,
  selector: string,
  match: "includes" | "exact" | "title",
  needle: string,
): Promise<void> {
  const markTarget = async (token: string) => {
    await waitForCondition(page, markNoteButton, {
      args: [selector, match, needle, token, NOTE_BUTTON_CLICK_TARGET_ATTR],
    });
  };

  let token = `cfc-note-button-${crypto.randomUUID()}`;
  try {
    await markTarget(token);
  } catch (cause) {
    throw new Error(
      `Unable to find a ${
        match === "title" ? "button titled" : "button matching"
      } "${needle}" to click`,
      { cause },
    );
  }

  let lastCause: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const clickTarget = await page.waitForSelector(
        `[${NOTE_BUTTON_CLICK_TARGET_ATTR}="${token}"]`,
        { strategy: "pierce" },
      );
      await clickTarget.click();
      return;
    } catch (cause) {
      lastCause = cause;
      const retryable = cause instanceof Error &&
        cause.message.includes("stable box model");
      if (!retryable || attempt === 2) break;
    } finally {
      await clearNoteButtonMark(page, token);
    }

    // A root-pattern hot swap can replace the marked button after discovery
    // but before Astral resolves its box. Re-mark the current rendered node and
    // retry the coordinate click; only the successful attempt dispatches.
    token = `cfc-note-button-${crypto.randomUUID()}`;
    await markTarget(token);
  }

  throw new Error(`Unable to click the stable "${needle}" button`, {
    cause: lastCause,
  });
}

// The click helpers resolve `true` once the single click has landed (they throw
// otherwise), so the call sites that assert the click succeeded keep reading.
async function clickButtonWithText(
  page: Page,
  searchText: string,
): Promise<boolean> {
  await settleAndClickNoteButton(
    page,
    "cf-button, button, a",
    "includes",
    searchText,
  );
  return true;
}

async function clickButtonWithExactText(
  page: Page,
  searchText: string,
): Promise<boolean> {
  await settleAndClickNoteButton(
    page,
    "cf-button, button, a",
    "exact",
    searchText,
  );
  return true;
}

async function clickButtonWithTitle(
  page: Page,
  title: string,
): Promise<boolean> {
  await settleAndClickNoteButton(page, "cf-button, button", "title", title);
  return true;
}

async function findButtonWithText(
  page: Page,
  searchText: string,
): Promise<any | null> {
  try {
    const buttons = await page.$$("cf-button, button, a", {
      strategy: "pierce",
    });
    for (const button of buttons) {
      const text = await button.innerText();
      if (text?.trim().includes(searchText)) return button;
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function collectNotebookRenderState(page: Page): Promise<{
  isNotebook: boolean;
  noteCount: number;
  notesLength: number;
  mentionableLength: number;
  showNewNotePrompt?: boolean;
  usedCreateAnotherNote?: boolean;
  storedUiNoteChips: number;
  storedUiNoteLabels: string[];
  renderedNoteChips: number;
  renderedNoteLabels: string[];
}> {
  return await page.evaluate(async () => {
    const commonfabric = globalThis.commonfabric as any;
    const appState = globalThis.app?.serialize?.();
    const view = appState?.view;
    const pieceId = view && typeof view === "object" && "pieceId" in view &&
        typeof view.pieceId === "string"
      ? view.pieceId
      : undefined;
    let current: any;
    if (pieceId) {
      const originalLog = console.log;
      try {
        console.log = () => {};
        current = await commonfabric?.readCell?.({ id: pieceId });
      } finally {
        console.log = originalLog;
      }
    }
    const notes = Array.isArray(current?.notes) ? current.notes : [];
    const mentionable = Array.isArray(current?.mentionable)
      ? current.mentionable
      : [];
    const collectStoredNoteLabels = (value: unknown) => {
      const labels: string[] = [];
      const seen = new WeakSet<object>();

      function visit(currentValue: unknown): void {
        if (currentValue === null || currentValue === undefined) return;
        if (typeof currentValue !== "object") return;
        if (seen.has(currentValue)) return;
        seen.add(currentValue);

        const record = currentValue as Record<string, unknown>;
        const label = typeof record.label === "string"
          ? record.label
          : typeof (record.props as { label?: unknown } | undefined)?.label ===
              "string"
          ? (record.props as { label: string }).label
          : undefined;
        if (label?.trim().startsWith("📝 New Note")) {
          labels.push(label.trim());
        }

        if (Array.isArray(currentValue)) {
          for (const item of currentValue) visit(item);
          return;
        }
        for (const item of Object.values(record)) visit(item);
      }

      visit(value);
      return labels;
    };
    const collectRenderedNoteLabels = (root: Document | ShadowRoot) => {
      const labels: string[] = [];

      function collect(currentRoot: Document | ShadowRoot): void {
        for (const el of currentRoot.querySelectorAll("*")) {
          if (el.localName === "cf-chip") {
            const label = ((el as any).label ?? el.getAttribute("label") ?? "")
              .trim();
            if (label.startsWith("📝 New Note")) {
              labels.push(label);
            }
          }
          if ((el as HTMLElement).shadowRoot) {
            collect((el as HTMLElement).shadowRoot!);
          }
        }
      }

      collect(root);
      return labels;
    };
    const noteLabels = collectRenderedNoteLabels(document);
    const storedUiNoteLabels = collectStoredNoteLabels(current?.["$UI"]);

    return {
      isNotebook: current?.isNotebook === true,
      noteCount: typeof current?.noteCount === "number"
        ? current.noteCount
        : -1,
      notesLength: notes.length,
      mentionableLength: mentionable.length,
      showNewNotePrompt: typeof current?.showNewNotePrompt === "boolean"
        ? current.showNewNotePrompt
        : undefined,
      usedCreateAnotherNote: typeof current?.usedCreateAnotherNote === "boolean"
        ? current.usedCreateAnotherNote
        : undefined,
      storedUiNoteChips: storedUiNoteLabels.length,
      storedUiNoteLabels,
      renderedNoteChips: noteLabels.length,
      renderedNoteLabels: noteLabels,
    };
  });
}
