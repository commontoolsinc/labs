import { css, html, LitElement } from "lit";
import { ContextProvider } from "@lit/context";
import { applyCommand, AppState } from "../lib/app/mod.ts";
import { appContext } from "../contexts/app.ts";
import { Runtime } from "@commontools/runner";
import { SHELL_COMMAND } from "./BaseView.ts";
import { Command, isCommand } from "../lib/commands.ts";
import { API_URL } from "../lib/env.ts";
import { AppUpdateEvent } from "../lib/app/events.ts";
import { WorkQueue } from "../lib/queue.ts";
import { clone } from "../lib/app/state.ts";

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
      background-color: #eee;
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
    initialValue: { apiUrl: API_URL },
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
    try {
      const state = await applyCommand(this._provider.value, command);
      this._provider.setValue(state);
      this.dispatchEvent(new AppUpdateEvent(command, { state }));
    } catch (e) {
      const error = e as Error;
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
