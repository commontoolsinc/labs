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
import { afterAll, afterEach, beforeAll } from "@std/testing/bdd";
import { AppState, deserialize } from "../shell/src/lib/app/mod.ts";
import { PageErrorEvent } from "@astral/astral";

import "../shell/src/globals.ts";
import { sleep } from "@commontools/utils/sleep";

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

export class ShellIntegration {
  #browser?: Browser;
  #page?: Page;
  #exceptions: Array<string> = [];

  bindLifecycle() {
    beforeAll(this.#beforeAll);
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
    { identity, spaceName, charmId }: {
      spaceName?: string;
      charmId?: string;
      identity?: Identity;
    },
  ): Promise<AppState> {
    this.checkIsOk();
    const start = performance.now();
    while ((performance.now() - start) < 30_000) {
      const state = await this.state();
      if (
        state && (spaceName ? state.spaceName === spaceName : true) &&
        (charmId ? state.activeCharmId === charmId : true) &&
        (identity ? state.identity?.did() === identity.did() : true)
      ) {
        return state;
      }
      await sleep(500);
    }
    throw new Error("Timed out while waiting for state.");
  }

  // Navigates to the URL represented by `frontendUrl`,
  // `spaceName`, and `charmId`. Waits for state to settle
  // reflecting these properties.
  //
  // If `identity` provided, logs in with the identity
  // after navigation.
  async goto(
    { frontendUrl, spaceName, charmId, identity }: {
      frontendUrl: string;
      spaceName: string;
      charmId?: string;
      identity?: Identity;
    },
  ): Promise<void> {
    this.checkIsOk();
    const url = `${frontendUrl}${spaceName}${charmId ? `/${charmId}` : ""}`;
    const page = this.page();
    await page.goto(url);
    await page.applyConsoleFormatter();
    await this.waitForState({ spaceName, charmId });
    if (identity) {
      await this.login(identity);
      await this.waitForState({ identity, spaceName, charmId });
    }
  }

  #beforeAll = async () => {
    this.#browser = await Browser.launch({ headless: env.HEADLESS });
    this.#page = await this.#browser.newPage();
    this.#page.addEventListener("console", pipeConsole);
    this.#page.addEventListener("dialog", dismissDialogs);
    this.#page.addEventListener("pageerror", (e: PageErrorEvent) => {
      console.error("Browser Page Error:", e.detail.message);
      this.#exceptions.push(e.detail.message);
    });
  };

  #afterAll = async () => {
    await this.#page?.close();
    await this.#browser?.close();
  };

  #afterEach = () => {
    if (this.#exceptions.length > 0) {
      throw new Error(`Exceptions recorded: \n${this.#exceptions.join("\n")}`);
    }
  };

  private checkIsOk() {
    if (!this.#page) throw new Error("Page not initialized.");
  }
}
