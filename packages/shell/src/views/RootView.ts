import { css, html, LitElement } from "lit";
import { ContextProvider } from "@lit/context";
import { applyCommand, AppState } from "../lib/app/mod.ts";
import { appContext } from "../contexts/app.ts";
import { SHELL_COMMAND } from "./BaseView.ts";
import { Command, isCommand } from "../lib/commands.ts";
import { API_URL } from "../lib/env.ts";
import { AppUpdateEvent } from "../lib/app/events.ts";
import { WorkQueue } from "../lib/queue.ts";
import { clone, ROOT_KEY } from "../lib/app/state.ts";
import { KeyStore } from "@commontools/identity";

// The root element for the shell application.
// Handles processing `Command`s from children elements,
// updating the `AppState`, and providing changes
// to children elements subscribing to app state lit context.
export class XRootView extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100vh;
      padding: var(--padding-desktop, 15px);
    }

    @media (max-width: 767px) {
      :host {
        padding: var(--padding-mobile, 5px);
      }
    }

    #body {
      height: 100%;
      width: 100%;
    }
  `;

  // The `@provide` decorator does not seem
  // to support propagating reactive changes to subscribers.
  // Directly using the ContextProvider class allows
  // us to manually apply updates, which consumers respect.
  private _provider = new ContextProvider(this, {
    context: appContext,
    initialValue: {
      apiUrl: API_URL,
      spaceName: "common-knowledge", // Default space
    },
  });

  #commandQueue: WorkQueue<Command>;

  constructor() {
    super();
    this.#commandQueue = new WorkQueue(this.onCommandProcess);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener(SHELL_COMMAND, this.onCommand);
  }

  override disconnectedCallback(): void {
    this.removeEventListener(SHELL_COMMAND, this.onCommand);
    super.disconnectedCallback();
  }

  onCommand = async (e: Event) => {
    const { detail: command } = e as CustomEvent;
    if (!isCommand(command)) {
      throw new Error(`Received a non-command: ${command}`);
    }
    await this.apply(command);
  };

  apply(command: Command): Promise<void> {
    return this.#commandQueue.submit(command);
  }

  state(): AppState {
    return clone(this._provider.value);
  }

  private onCommandProcess = async (command: Command) => {
    console.log("[RootView] Processing command:", {
      type: command.type,
      hasIdentity: "identity" in command,
      timestamp: new Date().toISOString(),
    });

    try {
      // Apply command synchronously
      const state = applyCommand(this._provider.value, command);

      // Handle clear-authentication specially - need to clear ROOT_KEY from IDB
      if (command.type === "clear-authentication") {
        try {
          const keyStore = await KeyStore.open();
          await keyStore.clear();
          console.log("[RootView] Cleared ROOT_KEY from keystore");
        } catch (error) {
          console.error(
            "[RootView] Failed to clear ROOT_KEY from keystore:",
            error,
          );
        }
      }

      this._provider.setValue(state);

      if (command.type === "set-identity") {
        console.log("[RootView] Identity set in app state:", {
          did: state.identity?.did(),
        });
      }

      this.dispatchEvent(new AppUpdateEvent(command, { state }));
    } catch (e) {
      const error = e as Error;
      console.error("[RootView] Command processing error:", {
        command: command.type,
        error: error.message,
      });
      this.dispatchEvent(
        new AppUpdateEvent(command, { error: error as Error }),
      );
      throw new Error(error.message, { cause: error });
    }
  };

  override render() {
    return html`
      <x-app-view></x-app-view>
    `;
  }
}

globalThis.customElements.define("x-root-view", XRootView);
