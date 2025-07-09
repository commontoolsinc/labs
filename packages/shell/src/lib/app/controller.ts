import { Identity } from "@commontools/identity";
import { XRootView } from "../../views/RootView.ts";
import { Command } from "../commands.ts";
import { AppUpdateEvent } from "./mod.ts";

// Interact with application state outside of the application.
export class AppController extends EventTarget {
  #element: XRootView;
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

  async setSpace(spaceName: string) {
    await this.apply({ type: "set-space", spaceName });
  }

  async setActiveCharmId(charmId: string) {
    await this.apply({ type: "set-active-charm-id", charmId });
  }

  async setIdentity(identity: Identity) {
    await this.apply({ type: "set-identity", identity });
  }

  apply(command: Command): Promise<void> {
    return this.#element.apply(command);
  }
}
