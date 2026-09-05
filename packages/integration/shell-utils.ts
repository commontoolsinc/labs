import { afterAll, afterEach, beforeAll, beforeEach } from "@std/testing/bdd";

import { ConsoleEvent, PageErrorEvent } from "@astral/astral";
import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import {
  AppView,
  appViewToUrlPath,
  isAppViewEqual,
} from "@commonfabric/navigation";
import {
  AppStateSerialized,
  type SerializedIdentity,
} from "@commonfabric/shell/app-state";

import { Browser } from "./browser.ts";
import { describeThrown } from "./describe-thrown.ts";
import * as env from "./env.ts";
import { dismissDialogs, Page, pipeConsole } from "./page.ts";
import {
  collectPatternCoverage,
  enablePatternCoverage,
} from "./pattern-coverage.ts";
import type { PresentationParticipant } from "./presentation/config.ts";
import { getPresentationSession } from "./presentation/session.ts";
import {
  assertShellDocument,
  isShellDocument,
  readAndDescribeShellPage,
} from "./shell-page-probe.ts";
import { waitFor, waitForCondition } from "./utils.ts";

import "../shell/src/globals.ts";

/**
 * Blocks until the shell behind `page` is there to be driven.
 *
 * `globalThis.app` is the handle every driver reaches the shell through, and
 * the shell publishes it as the last step of its bootstrap module, after
 * opening the browser key store. That module body runs on past the document's
 * `load` event, so a navigation that resolves on `load` hands back a page whose
 * shell is still booting, for the couple of milliseconds the key store takes.
 *
 * A document that is not the shell never publishes the handle, and returns
 * here without a wait. `goto` reports such a document through
 * `assertShellDocument`, naming the URL it asked for, as soon as the
 * navigation this belongs to returns.
 */
export async function waitForShellReady(page: Page): Promise<void> {
  if (!await isShellDocument(page)) return;
  try {
    await waitForCondition(page, () => globalThis.app !== undefined);
  } catch (cause) {
    throw new Error(await describeShellReadyFailure(page), { cause });
  }
}

/**
 * Render what `page` held when the shell it carries never published itself on
 * `globalThis.app`: the shell's own document loaded, and its bootstrap did not
 * run to the end. The console tail in the block is where a bootstrap that
 * threw says so.
 */
export async function describeShellReadyFailure(page: Page): Promise<string> {
  return `The shell never published itself on globalThis.app.\n${await readAndDescribeShellPage(
    page,
  )}`;
}

/**
 * Logs `page`'s shell in as `identity`, passing the key over the boundary. The
 * astral boundary carries only what JSON can express, so the key pair crosses
 * in the `FabricValue` JSON encoding, which is a string.
 *
 * @throws If `identity` is not a `noble` implementation: a key pair holding
 *   handles has no JSON encoding, `CryptoKey` material being unreachable.
 */
export async function login(page: Page, identity: Identity): Promise<void> {
  const { keyPair } = identity;

  if (!keyPair.hasMaterial) {
    throw new Error(
      "Could not serialize identity. Requires 'noble' implementation.",
    );
  }

  const serializedId = jsonFromFabricValue(keyPair);

  // Setting an identity builds a new runtime and drops the one the page is
  // holding: `resolveIdentity` mints a fresh `Identity` from what crosses the
  // boundary, so `shouldRecreateRuntime` fires on the object even for the DID
  // already logged in. Take the outgoing worker's pattern-coverage hits while
  // it is still there to ask.
  await collectPatternCoverage(page);

  // Everything from here on runs against the page, and every way it can fail
  // says nothing about the page it failed against. The runtime handshake below
  // reports which of its two stages ran out, and no more than that.
  try {
    await loginToPublishedApp(page, serializedId, identity.did());
  } catch (error) {
    throw new Error(
      `Logging in as ${identity.did()} failed: ${
        describeThrown(error)
      }\n${await readAndDescribeShellPage(page)}`,
      { cause: error },
    );
  }
}

// The page half of `login`: wait for the shell to publish itself, then hand it
// the identity and wait for the runtime to come up under it.
async function loginToPublishedApp(
  page: Page,
  serializedId: SerializedIdentity,
  nextDID: string,
): Promise<void> {
  await waitForShellReady(page);

  await page!.evaluate<Promise<void>, [SerializedIdentity, string]>(
    async (serializedId, nextDID) => {
      const currentIdentity = globalThis.app.state().identity;
      if (currentIdentity && currentIdentity.did() !== nextDID) {
        await globalThis.app.setIdentity(undefined);
        await new Promise<void>((resolve, reject) => {
          const startedAt = performance.now();
          const check = () => {
            if (!globalThis.commonfabric?.rt) {
              resolve();
              return;
            }
            if (performance.now() - startedAt > 30_000) {
              reject(new Error("Timed out waiting for runtime logout"));
              return;
            }
            setTimeout(check, 50);
          };
          check();
        });
      }
      await globalThis.app.setIdentity(serializedId);
      await new Promise<void>((resolve, reject) => {
        const startedAt = performance.now();
        const check = async () => {
          try {
            const rt = globalThis.commonfabric?.rt;
            const home = await rt?.getHomeSpaceCell?.();
            const ref = home?.ref?.();
            if (ref?.space === nextDID) {
              await rt?.idle?.();
              resolve();
              return;
            }
          } catch {
            // Runtime is still initializing; retry until the deadline.
          }
          if (performance.now() - startedAt > 30_000) {
            reject(new Error("Timed out waiting for runtime login"));
            return;
          }
          setTimeout(check, 50);
        };
        void check();
      });
    },
    {
      args: [serializedId, nextDID],
    },
  );
}

/** How a serialized `AppState` reads in a failure message. */
function describeAppState(state: AppStateSerialized | undefined): string {
  if (!state) return "none (the page never yielded a state)";
  return `view ${JSON.stringify(state.view)}, identity ${
    state.identityDid ?? "none"
  }`;
}

/**
 * The indented detail block a failed {@link ShellIntegration.waitForState}
 * reports: what the wait was for, the last state it managed to read, and what
 * `page` holds now.
 *
 * The two states answer different questions. `lastState` is what the wait saw.
 * The page probe is read at failure time and covers the case the wait itself
 * cannot describe: a document that is not the shell, where no state was ever
 * there to read.
 */
export async function describeStateWaitFailure(
  page: Page,
  params: { view: AppView; identity?: Identity },
  lastState: AppStateSerialized | undefined,
): Promise<string> {
  const lines = [`  awaited view: ${JSON.stringify(params.view)}`];
  if (params.identity) {
    lines.push(`  awaited identity: ${params.identity.did()}`);
  }
  lines.push(`  last state read: ${describeAppState(lastState)}`);
  lines.push(await readAndDescribeShellPage(page));
  return lines.join("\n");
}

export interface ShellIntegrationConfig {
  pipeConsole?: boolean;

  /**
   * When `true` (the default), `afterEach` throws if any browser
   * `console.error` message was collected during the test.
   *
   * Set to `false` only to opt an entire suite out of the check when
   * you have strong reason to believe every error is benign AND cannot
   * be narrowly allowlisted.
   */
  failOnConsoleError?: boolean;

  /**
   * Strings or RegExps that match console error messages that are known-
   * benign for this suite.  A collected error is suppressed (does not
   * cause `afterEach` to throw) when it matches ANY entry in this list.
   *
   * Prefer narrow patterns (exact substring or anchored regex) so that
   * genuinely unexpected errors still surface.
   *
   * Example:
   * ```ts
   * new ShellIntegration({
   *   allowedConsoleErrors: [
   *     "Expected cross-origin rejection",
   *     /^ResizeObserver loop/,
   *   ],
   * })
   * ```
   */
  allowedConsoleErrors?: (string | RegExp)[];

  /** Optional participant metadata used only by `deno task demo`. */
  presentation?: PresentationParticipant;
}

export class ShellIntegration {
  #browser?: Browser;
  #page?: Page;
  #exceptions: Array<string> = [];
  #errorLogs: Array<string> = [];
  #config: Required<Omit<ShellIntegrationConfig, "presentation">>;
  #presentation: PresentationParticipant;

  constructor(config: ShellIntegrationConfig = {}) {
    this.#config = {
      pipeConsole: config.pipeConsole ?? env.PIPE_CONSOLE,
      failOnConsoleError: config.failOnConsoleError ?? true,
      allowedConsoleErrors: config.allowedConsoleErrors ?? [],
    };
    this.#presentation = config.presentation ?? {};
  }

  bindLifecycle() {
    beforeAll(this.#beforeAll);
    beforeEach(this.#beforeEach);
    afterAll(this.#afterAll);
    afterEach(this.#afterEach);
  }

  page(): Page {
    this.#checkIsOk();
    return this.#page!;
  }

  // Browser-level CDP websocket endpoint, for attaching a second CDP client
  // (e.g. `CdpWorkerProfiler`).
  wsEndpoint(): string {
    this.#checkIsOk();
    return this.#browser!.wsEndpoint();
  }

  async newPage(url?: string): Promise<Page> {
    this.#checkIsOk();
    const page = await this.#browser!.newPage(url);
    this.#attachPage(page);
    // Astral navigates to `url` inside its own `newPage`, before this wrapper
    // exists for an after-navigation hook to run on, so the wait that
    // navigation would have run happens here.
    if (url !== undefined) await waitForShellReady(page);
    return page;
  }

  async state(): Promise<AppStateSerialized | undefined> {
    this.#checkIsOk();
    const page = this.page();
    return await page.evaluate(() => {
      return globalThis.app ? globalThis.app.serialize() : undefined;
    });
  }

  // Login to the initialized app with provided identity.
  async login(identity: Identity): Promise<void> {
    await login(this.page(), identity);
  }

  async disposeRuntime(): Promise<void> {
    await this.#disposePageRuntime();
  }

  // Wait for the shell's app state to hold this view, and this identity where
  // one is given. Throws if the wait runs out.
  //
  // The view is matched whole, field for field: a state matches when its view
  // holds the same fields this one holds. A view naming only a space is
  // matched by the state of a space with no piece open.
  async waitForState(
    params: {
      view: AppView;
      identity?: Identity;
    },
  ): Promise<AppStateSerialized> {
    function stateMatches(
      state: AppStateSerialized | undefined,
      params: Parameters<typeof ShellIntegration.prototype.waitForState>[0],
    ): boolean {
      return !!(
        state &&
        isAppViewEqual(state.view, params.view) &&
        (params.identity ? state.identityDid === params.identity.did() : true)
      );
    }

    this.#checkIsOk();

    // The last state the poll below managed to read. A failure reports it, so
    // the message says what the wait actually saw rather than only that it
    // never saw what it wanted.
    let lastState: AppStateSerialized | undefined;
    try {
      await waitFor(async () => {
        lastState = await this.state();
        return stateMatches(lastState, params);
      });
    } catch (error) {
      const summary = describeThrown(error);
      const detail = await describeStateWaitFailure(
        this.page(),
        params,
        lastState,
      );
      throw new Error(
        `Waiting for the shell's app state failed: ${summary}\n${detail}`,
        { cause: error },
      );
    }
    const state = await this.state();
    // Unlikely to occur, but recheck state once more to ensure
    // the state returned explicitly matches requirement.
    if (!state || !(stateMatches(state, params))) {
      throw new Error(
        "The shell's app state changed after it matched what was awaited.\n" +
          await describeStateWaitFailure(this.page(), params, state),
      );
    }
    return state;
  }

  // Navigates to the URL represented by `frontendUrl`,
  // `spaceName`, and `pieceId`. Waits for state to settle
  // reflecting these properties.
  //
  // `urlPath` sends a different spelling of the same address: the rooted path
  // to navigate to, where the caller is checking a form the shell reads but
  // does not write. `view` remains the state this waits for, so such a caller
  // states what it sends and what that has to reach as two separate things.
  //
  // If `identity` provided, logs in with the identity
  // after navigation.
  async goto(
    { frontendUrl, view, urlPath, identity }: {
      frontendUrl: string;
      view: AppView;
      urlPath?: `/${string}`;
      identity?: Identity;
    },
  ): Promise<void> {
    this.#checkIsOk();

    // Strip the proceeding "/" in the url path
    const path = (urlPath ?? appViewToUrlPath(view)).substring(1);

    const url = `${frontendUrl}${path}`;
    const page = this.page();
    await page.goto(url);
    await page.applyConsoleFormatter();
    // Everything below reads the page through `globalThis.app`, which only the
    // shell defines. Check the shell is what loaded before any of it, so a
    // server that answered with something else is reported here rather than as
    // a state wait that runs to its bound with nothing to say.
    await assertShellDocument(page, url);
    // The worker runtime reads this when it is constructed, at login, so it has
    // to be set after the page has an origin to store it against and before the
    // login below.
    await enablePatternCoverage(page);
    // [NDT] triage aid: seed the worker-console host toggle before login so
    // the worker runtime's console (where the storage taps live) reaches the
    // page console — and, with PIPE_CONSOLE, the test output. Same
    // read-at-runtime-creation contract as patternCoverage above.
    if (Deno.env.get("FORWARD_WORKER_CONSOLE") === "1") {
      await page.evaluate(() => {
        globalThis.localStorage.setItem("forwardWorkerConsole", "true");
      });
    }
    await this.waitForState({ view });
    if (identity) {
      await this.login(identity);
      await this.waitForState({ identity, view });
    }
    await getPresentationSession()?.start(page);
  }

  #beforeAll = async () => {
    this.#browser = await Browser.launch({ headless: env.HEADLESS });
    this.#page = await this.#browser.newPage();
    this.#attachPage(this.#page);
    await getPresentationSession()?.register(this.#page, this.#presentation);
  };

  #beforeEach = () => {
    this.#exceptions.length = 0;
    this.#errorLogs.length = 0;
  };

  #afterEach = () => {
    // Uncaught page exceptions always fail the test, regardless of
    // `failOnConsoleError`.  They indicate a JavaScript crash, not a
    // deliberate console.error call.
    if (this.#exceptions.length > 0) {
      throw new Error(
        `Uncaught browser exception(s):\n${
          this.#exceptions.map((m) => `  ${m}`).join("\n")
        }`,
      );
    }
    if (this.#config.failOnConsoleError) {
      const offending = this.#errorLogs.filter((msg) =>
        // [NDT] triage aid: with FORWARD_WORKER_CONSOLE=1 the worker's
        // console.error lines reach the page console for OBSERVATION only.
        // The console-error gate never saw them before forwarding existed,
        // so they must not change a run's verdict — exclude the forwarded
        // ("[worker]"-prefixed) lines to keep verdicts comparable.
        !(Deno.env.get("FORWARD_WORKER_CONSOLE") === "1" &&
          msg.startsWith("[worker]")) &&
        !this.#config.allowedConsoleErrors.some((pattern) =>
          typeof pattern === "string"
            ? msg.includes(pattern)
            // Clone without g/y: a sticky/global regex advances lastIndex
            // across .test() calls, making repeated checks order-dependent.
            : new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""))
              .test(msg)
        )
      );
      if (offending.length > 0) {
        throw new Error(
          `Browser console error(s) recorded during test:\n${
            offending.map((m) => `  ${m}`).join("\n")
          }`,
        );
      }
    }
  };

  #afterAll = async () => {
    if (this.#page) {
      await getPresentationSession()?.close(this.#page);
    }
    await this.#disposePageRuntime();
    await this.#page?.close();
    await this.#browser?.close();
  };

  #checkIsOk() {
    if (!this.#page) throw new Error("Page not initialized.");
  }

  async #disposePageRuntime(): Promise<void> {
    const page = this.#page;
    if (!page) return;
    // Before disposing: the worker owns the collector, and disposing the
    // runtime takes it with it.
    await collectPatternCoverage(page);
    try {
      await page.evaluate(async () => {
        await globalThis.commonfabric?.rt?.dispose();
        if (globalThis.commonfabric) {
          globalThis.commonfabric.rt = undefined;
        }
      });
    } catch (error) {
      console.warn("Failed to dispose shell page runtime:", error);
    }
  }

  #attachPage(page: Page) {
    // Every navigation this page performs returns only once the shell behind
    // it can be driven, so a test that reloads reaches a booted shell.
    page.addAfterNavigationHook(() => waitForShellReady(page));
    page.addEventListener("console", (e: ConsoleEvent) => {
      if (e.detail.type === "error") {
        this.#errorLogs.push(e.detail.text);
      }
      if (this.#config.pipeConsole) {
        pipeConsole(e);
      }
    });
    page.addEventListener("dialog", dismissDialogs);
    page.addEventListener("pageerror", (e: PageErrorEvent) => {
      console.error("Browser Page Error:", e.detail.message);
      this.#exceptions.push(e.detail.message);
    });
  }
}
