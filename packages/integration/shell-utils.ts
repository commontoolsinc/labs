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
    this.#config = config;
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
