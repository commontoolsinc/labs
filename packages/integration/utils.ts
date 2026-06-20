import { sleep } from "@commonfabric/utils/sleep";
import type { Page } from "./page.ts";

// Default poll interval between predicate calls. Polls are cheap (a CDP
// evaluate round-trip), and a coarse interval quantizes every wall-clock
// measurement taken around a waitFor up to its multiple — the old 500ms
// default made the default-app timing series report ~520ms for phases whose
// real latency was far lower. Override per run with CF_WAITFOR_DELAY_MS.
const DEFAULT_DELAY_MS = (() => {
  try {
    const raw = Number(Deno.env.get("CF_WAITFOR_DELAY_MS"));
    return Number.isFinite(raw) && raw > 0 ? raw : 50;
  } catch {
    return 50;
  }
})();

/**
 * Receives an async predicate function to executed repeatedly
 * until either the predicate returns `true`, or throws once
 * the timeout limit has been reached.
 *
 * @param predicate - The predicate callback.
 * @param config.timeout - The number of milliseconds to wait before throwing. [60000]
 * @param config.delay - The number of milliseconds to wait between predicate
 *   calls. [50, or CF_WAITFOR_DELAY_MS]
 */
export const waitFor = async (
  predicate: () => Promise<boolean>,
  { timeout: _timeout, delay: _delay }: { timeout?: number; delay?: number } =
    {},
): Promise<void> => {
  const timeout = _timeout ?? 60_000;
  const delay = _delay ?? DEFAULT_DELAY_MS;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await predicate())) {
      return;
    }
    await sleep(delay);
  }
  throw new Error(
    `Timeout: waitFor predicate could not complete after ${timeout}ms.`,
  );
};

/**
 * Wait until the shell's rendered UI has caught up to runtime state and is
 * interactive. The reactive scheduler runs in a worker while the DOM lives on
 * the main thread, so there are three stages between a state change and a
 * clickable control: the worker settles reactively, the resulting vdom batch
 * crosses to the main thread and is applied, and the Lit elements finish their
 * update cycle (which is when cf-modal binds handlers and drops
 * `pointer-events:none`). This resolves once all three have happened.
 *
 * Returns true once settled, or false when the shell has not yet exposed
 * `commonfabric.viewSettled` (for example the runtime is still starting), so a
 * caller can keep polling with `waitFor`.
 *
 * Call this before issuing a click or keystroke after navigation or any state
 * change, so the stimulus lands on a bound handler instead of a freshly
 * rendered element whose handler is not wired up yet.
 */
export const awaitViewSettled = async (page: Page): Promise<boolean> => {
  return await page.evaluate(async () => {
    const settled = (globalThis as {
      commonfabric?: { viewSettled?: () => Promise<void> };
    }).commonfabric?.viewSettled;
    if (!settled) return false;
    await settled();
    return true;
  });
};

/**
 * Shadow-piercing DOM helpers handed to a {@link waitForCondition} predicate.
 * They run in the page, where the app is a tree of web components with nested
 * shadow roots, so a predicate can find elements and read their visible text
 * without re-implementing the traversal each time.
 */
export interface ProbeApi {
  /** Every element matching `selector`, descending through shadow roots. */
  collect(selector: string): Element[];
  /** Whether `element` is on-screen and not display/visibility hidden. */
  isVisible(element: Element): boolean;
  /** Visible text of `root` plus its shadow and slotted descendants. */
  deepText(root: ParentNode): string;
}

/**
 * A predicate evaluated in the page. It receives a {@link ProbeApi} plus the
 * `args` passed to {@link waitForCondition}, and returns whether the awaited
 * condition holds. It may be async (for example to await `rt.idle()`).
 */
export type PageCondition<A extends readonly unknown[]> = (
  probe: ProbeApi,
  ...args: A
) => boolean | Promise<boolean>;

/**
 * Installed in the page by {@link waitForCondition}. Re-evaluates `predicate`
 * whenever the UI could have changed — a shared pulse hub observes the document
 * and every shadow root (subtree, character data, and attributes), including
 * shadow roots created after the wait began, so the predicate runs the instant
 * the DOM reflects new state instead of on a fixed timer. When the predicate
 * holds, it calls the CDP binding `bindingName`, which wakes the awaiting test
 * process. An async predicate that awaits a runtime signal (such as
 * `rt.idle()`) resolves the moment that signal fires, with no DOM change
 * required.
 *
 * Self-contained: it is serialized and run in the page, so it closes over none
 * of the module scope. `predicateSource` is the predicate's source text,
 * reconstructed here because a function cannot cross the evaluate boundary as a
 * callable value.
 */
function installWaiter(
  bindingName: string,
  predicateSource: string,
  predicateArgs: unknown[],
): void {
  type Probe = {
    collect: (selector: string) => Element[];
    isVisible: (element: Element) => boolean;
    deepText: (root: ParentNode) => string;
  };

  const probe: Probe = {
    collect(selector) {
      const out: Element[] = [];
      const walk = (root: Document | ShadowRoot) => {
        for (const el of root.querySelectorAll("*")) {
          try {
            if (el.matches(selector)) out.push(el);
          } catch {
            // An invalid selector matches nothing.
          }
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      return out;
    },
    isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = globalThis.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        rect.bottom >= 0 && rect.right >= 0 &&
        rect.top <= globalThis.innerHeight &&
        rect.left <= globalThis.innerWidth &&
        style.visibility !== "hidden" && style.display !== "none";
    },
    deepText(root) {
      const parts: string[] = [];
      const visit = (node: ParentNode) => {
        if (node instanceof HTMLElement) {
          const style = globalThis.getComputedStyle(node);
          const hidden = node instanceof HTMLStyleElement ||
            node instanceof HTMLScriptElement || node.hidden ||
            style.visibility === "hidden" || style.display === "none";
          if (!hidden) {
            const innerText = node.innerText ?? "";
            parts.push(
              innerText.trim().length > 0 ? innerText : node.textContent ?? "",
            );
          }
          if (node instanceof HTMLSlotElement) {
            for (const assigned of node.assignedElements({ flatten: true })) {
              visit(assigned);
            }
          }
          if (node.shadowRoot) visit(node.shadowRoot);
        } else if (node instanceof Document || node instanceof ShadowRoot) {
          for (const child of node.children) {
            if (child instanceof HTMLElement) visit(child);
          }
        }
        for (const el of node.querySelectorAll("*")) {
          if (el.shadowRoot) visit(el.shadowRoot);
        }
      };
      visit(root);
      return parts.join(" ");
    },
  };

  const predicate = new Function("return (" + predicateSource + ")")() as (
    probe: Probe,
    ...args: unknown[]
  ) => unknown;

  // Shared pulse hub, installed once per document. A document-level
  // MutationObserver cannot see inside shadow roots, so the hub also observes
  // every shadow root — those present now and those created later, caught by
  // wrapping Element.prototype.attachShadow — and fans a "DOM may have changed"
  // pulse out to every active waiter. Without this, a deep text change inside a
  // shadow root created after the wait began would go unnoticed.
  const hub = ((globalThis as typeof globalThis & {
    __cfcPulseHub?: { listeners: Set<() => void> };
  }).__cfcPulseHub ??= (() => {
    const listeners = new Set<() => void>();
    const observed = new WeakSet<Document | ShadowRoot>();
    const notify = () => {
      for (const listener of listeners) listener();
    };
    const observe = (root: Document | ShadowRoot) => {
      if (observed.has(root)) return;
      observed.add(root);
      new MutationObserver(notify).observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    };
    const scan = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          observe(el.shadowRoot);
          scan(el.shadowRoot);
        }
      }
    };
    observe(document);
    const proto = Element.prototype as Element & {
      attachShadow: (init: ShadowRootInit) => ShadowRoot;
    };
    const original = proto.attachShadow;
    proto.attachShadow = function (
      this: Element,
      init: ShadowRootInit,
    ): ShadowRoot {
      const root = original.call(this, init);
      observe(root);
      // Content may be set synchronously right after attachShadow, so pulse.
      notify();
      return root;
    };
    scan(document);
    return { listeners };
  })());

  const registry = ((globalThis as typeof globalThis & {
    __cfcWaiters?: Map<string, () => void>;
  }).__cfcWaiters ??= new Map<string, () => void>());
  // A leftover waiter under this name would only exist after a name collision;
  // dispose it so its pulse stops running.
  registry.get(bindingName)?.();

  let stopped = false;
  let signalled = false;
  let running = false;
  let rerun = false;

  const fire = (): boolean => {
    const notify = (globalThis as Record<string, unknown>)[bindingName];
    if (typeof notify !== "function") return false;
    signalled = true;
    (notify as (payload: string) => void)("ok");
    return true;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    hub.listeners.delete(pulse);
    registry.delete(bindingName);
  };

  const onConditionMet = () => {
    if (stopped) return;
    stopped = true;
    hub.listeners.delete(pulse);
    // The binding is added and awaited before this script installs, so the
    // bound function is normally present; retry on the macrotask queue in case
    // it has not yet attached to this execution context.
    const tryFire = () => {
      if (signalled) return;
      if (fire()) registry.delete(bindingName);
      else setTimeout(tryFire, 0);
    };
    tryFire();
  };

  const evaluate = () => {
    if (stopped || running) {
      if (running) rerun = true;
      return;
    }
    running = true;
    Promise.resolve()
      .then(() => predicate(probe, ...predicateArgs))
      .then((ok) => {
        running = false;
        if (stopped) return;
        if (ok) onConditionMet();
        else if (rerun) {
          rerun = false;
          evaluate();
        }
      })
      .catch(() => {
        running = false;
        if (!stopped && rerun) {
          rerun = false;
          evaluate();
        }
      });
  };

  function pulse() {
    evaluate();
  }

  registry.set(bindingName, stop);
  hub.listeners.add(pulse);
  // Check immediately; the condition may already hold.
  evaluate();
}

/**
 * Block until an in-page `predicate` holds, resolving the instant it does
 * rather than on a polling tick. A notifier installed in the page
 * (see {@link installWaiter}) re-checks the predicate whenever the DOM could
 * have changed and signals the test process over a CDP binding, so an awaited
 * step idles until its condition is actually satisfied — like `select(2)` or
 * `wait` — and then proceeds immediately.
 *
 * On timeout it throws; callers add the context and rich probe for the failure
 * message. `timeout` is a safety net for a genuinely stuck condition, not the
 * common-case latency.
 */
export const waitForCondition = async <A extends readonly unknown[]>(
  page: Page,
  predicate: PageCondition<A>,
  { timeout = 60_000, args }: { timeout?: number; args?: A } = {},
): Promise<void> => {
  const bindingName = `__cfcWait_${crypto.randomUUID().replace(/-/g, "")}`;
  let resolveSignal!: () => void;
  const signalled = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const unsubscribe = page.onBindingCalled((name) => {
    if (name === bindingName) resolveSignal();
  });
  await page.addBinding(bindingName);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await page.evaluate(installWaiter, {
      args: [bindingName, predicate.toString(), (args ?? []) as unknown[]],
    });
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`waitForCondition did not resolve within ${timeout}ms`),
          ),
        timeout,
      );
    });
    await Promise.race([signalled, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
    await page.removeBinding(bindingName).catch(() => {});
    await page.evaluate((name: string) => {
      (globalThis as typeof globalThis & {
        __cfcWaiters?: Map<string, () => void>;
      }).__cfcWaiters?.get(name)?.();
    }, { args: [bindingName] }).catch(() => {});
  }
};
