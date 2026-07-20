import {
  Browser,
  dismissDialogs,
  env,
  Page,
  pipeConsole,
  type PresentationParticipant,
} from "@commonfabric/integration";
import { getPresentationSession } from "./presentation/session.ts";
import {
  Identity,
  InsecureCryptoKeyPair,
  serializeKeyPairRaw,
  TransferrableInsecureCryptoKeyPair,
} from "@commonfabric/identity";
import { afterAll, afterEach, beforeAll, beforeEach } from "@std/testing/bdd";
import {
  AppState,
  AppView,
  appViewToUrlPath,
  deserialize,
  isAppViewEqual,
} from "@commonfabric/shell/shared";
import { waitFor } from "./utils.ts";
import {
  collectPatternCoverage,
  enablePatternCoverage,
} from "./pattern-coverage.ts";
import { ConsoleEvent, PageErrorEvent } from "@astral/astral";

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

  await page!.evaluate<
    Promise<void>,
    [TransferrableInsecureCryptoKeyPair, string]
  >(
    async (rawId, nextDID) => {
      const currentIdentity = globalThis.app.state().identity;
      if (currentIdentity && currentIdentity.did() !== nextDID) {
        await globalThis.app.apply({
          type: "set-identity",
          identity: undefined,
        });
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
      args: [transferrableId, identity.did()],
    },
  );
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

    await waitFor(async () => {
      return stateMatches(await this.state(), params);
    });
    const state = await this.state();
    // Unlikely to occur, but recheck state once more to ensure
    // the state returned explicitly matches requirement.
    if (!state || !(stateMatches(state, params))) {
      throw new Error("State changed after matching requirements.");
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
