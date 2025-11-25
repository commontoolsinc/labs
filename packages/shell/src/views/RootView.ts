import { css, html, PropertyValues } from "lit";
import { applyCommand, AppState } from "../lib/app/mod.ts";
import { BaseView, SHELL_COMMAND } from "./BaseView.ts";
import { Command, isCommand } from "../lib/app/commands.ts";
import { API_URL } from "../lib/env.ts";
import { AppUpdateEvent } from "../lib/app/events.ts";
import { clone } from "../lib/app/state.ts";
import { KeyStore } from "@commontools/identity";
import { property, state } from "lit/decorators.js";
import { provide } from "@lit/context";
import { Task } from "@lit/task";
import { type MemorySpace, Runtime } from "@commontools/runner";
import { RuntimeInternals } from "../lib/runtime.ts";
import { runtimeContext, spaceContext } from "@commontools/ui";

// The root element for the shell application.
// Handles processing `Command`s from children elements,
// updating the `AppState`, and providing changes
// to children elements.
export class XRootView extends BaseView {
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

  @state()
  // Non-private for typing in `updated()` callback
  _app = { apiUrl: API_URL } as AppState;

  @property()
  keyStore?: KeyStore;

  // The runtime instance provided to descendant components via context
  @provide({ context: runtimeContext })
  @state()
  private runtime?: Runtime;

  // The current space name provided to descendant components via context
  @provide({ context: spaceContext })
  @state()
  private space?: MemorySpace;

  // The runtime task runs when AppState changes, and determines
  // if a new RuntimeInternals must be created, like when
  // identity or space change. This is manually run in `updated()`
  // because we want to compare to previous values, leaving this
  // function responsible for cleaning up previous runtimes, and
  // creating a new one.
  private _rt = new Task<[AppState | undefined], RuntimeInternals | undefined>(
    this,
    {
      // Do not define `args` -- this is run in "manual mode",
      // or manually triggered from parsing `AppState` in `updated()`
      // to determine if we need to dispose or recreate a runtime,
      // whereas in a task we don't have access to necessary info
      // like previous app state.
      task: async ([app]: [AppState | undefined], { signal }) => {
        const previous = this._rt.value;
        if (previous) {
          previous.dispose().catch(console.error);
        }

        if (!app || !app.spaceName || !app.identity) {
          // Clear the runtime and space when no app state
          this.runtime = undefined;
          this.space = undefined;
          return undefined;
        }

        const rt = await RuntimeInternals.create({
          identity: app.identity,
          spaceName: app.spaceName,
          apiUrl: app.apiUrl,
        });

        if (signal.aborted) {
          rt.dispose().catch(console.error);
          this.runtime = undefined;
          this.space = undefined;
          return;
        }

        // Update the provided runtime and space values
        this.runtime = rt.runtime();
        this.space = rt.space() as MemorySpace; // Use the DID from the session

        return rt;
      },
    },
  );

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener(SHELL_COMMAND, this.onCommand);
  }

  override disconnectedCallback(): void {
    this.removeEventListener(SHELL_COMMAND, this.onCommand);
    super.disconnectedCallback();
  }

  protected override updated(changedProperties: PropertyValues<this>): void {
    if (!changedProperties.has("_app")) {
      return;
    }
    const previous = changedProperties.get("_app");
    const current = this._app;

    // If the first set, or if removed, run
    const flipState = (!previous && current) ||
      !current;

    // If host, space, or identity changes, we'll
    // need to recreate the runtime.
    const stateChanged = !!previous &&
      (previous.apiUrl !== current.apiUrl ||
        previous.spaceName !== current.spaceName ||
        previous.identity !== current.identity);

    if (flipState || stateChanged) {
      this._rt.run([current]);
    }
  }

  onCommand = (e: Event) => {
    const { detail: command } = e as CustomEvent;
    if (!isCommand(command)) {
      throw new Error(`Received a non-command: ${command}`);
    }
    this.processCommand(command).catch(console.error);
  };

  async apply(command: Command): Promise<void> {
    await this.processCommand(command);
    this.requestUpdate();
    return this.updateComplete.then((_) => undefined);
  }

  state(): AppState {
    return clone(this._app);
  }

  private async processCommand(command: Command) {
    try {
      // Handle async commands that don't affect state
      if (command.type === "toggle-favorite") {
        const rt = this._rt.value;
        if (!rt) return;

        const manager = rt.cc().manager();
        const charm = await rt.cc().get(command.charmId, true);
        const isFavorite = manager.isFavorite(charm.getCell());

        if (isFavorite) {
          await manager.removeFavorite(charm.getCell());
        } else {
          await manager.addFavorite(charm.getCell());
        }

        // Trigger HeaderView to update its favorite state
        this.dispatchEvent(
          new CustomEvent("favorite-changed", {
            detail: { charmId: command.charmId, isFavorite: !isFavorite },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }

      // Apply command synchronously for state changes
      const state = applyCommand(this._app, command);
      this._app = state;
      this.dispatchEvent(new AppUpdateEvent(command, { state }));
    } catch (e) {
      const error = e as Error;
      this.dispatchEvent(
        new AppUpdateEvent(command, { error: error as Error }),
      );
      throw new Error(error.message, { cause: error });
    }
  }

  override render() {
    return html`
      <x-app-view
        .app="${this._app}"
        .keyStore="${this.keyStore}"
        .rt="${this._rt.value}"
      ></x-app-view>
    `;
  }
}

globalThis.customElements.define("x-root-view", XRootView);
