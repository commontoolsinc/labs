import {
  awaitViewSettled,
  Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { toIndentedDebugString } from "@commonfabric/data-model/value-debug";

const DEFAULT_CFC_BROWSER_TIMEOUT = 30_000;
const CLICK_TARGET_ATTR = "data-cfc-click-target";

// Predicates evaluated in the page by `waitForCondition`. Each is self-contained
// — it closes over nothing in this module — so it can be serialized and run in
// the page. `probe` is the shadow-piercing DOM helper set; later parameters are
// the `args` passed alongside the predicate.

const textPresent = (
  probe: ProbeApi,
  selector: string,
  text: string,
): boolean =>
  probe.collect(selector).some((element) =>
    probe.deepText(element).includes(text)
  );

const textAbsent = (
  probe: ProbeApi,
  selector: string,
  text: string,
): boolean =>
  !probe.collect(selector).some((element) =>
    probe.deepText(element).includes(text)
  );

const buttonDisabledIs = (
  probe: ProbeApi,
  selector: string,
  disabled: boolean,
): boolean => {
  const element = probe.collect(selector)[0];
  if (!element) return false;
  const button = element instanceof HTMLButtonElement
    ? element
    : element.shadowRoot?.querySelector("button");
  return button instanceof HTMLButtonElement
    ? button.disabled === disabled
    : false;
};

const runtimeIdle = async (): Promise<boolean> => {
  const rt = (globalThis as typeof globalThis & {
    commonfabric?: { rt?: { idle?: () => Promise<void> } };
  }).commonfabric?.rt;
  if (!rt?.idle) return false;
  await rt.idle();
  return true;
};

const runtimeSynced = async (): Promise<boolean> => {
  const rt = (globalThis as typeof globalThis & {
    commonfabric?: { rt?: { allSynced?: () => Promise<void> } };
  }).commonfabric?.rt;
  if (!rt?.allSynced) return false;
  await rt.allSynced();
  return true;
};

const viewSettledReady = (): boolean =>
  typeof (globalThis as typeof globalThis & {
    commonfabric?: { viewSettled?: () => Promise<void> };
  }).commonfabric?.viewSettled === "function";

// Fill the input behind `selector`, then report whether the value took. Mirrors
// the prior poll predicate: a not-yet-ready field (absent, hidden, disabled,
// read-only) reports false without dispatching anything, so a re-check on the
// next DOM mutation retries the fill; a ready field is filled once and verified.
const fillAndVerify = async (
  probe: ProbeApi,
  selector: string,
  nextValue: string,
): Promise<boolean> => {
  const element = probe.collect(selector)[0];
  if (!element) return false;
  const input = element instanceof HTMLInputElement
    ? element
    : element.shadowRoot?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) return false;

  input.scrollIntoView({ block: "center", inline: "center" });
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );
  if (!probe.isVisible(input) || input.disabled || input.readOnly) {
    return false;
  }

  const root = input.getRootNode();
  const host = root instanceof ShadowRoot ? root.host : element;
  // The host component owns durably committing a typed edit. A cf-input two-way
  // bound to a Cell flushes the value into the cell and awaits the runtime
  // round-trip via commit(); a field with no cell (cf-submit-input) exposes no
  // commit() and its DOM value is authoritative. Drive the DOM like a user and
  // then ask the host to commit, rather than reaching into the cell.
  const hostElement = host as Element & {
    commit?: () => Promise<void>;
    requestUpdate?: () => void | Promise<void>;
  };

  input.focus();
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (valueSetter) valueSetter.call(input, nextValue);
  else input.value = nextValue;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  input.blur();

  // Ask the host to flush and durably commit the typed value (a no-op for
  // fields not bound to a cell), then re-render so the inner input reflects the
  // committed value before we read it back.
  await hostElement.commit?.();
  await hostElement.requestUpdate?.();
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );

  return input.value === nextValue;
};

// Scroll the cf-button behind `selector` into view and tag its inner click
// target so the test can resolve and click exactly that element.
const markForClick = async (
  probe: ProbeApi,
  selector: string,
  token: string,
  attr: string,
): Promise<boolean> => {
  const target = probe.collect(selector)[0] as HTMLElement | undefined;
  if (!target) return false;
  target.scrollIntoView({ block: "center", inline: "center" });
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );
  const clickTarget = (target.shadowRoot?.querySelector("[data-cf-button]") as
    | HTMLElement
    | null) ?? target;
  clickTarget.setAttribute(attr, token);
  return true;
};

// Tag the first visible, enabled element carrying `data-ui-action="<action>"`
// for a single trusted click, and record the next click's provenance so a
// failure can show whether the dispatch was trusted and where it landed.
const markTrustedAction = async (
  probe: ProbeApi,
  action: string,
  token: string,
  attr: string,
): Promise<boolean> => {
  const isDisabled = (element: HTMLElement): boolean =>
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true";

  for (const element of probe.collect(`[data-ui-action="${action}"]`)) {
    const target = element as HTMLElement;
    target.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
    const clickTarget = (target.shadowRoot?.querySelector("[data-cf-button]") as
      | HTMLElement
      | null) ?? target;
    if (
      probe.isVisible(target) && probe.isVisible(clickTarget) &&
      !isDisabled(target) && !isDisabled(clickTarget)
    ) {
      clickTarget.setAttribute(attr, token);
      clickTarget.addEventListener(
        "click",
        (event) => {
          (globalThis as typeof globalThis & {
            __lastCfcTrustedActionClick?: TrustedActionProbe["lastClick"];
          }).__lastCfcTrustedActionClick = {
            trusted: event.isTrusted,
            path: event.composedPath().flatMap((node) => {
              if (!(node instanceof HTMLElement)) return [];
              const dataset: Record<string, string> = {};
              for (const key in node.dataset) {
                dataset[key] = node.dataset[key] ?? "";
              }
              return [{
                tagName: node.tagName.toLowerCase(),
                id: node.id,
                dataset,
              }];
            }),
          };
        },
        { capture: true, once: true },
      );
      return true;
    }
  }
  return false;
};

// Resolve once the shell's reactive view has caught up to runtime state and is
// interactive, so a click lands on a bound handler. Waits for the shell to
// expose `viewSettled` (notification-driven), then awaits the settle.
async function settleView(
  page: Page,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
): Promise<void> {
  await waitForCondition(page, viewSettledReady, { timeout });
  await awaitViewSettled(page);
}

/**
 * Wait for `selector` to contain `text` after a stimulus has been dispatched,
 * driving the shell to settle between checks and resolving the instant the text
 * appears.
 *
 * A freshly dispatched click's effect reaches the DOM only once the worker→main
 * pipeline runs: the worker settles the reactive graph, pushes a vdom batch,
 * the main thread applies it, and Lit drains its updates. `awaitViewSettled`
 * pumps that pipeline. An integration test holds no UI subscription, so nothing
 * else pumps it — a purely passive wait can sit on a DOM that never changes and
 * time out even though the effect is ready to apply.
 *
 * Each iteration awaits one full view settle, then re-checks. The settle is the
 * re-evaluation trigger — real asynchronous work (a worker idle round-trip plus
 * a drained Lit cycle), not a fixed-interval sleep — so the effect is observed
 * within a settle cycle or two and the wait resolves immediately once it holds.
 * The settle must be driven from the same call sequence as the check; running
 * it concurrently with a separate waiter does not help, because the astral CDP
 * connection serializes evaluations.
 */
async function waitForTextWhileSettling(
  page: Page,
  selector: string,
  text: string,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  if (await textIsPresent(page, selector, text)) return;
  do {
    await awaitViewSettled(page);
    if (await textIsPresent(page, selector, text)) return;
  } while (Date.now() < deadline);
  throw new Error(
    `"${selector}" did not contain "${text}" within ${timeout}ms`,
  );
}

export async function clickTrustedAction(
  page: Page,
  action: string,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  const token = `trusted-action-${crypto.randomUUID()}`;
  let probe: TrustedActionProbe | undefined;
  try {
    // Wait until a visible, enabled instance of the action can be marked, then
    // click it exactly once. Marking attaches the provenance listener, so the
    // single click is the trusted dispatch we record.
    await waitForCondition(page, markTrustedAction, {
      timeout,
      args: [action, token, CLICK_TARGET_ATTR],
    });
    const button = await page.waitForSelector(
      `[${CLICK_TARGET_ATTR}="${token}"]`,
      { strategy: "pierce", timeout },
    );
    await button.click();
  } catch (cause) {
    probe ??= await readTrustedActionProbe(page, action).catch(() => undefined);
    // Indented for readable test-log output
    throw new Error(
      `Timed out clicking trusted action "${action}". Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  } finally {
    await clearTrustedActionMark(page, token).catch(() => {});
  }
}

export async function clickTrustedActionAndWaitForText(
  page: Page,
  action: string,
  selector: string,
  text: string,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  // Single timeout budget shared across the fast path, settle, click, and the
  // wait for the effect.
  const deadline = Date.now() + timeout;
  const remaining = () => Math.max(1, deadline - Date.now());

  let actionProbe: TrustedActionProbe | undefined;
  let textProbe: TextProbe | undefined;

  // Fast path: the effect may already be present (idempotent re-entry).
  if (await textIsPresent(page, selector, text)) {
    return;
  }

  // Settle the view BEFORE dispatching, then click the trusted action exactly
  // ONCE. Settling first means the action's handler is bound when the single
  // trusted click lands; re-dispatching on a later tick is what double-fires
  // and corrupts the event provenance, so we never re-click.
  try {
    await settleView(page, { timeout: remaining() });
    await clickTrustedAction(page, action, { timeout: remaining() });
  } catch (cause) {
    actionProbe = await readTrustedActionProbe(page, action).catch(() =>
      undefined
    );
    textProbe = await readTextProbe(page, selector).catch(() => undefined);
    throw new Error(
      `Failed to click trusted action "${action}" while waiting for "${selector}" to contain "${text}". Last probes: ${
        toIndentedDebugString({ actionProbe, textProbe })
      }`,
      { cause },
    );
  }

  // The click is delivered; wait for its effect, resolving the instant the
  // text appears while driving the settle that applies it. No re-clicking — an
  // optimistic perUser/perSpace write whose chip trails the commit is caught by
  // the same wait.
  try {
    await waitForTextWhileSettling(page, selector, text, {
      timeout: remaining(),
    });
  } catch (cause) {
    actionProbe ??= await readTrustedActionProbe(page, action).catch(() =>
      undefined
    );
    textProbe = await readTextProbe(page, selector).catch(() => undefined);
    throw new Error(
      `Timed out clicking trusted action "${action}" until "${selector}" contained "${text}". Last probes: ${
        toIndentedDebugString({ actionProbe, textProbe })
      }`,
      { cause },
    );
  }
}

export async function waitForText(
  page: Page,
  selector: string,
  text: string,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  try {
    await waitForCondition(page, textPresent, {
      timeout,
      args: [selector, text],
    });
  } catch (cause) {
    const probe = await readTextProbe(page, selector).catch(() => undefined);
    throw new Error(
      `Timed out waiting for "${selector}" to contain "${text}". Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  }
}

export async function waitForTextAbsent(
  page: Page,
  selector: string,
  text: string,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  try {
    await waitForCondition(page, textAbsent, {
      timeout,
      args: [selector, text],
    });
  } catch (cause) {
    const probe = await readTextProbe(page, selector).catch(() => undefined);
    throw new Error(
      `Timed out waiting for "${selector}" not to contain "${text}". Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  }
}

export async function fillCfInput(
  page: Page,
  selector: string,
  value: string,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  try {
    await waitForCondition(page, fillAndVerify, {
      timeout,
      args: [selector, value],
    });
  } catch (cause) {
    const probe = await readCfInputProbe(page, selector).catch(() => undefined);
    throw new Error(
      `Timed out filling cf input "${selector}" with "${value}". Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  }
}

/**
 * Read the current value of a cf-input's inner input element. Throws when the
 * selector does not resolve to an actual input, so an absent control cannot
 * masquerade as an empty value in assertions.
 */
export async function readCfInputValue(
  page: Page,
  selector: string,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
): Promise<string> {
  const field = await page.waitForSelector(selector, {
    strategy: "pierce",
    timeout,
  });
  const probe = await field.evaluate(
    (element: Element): { found: boolean; value: string } => {
      const input = element instanceof HTMLInputElement
        ? element
        : element.shadowRoot?.querySelector("input");
      return input instanceof HTMLInputElement
        ? { found: true, value: input.value }
        : { found: false, value: "" };
    },
  );
  if (!probe.found) {
    throw new Error(`"${selector}" did not resolve to an input element`);
  }
  return probe.value;
}

export async function waitForRuntimeIdle(
  page: Page,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  await waitForCondition(page, runtimeIdle, { timeout });
}

export async function waitForDisabled(
  page: Page,
  selector: string,
  disabled: boolean,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  try {
    await waitForCondition(page, buttonDisabledIs, {
      timeout,
      args: [selector, disabled],
    });
  } catch (cause) {
    const probe = await readDisabledProbe(page, selector).catch(() =>
      undefined
    );
    throw new Error(
      `Timed out waiting for ${selector} disabled=${disabled}. Last probe: ${
        toIndentedDebugString(probe)
      }`,
      { cause },
    );
  }
}

export async function clickCfButton(
  page: Page,
  selector: string,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  const token = `cf-button-${crypto.randomUUID()}`;
  try {
    // Wait until the button exists, then mark its inner click target exactly
    // once; the mark is the predicate, so the re-check on each DOM mutation
    // retries finding the button without re-clicking anything.
    await waitForCondition(page, markForClick, {
      timeout,
      args: [selector, token, CLICK_TARGET_ATTR],
    });
  } catch (cause) {
    throw new Error(`Unable to mark ${selector} for click`, { cause });
  }
  try {
    const clickTarget = await page.waitForSelector(
      `[${CLICK_TARGET_ATTR}="${token}"]`,
      {
        strategy: "pierce",
        timeout,
      },
    );
    await clickTarget.click();
  } finally {
    await page.evaluate((targetToken, targetAttr) => {
      function collect(
        root: Document | ShadowRoot,
        result: Element[],
      ): void {
        for (const element of root.querySelectorAll("*")) {
          if (element.getAttribute(targetAttr) === targetToken) {
            result.push(element);
          }
          if (element.shadowRoot) {
            collect(element.shadowRoot, result);
          }
        }
      }

      const matches: Element[] = [];
      collect(document, matches);
      for (const element of matches) {
        element.removeAttribute(targetAttr);
      }
    }, { args: [token, CLICK_TARGET_ATTR] }).catch(() => {});
  }
}

export async function clickCfButtonAndWaitForText(
  page: Page,
  buttonSelector: string,
  textSelector: string,
  text: string,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  // Single timeout budget shared across settle, click, and wait-for-effect.
  const deadline = Date.now() + timeout;
  const remaining = () => Math.max(1, deadline - Date.now());

  let textProbe: TextProbe | undefined;

  // Fast path: the effect may already be present (idempotent re-entry).
  if (await textIsPresent(page, textSelector, text)) {
    return;
  }

  // Settle the view BEFORE clicking, then click exactly ONCE. settleView
  // resolves only once the worker is idle, the vdom batch has been applied to
  // the main thread, and Lit updates have drained — i.e. the button's handler
  // is actually bound. A single settled click is delivered to a live handler,
  // so we never re-click: re-clicking a freshly-rendered control is racy (it
  // can double-fire, and against a dismissable overlay the repeat clicks
  // dismiss it). See docs/development/UI_TESTING.md.
  try {
    await settleView(page, { timeout: remaining() });
    await clickCfButton(page, buttonSelector, { timeout: remaining() });
  } catch (cause) {
    textProbe = await readTextProbe(page, textSelector).catch(() => undefined);
    throw new Error(
      `Failed to click "${buttonSelector}" while waiting for "${textSelector}" to contain "${text}". Last probe: ${
        toIndentedDebugString(textProbe)
      }`,
      { cause },
    );
  }

  // The click is delivered; wait for its effect, resolving the instant the text
  // appears while driving the settle that applies it. An effect that renders a
  // few cycles after the click — including an optimistic perUser/perSpace write
  // whose chip trails the commit — is captured without ever re-clicking.
  try {
    await waitForTextWhileSettling(page, textSelector, text, {
      timeout: remaining(),
    });
  } catch (cause) {
    textProbe = await readTextProbe(page, textSelector).catch(() => undefined);
    throw new Error(
      `Timed out clicking "${buttonSelector}" until "${textSelector}" contained "${text}". Last probe: ${
        toIndentedDebugString(textProbe)
      }`,
      { cause },
    );
  }
}

export async function waitForRuntimeSynced(
  page: Page,
  { timeout = DEFAULT_CFC_BROWSER_TIMEOUT }: { timeout?: number } = {},
) {
  // Quiescence isn't a per-space question: allSynced awaits every space the
  // worker has opened.
  await waitForCondition(page, runtimeSynced, { timeout });
}

export type SchedulerLoadSummary = {
  /** Scheduler-state rehydration health on (re)load. */
  rehydration: {
    ok: number;
    missNoSnapshot: number;
    missActionId: number;
    missFingerprint: number;
    skipShouldNotApply: number;
    fallbackRunNoMatch: number;
    fallbackRunTimeout: number;
  };
  graph: {
    nodes: number;
    edges: number;
    computations: number;
    effects: number;
    inputs: number;
    inactive: number;
    actionsWithStats: number;
    actionRuns: number;
    actionRunsThroughActionBody: number;
    actionRunsFromStats: number;
    actionTotalTimeFromStats: number;
    computationRunsFromStats: number;
    computationTotalTimeFromStats: number;
    effectRunsFromStats: number;
    effectTotalTimeFromStats: number;
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
};

export async function collectSchedulerLoadSummary(
  page: Page,
): Promise<SchedulerLoadSummary | null> {
  return await page.evaluate(async () => {
    const rt = (globalThis as typeof globalThis & {
      commonfabric?: {
        rt?: {
          getLoggerCounts?: () => Promise<{
            timing: Record<string, Record<string, TimingRow>>;
            counts?: Record<
              string,
              Record<string, { debug?: number } | number>
            >;
          }>;
          getGraphSnapshot?: () => Promise<{
            nodes: GraphNode[];
            edges: unknown[];
          }>;
          idle?: () => Promise<void>;
        };
      };
    }).commonfabric?.rt;
    if (!rt?.getLoggerCounts || !rt?.getGraphSnapshot || !rt?.idle) {
      return null;
    }
    await rt.idle();

    const { timing, counts } = await rt.getLoggerCounts();
    const graph = await rt.getGraphSnapshot();
    const schedulerTiming = timing["scheduler"] ?? {};

    // Scheduler-state rehydration health on (re)load: how many actions restored
    // from a persisted observation vs re-ran, and why the misses missed.
    const schedulerCounts = counts?.["scheduler"] ?? {};
    const countKey = (key: string): number => {
      const v = schedulerCounts[key] as { debug?: number } | number | undefined;
      return typeof v === "number" ? v : (v?.debug ?? 0);
    };
    const rehydration = {
      ok: countKey("rehydrate/ok"),
      missNoSnapshot: countKey("rehydrate/miss/no-snapshot"),
      missActionId: countKey("rehydrate/miss/action-id"),
      missFingerprint: countKey("rehydrate/miss/fingerprint"),
      skipShouldNotApply: countKey("rehydrate/skip/should-not-apply"),
      fallbackRunNoMatch: countKey("rehydrate/fallback-run/no-match"),
      fallbackRunTimeout: countKey("rehydrate/fallback-run/timeout"),
    };
    const schedulerRunCount = schedulerTiming["scheduler/run"]?.count ?? 0;
    const schedulerRunActionCount =
      schedulerTiming["scheduler/run/action"]?.count ?? 0;

    const typedNodes = graph.nodes;
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

    const actionRows = [...byActionId.values()];
    const computationRows = actionRows.filter((row) =>
      row.actionType === "computation"
    );
    const effectRows = actionRows.filter((row) => row.actionType === "effect");
    const round = (value: number) => Number(value.toFixed(3));

    return {
      rehydration,
      graph: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        computations: typedNodes.filter((node) =>
          node.type === "computation"
        ).length,
        effects: typedNodes.filter((node) => node.type === "effect").length,
        inputs: typedNodes.filter((node) => node.type === "input").length,
        inactive: typedNodes.filter((node) => node.type === "inactive").length,
        actionsWithStats: actionNodes.length,
        actionRuns: schedulerRunCount,
        actionRunsThroughActionBody: schedulerRunActionCount,
        actionRunsFromStats: actionRows.reduce(
          (sum, row) => sum + row.runCount,
          0,
        ),
        actionTotalTimeFromStats: round(
          actionRows.reduce((sum, row) => sum + row.totalTime, 0),
        ),
        computationRunsFromStats: computationRows.reduce(
          (sum, row) => sum + row.runCount,
          0,
        ),
        computationTotalTimeFromStats: round(
          computationRows.reduce((sum, row) => sum + row.totalTime, 0),
        ),
        effectRunsFromStats: effectRows.reduce(
          (sum, row) => sum + row.runCount,
          0,
        ),
        effectTotalTimeFromStats: round(
          effectRows.reduce((sum, row) => sum + row.totalTime, 0),
        ),
      },
      topSchedulerTiming: Object.entries(schedulerTiming)
        .sort((a, b) => (b[1].totalTime ?? 0) - (a[1].totalTime ?? 0))
        .slice(0, 16)
        .map(([key, value]) => ({
          key,
          count: value.count ?? 0,
          totalTime: round(value.totalTime ?? 0),
          average: round(value.average ?? 0),
          p50: round(value.p50 ?? 0),
          p95: round(value.p95 ?? 0),
          max: round(value.max ?? 0),
        })),
      topActions: actionRows
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
          totalTime: round(row.totalTime),
          averageTime: round(row.averageTime),
        })),
    };
  });
}

type TimingRow = {
  count: number;
  totalTime: number;
  average: number;
  p50: number;
  p95: number;
  max: number;
};

/**
 * One timing-stats row distilled from a logger's `timeStats` (ms). Used to
 * surface where wall-clock goes under multi-browser contention — chiefly the
 * main-thread `runtime-client` IPC round-trips, which are what time out with
 * "RuntimeClient request timed out" when the worker can't keep up.
 */
export interface TimingStatRow {
  key: string;
  count: number;
  average: number;
  p50: number;
  p95: number;
  max: number;
  total: number;
}

/**
 * Counters that quantify how much the worker re-ran and how often writes lost a
 * conflict, read back from `getLoggerCounts().counts`. Conflicts that ratchet
 * (a non-falling, bounded count) rather than storm is the healthy steady state:
 * a stale-seq write is rejected, the optimistic value is dropped, the
 * computation re-runs once against confirmed state, and settles.
 */
export interface ChurnCounters {
  /** Total computation/effect runs (`scheduler/run/action`). */
  actionRuns: number;
  /** Commit conflicts — stale-seq-basis rejections (`storage.v2/commit-conflict`). */
  commitConflicts: number;
  /** Reverts emitted after a rejected commit (`storage.v2/commit-revert`). */
  commitReverts: number;
  /** Non-conflict commit rejections (`storage.v2/commit-rejected`). */
  commitRejected: number;
  /** Reactive-action commit errors that triggered a retry (`scheduler/schedule-run-error`). */
  scheduleRunErrors: number;
  /** Event handlers that lost the receipt race permanently (`scheduler/event-lost-race`). */
  eventLostRaces: number;
}

export interface BrowserLoadSummary {
  label: string;
  /**
   * Main-thread `runtime-client` IPC round-trip timing. p95/max here ballooning
   * (and approaching the 60s request timeout) is the multi-browser-slowness
   * signal: the main thread is waiting on a saturated worker.
   */
  ipc: TimingStatRow[];
  /** Worker-side scheduler/runner/storage timing — where the work happens. */
  worker: TimingStatRow[];
  /** Conflict / re-run counters — see {@link ChurnCounters}. */
  churn: ChurnCounters;
}

/**
 * Collect aggregate timing stats from one browser: main-thread IPC round-trips
 * (`commonfabric.getTimingStatsBreakdown()`) plus the worker's
 * scheduler/runner/storage timing (`commonfabric.rt.getLoggerCounts()`). One
 * IPC round-trip; safe to call in a `finally`/teardown (worker errors are
 * swallowed). Reading these across all profiles after a run quantifies the
 * cross-browser contention behind dual-browser slowness.
 */
export async function collectBrowserLoadSummary(
  page: Page,
  label: string,
): Promise<BrowserLoadSummary> {
  const collected = await page.evaluate(async () => {
    type Stats = {
      count?: number;
      average?: number;
      p50?: number;
      p95?: number;
      max?: number;
      totalTime?: number;
    };
    const round = (value: number | undefined): number =>
      Number((value ?? 0).toFixed(2));
    const toRows = (
      group: Record<string, Stats> | undefined,
      limit: number,
    ) =>
      Object.entries(group ?? {})
        .map(([key, stats]) => ({
          key,
          count: stats.count ?? 0,
          average: round(stats.average),
          p50: round(stats.p50),
          p95: round(stats.p95),
          max: round(stats.max),
          total: round(stats.totalTime),
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, limit);

    type CountEntry = { total?: number } | number | undefined;
    const cf = (globalThis as typeof globalThis & {
      commonfabric?: {
        getTimingStatsBreakdown?: () => Record<string, Record<string, Stats>>;
        rt?: {
          getLoggerCounts?: () => Promise<{
            timing?: Record<string, Record<string, Stats>>;
            counts?: Record<string, Record<string, CountEntry>>;
          }>;
        };
      };
    }).commonfabric;

    const mainTiming = cf?.getTimingStatsBreakdown?.() ?? {};
    const ipc = toRows(mainTiming["runtime-client"], 12);

    let worker: ReturnType<typeof toRows> = [];
    const churn = {
      actionRuns: 0,
      commitConflicts: 0,
      commitReverts: 0,
      commitRejected: 0,
      scheduleRunErrors: 0,
      eventLostRaces: 0,
    };
    try {
      const workerCounts = await cf?.rt?.getLoggerCounts?.();
      const workerTiming = workerCounts?.timing ?? {};
      // Prefix-match so sub-loggers are included: storage commit/conflict
      // timings live under `storage.v2` (+ `.transaction`/`.multi-space-commit`),
      // not a bare `storage` logger; runner/scheduler similarly have sub-loggers.
      const prefixes = ["scheduler", "runner", "storage"];
      const includeLogger = (name: string): boolean =>
        name === "runtime-client.cfc-label" ||
        prefixes.some((prefix) =>
          name === prefix || name.startsWith(`${prefix}.`)
        );
      const selected: Record<string, Stats> = {};
      for (const [name, groupStats] of Object.entries(workerTiming)) {
        if (!includeLogger(name)) continue;
        for (const [key, stats] of Object.entries(groupStats)) {
          selected[`${name}/${key}`] = stats;
        }
      }
      worker = toRows(selected, 16);

      const counts: Record<string, Record<string, CountEntry>> =
        workerCounts?.counts ?? {};
      const countOf = (logger: string, key: string): number => {
        const entry = counts[logger]?.[key];
        return typeof entry === "number" ? entry : entry?.total ?? 0;
      };
      churn.actionRuns = countOf("scheduler", "schedule-run-start");
      churn.commitConflicts = countOf("storage.v2", "commit-conflict");
      churn.commitReverts = countOf("storage.v2", "commit-revert");
      churn.commitRejected = countOf("storage.v2", "commit-rejected");
      churn.scheduleRunErrors = countOf("scheduler", "schedule-run-error");
      churn.eventLostRaces = countOf("scheduler", "event-lost-race");
    } catch {
      // Worker may be disposed during teardown — main-thread IPC still tells
      // the contention story.
    }

    return { ipc, worker, churn };
  });
  return {
    label,
    ipc: collected.ipc,
    worker: collected.worker,
    churn: collected.churn,
  };
}

/**
 * Times labeled async steps so a run can report where its wall-clock went.
 * `run` records the elapsed ms even when the wrapped step throws, so a timed-
 * out propagation wait still shows up in the summary.
 */
export class StepTimer {
  #rows: Array<{ label: string; ms: number }> = [];

  async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.#rows.push({ label, ms: Math.round(performance.now() - start) });
    }
  }

  rows(): ReadonlyArray<{ label: string; ms: number }> {
    return this.#rows;
  }
}

export function logStepTimings(label: string, timer: StepTimer): void {
  const rows = timer.rows();
  if (rows.length === 0) return;
  const total = rows.reduce((sum, row) => sum + row.ms, 0);
  const lines = rows.map((row) =>
    `  ${String(row.ms).padStart(8)}ms  ${row.label}`
  );
  console.log(
    `\n[${label}] step timings (total ${total}ms):\n${lines.join("\n")}`,
  );
}

export function logBrowserLoadSummary(summary: BrowserLoadSummary): void {
  const formatRows = (rows: TimingStatRow[]): string =>
    rows.length === 0
      ? "    (none)"
      : rows.map((row) =>
        `    ${row.key.padEnd(30)} n=${String(row.count).padStart(5)}` +
        ` p50=${String(row.p50).padStart(8)} p95=${
          String(row.p95).padStart(8)
        }` +
        ` max=${String(row.max).padStart(9)} total=${
          String(row.total).padStart(10)
        }`
      ).join("\n");
  const c = summary.churn;
  const churnLine = `    actionRuns=${c.actionRuns}` +
    ` commitConflicts=${c.commitConflicts} commitReverts=${c.commitReverts}` +
    ` commitRejected=${c.commitRejected}` +
    ` scheduleRunErrors=${c.scheduleRunErrors}` +
    ` eventLostRaces=${c.eventLostRaces}`;
  console.log(
    `\n[${summary.label}] main-thread runtime-client IPC round-trips (ms):\n` +
      `${formatRows(summary.ipc)}\n` +
      `[${summary.label}] worker scheduler/runner/storage (ms):\n` +
      `${formatRows(summary.worker)}\n` +
      `[${summary.label}] churn / conflict counters:\n${churnLine}`,
  );
}

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

async function textIsPresent(
  page: Page,
  selector: string,
  text: string,
): Promise<boolean> {
  try {
    return await page.evaluate((targetSelector, targetText) => {
      function collect(root: Document | ShadowRoot, result: Element[]): void {
        for (const element of root.querySelectorAll("*")) {
          try {
            if (element.matches(targetSelector)) {
              result.push(element);
            }
          } catch {
            // Invalid selectors are reported through the empty probe.
          }
          if (element.shadowRoot) {
            collect(element.shadowRoot, result);
          }
        }
      }

      function deepText(root: ParentNode): string {
        const parts: string[] = [];
        if (root instanceof HTMLElement) {
          const style = globalThis.getComputedStyle(root);
          const hidden = root instanceof HTMLStyleElement ||
            root instanceof HTMLScriptElement ||
            root.hidden ||
            style.visibility === "hidden" ||
            style.display === "none";
          if (!hidden) {
            const innerText = root.innerText ?? "";
            parts.push(
              innerText.trim().length > 0 ? innerText : root.textContent ?? "",
            );
          }
          if (root instanceof HTMLSlotElement) {
            for (const assigned of root.assignedElements({ flatten: true })) {
              parts.push(deepText(assigned));
            }
          }
          if (root.shadowRoot) {
            parts.push(deepText(root.shadowRoot));
          }
        } else if (root instanceof Document || root instanceof ShadowRoot) {
          for (const child of root.children) {
            if (child instanceof HTMLElement) {
              parts.push(deepText(child));
            }
          }
        }
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) {
            parts.push(deepText(element.shadowRoot));
          }
        }
        return parts.join(" ");
      }

      const matches: Element[] = [];
      collect(document, matches);
      return matches.some((element) => deepText(element).includes(targetText));
    }, { args: [selector, text] });
  } catch {
    return false;
  }
}

type TrustedActionProbe = {
  action: string;
  lastClick?: {
    trusted: boolean;
    path: Array<{
      tagName: string;
      id: string;
      dataset: Record<string, string>;
    }>;
  };
  matches: Array<{
    tagName: string;
    text: string;
    rect: { width: number; height: number; top: number; left: number };
    disabled: boolean;
    visible: boolean;
    clickTarget: {
      tagName: string;
      text: string;
      rect: { width: number; height: number; top: number; left: number };
      disabled: boolean;
      visible: boolean;
    };
  }>;
  bodyText: string;
};

type TextProbe = {
  selector: string;
  matches: Array<{
    tagName: string;
    text: string;
    rect: { width: number; height: number; top: number; left: number };
    visible: boolean;
  }>;
  bodyText: string;
};

type CfInputProbe = {
  selector: string;
  found: boolean;
  value: string;
  disabled: boolean;
  readOnly: boolean;
  visible: boolean;
  hostTagName: string;
};

async function readCfInputProbe(
  page: Page,
  selector: string,
): Promise<CfInputProbe> {
  return await page.evaluate((targetSelector) => {
    function collect(root: Document | ShadowRoot, result: Element[]): void {
      for (const element of root.querySelectorAll("*")) {
        try {
          if (element.matches(targetSelector)) result.push(element);
        } catch {
          // Invalid selectors are reported through the empty probe.
        }
        if (element.shadowRoot) collect(element.shadowRoot, result);
      }
    }

    const matches: Element[] = [];
    collect(document, matches);
    const element = matches[0];
    if (!element) {
      return {
        selector: targetSelector,
        found: false,
        value: "",
        disabled: false,
        readOnly: false,
        visible: false,
        hostTagName: "",
      };
    }
    const input = element instanceof HTMLInputElement
      ? element
      : element.shadowRoot?.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      return {
        selector: element.tagName.toLowerCase(),
        found: false,
        value: "",
        disabled: false,
        readOnly: false,
        visible: false,
        hostTagName: element.tagName.toLowerCase(),
      };
    }
    const rect = input.getBoundingClientRect();
    const style = globalThis.getComputedStyle(input);
    const visible = rect.width > 0 && rect.height > 0 &&
      rect.bottom >= 0 && rect.right >= 0 &&
      rect.top <= globalThis.innerHeight &&
      rect.left <= globalThis.innerWidth &&
      style.visibility !== "hidden" && style.display !== "none";
    const root = input.getRootNode();
    const host = root instanceof ShadowRoot ? root.host : element;
    return {
      selector: input.tagName.toLowerCase(),
      found: true,
      value: input.value,
      disabled: input.disabled,
      readOnly: input.readOnly,
      visible,
      hostTagName: host.tagName.toLowerCase(),
    };
  }, { args: [selector] });
}

async function readDisabledProbe(
  page: Page,
  selector: string,
): Promise<{ selector: string; disabled?: boolean }> {
  return await page.evaluate((targetSelector) => {
    function collect(root: Document | ShadowRoot, result: Element[]): void {
      for (const element of root.querySelectorAll("*")) {
        try {
          if (element.matches(targetSelector)) result.push(element);
        } catch {
          // Invalid selectors are reported through the empty probe.
        }
        if (element.shadowRoot) collect(element.shadowRoot, result);
      }
    }

    const matches: Element[] = [];
    collect(document, matches);
    const element = matches[0];
    if (!element) return { selector: targetSelector, disabled: undefined };
    const button = element instanceof HTMLButtonElement
      ? element
      : element.shadowRoot?.querySelector("button");
    return {
      selector: element.tagName.toLowerCase(),
      disabled: button instanceof HTMLButtonElement
        ? button.disabled
        : undefined,
    };
  }, { args: [selector] });
}

async function clearTrustedActionMark(
  page: Page,
  token: string,
): Promise<void> {
  await page.evaluate((targetToken, targetAttr) => {
    function collect(
      root: Document | ShadowRoot,
      result: Element[],
    ): void {
      for (const element of root.querySelectorAll("*")) {
        if (element.getAttribute(targetAttr) === targetToken) {
          result.push(element);
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    const matches: Element[] = [];
    collect(document, matches);
    for (const element of matches) {
      element.removeAttribute(targetAttr);
    }
  }, { args: [token, CLICK_TARGET_ATTR] });
}

async function readTrustedActionProbe(
  page: Page,
  action: string,
): Promise<TrustedActionProbe> {
  return await page.evaluate((targetAction) => {
    function collect(
      root: Document | ShadowRoot,
      result: Element[],
    ): void {
      for (const element of root.querySelectorAll("*")) {
        if (element.getAttribute("data-ui-action") === targetAction) {
          result.push(element);
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    function isVisible(element: HTMLElement): boolean {
      const rect = element.getBoundingClientRect();
      const style = globalThis.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        rect.bottom >= 0 && rect.right >= 0 &&
        rect.top <= globalThis.innerHeight &&
        rect.left <= globalThis.innerWidth &&
        style.visibility !== "hidden" &&
        style.display !== "none";
    }

    function isDisabled(element: HTMLElement): boolean {
      return element.hasAttribute("disabled") ||
        element.getAttribute("aria-disabled") === "true";
    }

    const matches: Element[] = [];
    collect(document, matches);
    const lastClick = (globalThis as typeof globalThis & {
      __lastCfcTrustedActionClick?: TrustedActionProbe["lastClick"];
    }).__lastCfcTrustedActionClick;
    return {
      action: targetAction,
      ...(lastClick ? { lastClick } : {}),
      matches: matches.map((element) => {
        const target = element as HTMLElement;
        const clickTarget =
          (target.shadowRoot?.querySelector("[data-cf-button]") as
            | HTMLElement
            | null) ?? target;
        const rect = target.getBoundingClientRect();
        const clickRect = clickTarget.getBoundingClientRect();
        return {
          tagName: target.tagName.toLowerCase(),
          text: (target.textContent ?? "").trim().slice(0, 200),
          rect: {
            width: rect.width,
            height: rect.height,
            top: rect.top,
            left: rect.left,
          },
          disabled: isDisabled(target) || isDisabled(clickTarget),
          visible: isVisible(target) && isVisible(clickTarget),
          clickTarget: {
            tagName: clickTarget.tagName.toLowerCase(),
            text: (clickTarget.textContent ?? "").trim().slice(0, 200),
            rect: {
              width: clickRect.width,
              height: clickRect.height,
              top: clickRect.top,
              left: clickRect.left,
            },
            disabled: isDisabled(clickTarget),
            visible: isVisible(clickTarget),
          },
        };
      }),
      bodyText: (document.body?.innerText ?? "").slice(0, 1_000),
    };
  }, { args: [action] });
}

async function readTextProbe(
  page: Page,
  selector: string,
): Promise<TextProbe> {
  return await page.evaluate((targetSelector) => {
    function collect(
      root: Document | ShadowRoot,
      result: Element[],
    ): void {
      for (const element of root.querySelectorAll("*")) {
        try {
          if (element.matches(targetSelector)) {
            result.push(element);
          }
        } catch {
          // Invalid selectors are reported through the empty probe.
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    function isVisible(element: HTMLElement): boolean {
      const rect = element.getBoundingClientRect();
      const style = globalThis.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        rect.bottom >= 0 && rect.right >= 0 &&
        rect.top <= globalThis.innerHeight &&
        rect.left <= globalThis.innerWidth &&
        style.visibility !== "hidden" &&
        style.display !== "none";
    }

    function deepText(root: ParentNode): string {
      const parts: string[] = [];
      if (root instanceof HTMLElement) {
        const style = globalThis.getComputedStyle(root);
        const hidden = root instanceof HTMLStyleElement ||
          root instanceof HTMLScriptElement ||
          root.hidden ||
          style.visibility === "hidden" ||
          style.display === "none";
        if (!hidden) {
          const innerText = root.innerText ?? "";
          parts.push(
            innerText.trim().length > 0 ? innerText : root.textContent ?? "",
          );
        }
        if (root instanceof HTMLSlotElement) {
          for (const assigned of root.assignedElements({ flatten: true })) {
            parts.push(deepText(assigned));
          }
        }
        if (root.shadowRoot) {
          parts.push(deepText(root.shadowRoot));
        }
      } else if (root instanceof Document || root instanceof ShadowRoot) {
        for (const child of root.children) {
          if (child instanceof HTMLElement) {
            parts.push(deepText(child));
          }
        }
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
          parts.push(deepText(element.shadowRoot));
        }
      }
      return parts.join(" ");
    }

    const matches: Element[] = [];
    collect(document, matches);
    return {
      selector: targetSelector,
      matches: matches.map((element) => {
        const target = element as HTMLElement;
        const rect = target.getBoundingClientRect();
        return {
          tagName: target.tagName.toLowerCase(),
          text: deepText(target).trim().slice(
            0,
            500,
          ),
          rect: {
            width: rect.width,
            height: rect.height,
            top: rect.top,
            left: rect.left,
          },
          visible: isVisible(target),
        };
      }),
      bodyText: document.body === null
        ? ""
        : deepText(document.body).trim().slice(0, 1_000),
    };
  }, { args: [selector] });
}
