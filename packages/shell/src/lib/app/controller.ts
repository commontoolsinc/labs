import {
  Identity,
  isKeyPairRaw,
  KeyPairRaw,
  KeyStore,
} from "@commontools/identity";
import { XRootView } from "../../views/RootView.ts";
import { Command } from "./commands.ts";
import { AppState, AppUpdateEvent } from "./mod.ts";

// Key store key name for user's key
export const ROOT_KEY = "$ROOT_KEY";

// Interact with application state outside of the application.
export class App extends EventTarget {
  #element: XRootView;
  identity: any;
  spaceName: any;
  apiUrl: any;
  constructor(element: XRootView) {
    super();
    this.#element = element;
    this.#element.addEventListener("appupdate", (event: Event) => {
      const e = event as AppUpdateEvent;
      this.dispatchEvent(
        new AppUpdateEvent(e.command, { state: e.state, error: e.error }),
      );
    });
  }

  state(): AppState {
    return this.#element.state();
  }

  async setSpace(spaceName: string) {
    await this.apply({ type: "set-space", spaceName });
  }

  async setActiveCharmId(charmId: string) {
    await this.apply({ type: "set-active-charm-id", charmId });
  }

  async setIdentity(id: Identity | KeyPairRaw) {
    const identity = isKeyPairRaw(id)
      ? await Identity.fromRaw(id.privateKey as Uint8Array<ArrayBufferLike>)
      : id;
    await this.apply({ type: "set-identity", identity });
  }

  apply(command: Command): Promise<void> {
    return this.#element.apply(command);
  }

  async initializeKeys(): Promise<void> {
    const ks = await KeyStore.open();
    this.#element.keyStore = ks;
    this.#element.requestUpdate("keyStore", undefined);
    const root = await ks.get(ROOT_KEY);
    if (root) {
      await app.setIdentity(root);
    }
  }
}
