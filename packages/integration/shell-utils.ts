import {
  Browser,
  dismissDialogs,
  env,
  Page,
  pipeConsole,
} from "@commontools/integration";
import {
  Identity,
  InsecureCryptoKeyPair,
  serializeKeyPairRaw,
  TransferrableInsecureCryptoKeyPair,
} from "@commontools/identity";
import { afterAll, afterEach, beforeAll, beforeEach } from "@std/testing/bdd";
import {
  AppState,
  AppView,
  appViewToUrlPath,
  deserialize,
  isAppViewEqual,
} from "@commontools/shell/shared";
import { waitFor } from "./utils.ts";
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
    [TransferrableInsecureCryptoKeyPair]
  >(
    async (rawId) => {
      await globalThis.app.setIdentity(rawId);
    },
    {
      args: [transferrableId],
    },
  );
}

export interface ShellIntegrationConfig {
  pipeConsole?: boolean;
}

export class ShellIntegration {
  #browser?: Browser;
  #page?: Page;
  #exceptions: Array<string> = [];
  #errorLogs: Array<string> = [];
  #config: ShellIntegrationConfig;

  constructor(config: ShellIntegrationConfig = {}) {
    this.#config = {
      pipeConsole: config.pipeConsole ?? env.PIPE_CONSOLE,
    };
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
    await this.waitForState({ view });
    if (identity) {
      await this.login(identity);
      await this.waitForState({ identity, view });
    }
  }

  /**
   * Collect scheduler timing stats from the worker via RuntimeClient IPC.
   * Returns a summary object suitable for console.log or JSON serialization.
   * Call this at the end of a test to capture performance data.
   */
  async collectWorkerTimingStats(): Promise<
    {
      pullMode: boolean;
      scheduler: Record<
        string,
        { count: number; p50: number; p95: number; max: number }
      >;
      counts: Record<string, number>;
    } | null
  > {
    this.checkIsOk();
    const page = this.page();
    try {
      return await page.evaluate(async () => {
        const rt = (globalThis as any).commontools?.rt;
        if (!rt?.getLoggerCounts) return null;
        const data = await rt.getLoggerCounts();

        // Extract scheduler timings
        const scheduler: Record<
          string,
          { count: number; p50: number; p95: number; max: number }
        > = {};
        const schedulerTimings = data.timing?.["scheduler"];
        if (schedulerTimings) {
          for (const [key, t] of Object.entries(schedulerTimings) as any) {
            if (t.count > 0) {
              scheduler[key] = {
                count: t.count,
                p50: t.p50,
                p95: t.p95,
                max: t.max,
              };
            }
          }
        }

        // Extract total counts per logger
        const counts: Record<string, number> = {};
        if (data.counts) {
          for (const [name, c] of Object.entries(data.counts) as any) {
            if (name !== "total" && c.total > 0) counts[name] = c.total;
          }
        }

        // Check pull mode
        const pullMode = data.metadata?.["scheduler"]
          ? true // metadata presence doesn't tell us, but we can infer
          : false;

        return { pullMode, scheduler, counts };
      });
    } catch {
      return null;
    }
  }

  /**
   * Print a summary of worker timing stats to the console.
   */
  async printWorkerTimingStats(): Promise<void> {
    const stats = await this.collectWorkerTimingStats();
    if (!stats) {
      console.log("[PERF] Could not collect worker timing stats");
      return;
    }

    const parts: string[] = [];
    for (const [key, t] of Object.entries(stats.scheduler)) {
      parts.push(
        `${key}: n=${t.count} p50=${t.p50.toFixed(1)}ms p95=${
          t.p95.toFixed(1)
        }ms`,
      );
    }
    if (parts.length > 0) {
      console.log(`[PERF] Scheduler: ${parts.join(", ")}`);
    }
    if (Object.keys(stats.counts).length > 0) {
      const countParts = Object.entries(stats.counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, v]) => `${k}=${v}`);
      console.log(`[PERF] Log counts: ${countParts.join(", ")}`);
    }
  }

  #beforeAll = async () => {
    this.#browser = await Browser.launch({ headless: env.HEADLESS });
    this.#page = await this.#browser.newPage();
    this.#page.addEventListener("console", (e: ConsoleEvent) => {
      if (e.detail.type === "error") {
        this.#errorLogs.push(e.detail.text);
      }
      if (this.#config.pipeConsole) {
        pipeConsole(e);
      }
    });
    this.#page.addEventListener("dialog", dismissDialogs);
    this.#page.addEventListener("pageerror", (e: PageErrorEvent) => {
      console.error("Browser Page Error:", e.detail.message);
      this.#exceptions.push(e.detail.message);
    });
  };

  #beforeEach = () => {
    this.#exceptions.length = 0;
    this.#errorLogs.length = 0;
  };

  #afterEach = () => {
    if (this.#exceptions.length > 0) {
      throw new Error(`Exceptions recorded: \n${this.#exceptions.join("\n")}`);
    }
    // TODO(CT-840)
    // if (this.#errorLogs.length > 0) {
    //  throw new Error(`Errors logged: \n${this.#errorLogs.join("\n")}`);
    // }
  };

  #afterAll = async () => {
    await this.#page?.close();
    await this.#browser?.close();
  };

  private checkIsOk() {
    if (!this.#page) throw new Error("Page not initialized.");
  }
}
