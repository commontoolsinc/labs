import {
  Browser,
  dismissDialogs,
  env,
  Page,
  pipeConsole,
} from "@commontools/integration";
import {
  ANYONE,
  Identity,
  InsecureCryptoKeyPair,
  serializeKeyPairRaw,
  TransferrableInsecureCryptoKeyPair,
} from "@commontools/identity";
import { afterAll, afterEach, beforeAll } from "@std/testing/bdd";
import { AppState, deserialize, serialize } from "../shell/src/lib/app/mod.ts";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache";
import { CharmManager } from "@commontools/charm";
import { CharmsController } from "@commontools/charm/ops";
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

// Create a new charm using `source` in the provided space.
// Returns the charm id upon success.
export async function registerCharm(
  { apiUrl, source, identity, spaceName }: {
    apiUrl: URL;
    source: string;
    identity: Identity;
    spaceName: string;
  },
): Promise<string> {
  const account = spaceName.startsWith("~")
    ? identity
    : await Identity.fromPassphrase(ANYONE);
  const user = await account.derive(spaceName);
  const session = {
    private: account.did() === identity.did(),
    name: spaceName,
    space: user.did(),
    as: user,
  };

  const runtime = new Runtime({
    storageManager: StorageManager.open({
      as: session.as,
      address: new URL("/api/storage/memory", apiUrl),
    }),
    blobbyServerUrl: apiUrl.toString(),
  });

  let charmId: string | undefined;
  try {
    const manager = new CharmManager(session, runtime);
    await manager.synced();
    const charms = new CharmsController(manager);
    const charm = await charms.create(source);
    charmId = charm.id;
  } finally {
    await runtime.dispose();
  }
  return charmId;
}

export class ShellIntegration {
  browser?: Browser;
  _page?: Page;
  manager?: CharmManager;
  runtime?: Runtime;
  exceptions: Array<string> = [];

  bindLifecycle() {
    beforeAll(this.beforeAll);
    afterAll(this.afterAll);
    afterEach(this.afterEach);
  }

  page(): Page {
    this.checkIsOk();
    return this._page!;
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

  async setupManager(
    spaceName: string,
    apiUrl: string,
    identity: Identity,
  ): Promise<CharmManager> {
    if (this.manager) return this.manager;

    const account = spaceName.startsWith("~")
      ? identity
      : await Identity.fromPassphrase(ANYONE);
    const user = await account.derive(spaceName);
    const session = {
      private: account.did() === identity.did(),
      name: spaceName,
      space: user.did(),
      as: user,
    };

    this.runtime = new Runtime({
      storageManager: StorageManager.open({
        as: session.as,
        address: new URL("/api/storage/memory", apiUrl),
      }),
      blobbyServerUrl: apiUrl,
    });

    this.manager = new CharmManager(session, this.runtime);
    await this.manager.synced();
    return this.manager;
  }

  beforeAll = async () => {
    this.browser = await Browser.launch({ headless: env.HEADLESS });
    this._page = await this.browser.newPage();
    this._page.addEventListener("console", pipeConsole);
    this._page.addEventListener("dialog", dismissDialogs);
    this._page.addEventListener("pageerror", (e: PageErrorEvent) => {
      console.error("Browser Page Error:", e.detail.message);
      this.exceptions.push(e.detail.message);
    });
  };

  afterAll = async () => {
    await this.runtime?.dispose();
    await this._page?.close();
    await this.browser?.close();
  };

  afterEach = () => {
    if (this.exceptions.length > 0) {
      throw new Error(`Exceptions recorded: \n${this.exceptions.join("\n")}`);
    }
  };

  private checkIsOk() {
    if (!this.page) throw new Error("Page not initialized.");
  }
}
