import { afterAll, afterEach, beforeAll, beforeEach } from "@std/testing/bdd";

import { ConsoleEvent, PageErrorEvent } from "@astral/astral";
import {
  Identity,
  InsecureCryptoKeyPair,
  serializeKeyPairRaw,
  TransferrableInsecureCryptoKeyPair,
} from "@commonfabric/identity";
import {
  Browser,
  dismissDialogs,
  env,
  Page,
  pipeConsole,
  type PresentationParticipant,
} from "@commonfabric/integration";
import {
  AppView,
  appViewToUrlPath,
  isAppViewEqual,
} from "@commonfabric/navigation";
import { AppState, deserialize } from "@commonfabric/shell/app-state";

import { describeThrown } from "./describe-thrown.ts";
import {
  collectPatternCoverage,
  enablePatternCoverage,
} from "./pattern-coverage.ts";
import { getPresentationSession } from "./presentation/session.ts";
import {
  assertShellDocument,
  readAndDescribeShellPage,
} from "./shell-page-probe.ts";
import { waitFor, waitForCondition } from "./utils.ts";

import "../shell/src/globals.ts";

// Pass the key over the boundary. When the state is returned,
// the key is serialized to Uint8Arrays, and then turned into regular arrays,
// which can then by transferred across the astral boundary.
//
// The passed in identity must use the `noble` implementation, which
// contains raw private key material.
export async function login(page: Page, identity: Identity): Promise<void> {
  const transferrableId = serializeKeyPairRaw(
    identity.serialize() as InsecureCryptoKeyPair,
  );

  if (!transferrableId) {
    throw new Error(
      "Could not serialize identity. Requires 'noble' implementation.",
    );
  }

  // Everything from here on runs against the page, and every way it can fail
  // says nothing about the page it failed against. The wait below is for the
  // shell to publish itself, which a document that is not the shell never
  // does, so it runs to the stuck-condition net reporting only that five
  // minutes passed. The runtime handshake that follows reports which of its
  // two stages ran out, and no more than that.
  try {
    await loginToPublishedApp(page, transferrableId, identity.did());
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
  transferrableId: TransferrableInsecureCryptoKeyPair,
  nextDID: string,
): Promise<void> {
  await waitForCondition(page, () => globalThis.app !== undefined);

  await page!.evaluate<
    Promise<void>,
    [TransferrableInsecureCryptoKeyPair, string]
  >(
    async (rawId, nextDID) => {
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
      await globalThis.app.setIdentity(rawId);
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
      args: [transferrableId, nextDID],
    },
  );
}

// How an `AppState` reads in a failure message. The identity is named by its
// DID, which the serialized state a page probe reads does not carry.
function describeAppState(state: AppState | undefined): string {
  if (!state) return "none (the page never yielded a state)";
  const identity = state.identity ? state.identity.did() : "none";
  return `view ${JSON.stringify(state.view)}, identity ${identity}`;
}

/**
 * The indented detail block a failed {@link ShellIntegration.waitForState}
 * reports: what the wait was for, the last state it managed to read, and what
 * `page` holds now.
 *
 * The two states answer different questions. `lastState` is what the wait saw,
 * decoded in the test process, so it names the identity by DID. The page probe
 * is read at failure time and covers the case the wait itself cannot describe:
 * a document that is not the shell, where no state was ever there to read.
 */
export async function describeStateWaitFailure(
  page: Page,
  params: { view: AppView; identity?: Identity },
  lastState: AppState | undefined,
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
    this.checkIsOk();
    return this.#page!;
  }

  // Browser-level CDP websocket endpoint, for attaching a second CDP client
  // (e.g. `CdpWorkerProfiler`).
  wsEndpoint(): string {
    this.checkIsOk();
    return this.#browser!.wsEndpoint();
  }

  async newPage(url?: string): Promise<Page> {
    this.checkIsOk();
    const page = await this.#browser!.newPage(url);
    this.#attachPage(page);
    return page;
  }

  async state(): Promise<AppState | undefined> {
    this.checkIsOk();
    const page = this.page();
    const state = await page.evaluate(() => {
      return globalThis.app ? globalThis.app.serialize() : undefined;
    });
    return state ? deserialize(state) : undefined;
  }

  // Login to the initialized app with provided identity.
  async login(identity: Identity): Promise<void> {
    await login(this.page(), identity);
  }

  async disposeRuntime(): Promise<void> {
    await this.#disposePageRuntime();
  }

  // Wait for the app state to match all properties
  // provided here. Throws if timeout is reached.
  //
  // If waiting for only `spaceName`, for example,
  // the function returns successfully once state
  // has a matching `spaceName`, ignoring all other properties.
  async waitForState(
    params: {
      view: AppView;
      identity?: Identity;
    },
  ): Promise<AppState> {
    function stateMatches(
      state: AppState | undefined,
      params: Parameters<typeof ShellIntegration.prototype.waitForState>[0],
    ): boolean {
      return !!(
        state &&
        isAppViewEqual(state.view, params.view) &&
        (params.identity
          ? state.identity?.did() === params.identity.did()
          : true)
      );
    }

    this.checkIsOk();

    // The last state the poll below managed to read. A failure reports it, so
    // the message says what the wait actually saw rather than only that it
    // never saw what it wanted.
    let lastState: AppState | undefined;
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
  // If `identity` provided, logs in with the identity
  // after navigation.
  async goto(
    { frontendUrl, view, identity }: {
      frontendUrl: string;
      view: AppView;
      identity?: Identity;
    },
  ): Promise<void> {
    this.checkIsOk();

    // Strip the proceeding "/" in the url path
    const path = appViewToUrlPath(view).substring(1);

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
      // Before disposing: the worker owns the collector, and disposing the
      // runtime takes it with it.
      await collectPatternCoverage(this.#page);
    }
    await this.#disposePageRuntime();
    await this.#page?.close();
    await this.#browser?.close();
  };

  private checkIsOk() {
    if (!this.#page) throw new Error("Page not initialized.");
  }

  async #disposePageRuntime(): Promise<void> {
    const page = this.#page;
    if (!page) return;
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
