import { css, html, PropertyValues } from "lit";
import { applyCommand, AppState } from "../lib/app/mod.ts";
import { BaseView, SHELL_COMMAND } from "./BaseView.ts";
import { Command, isCommand } from "../lib/app/commands.ts";
import { API_URL } from "../lib/env.ts";
import { AppUpdateEvent } from "../lib/app/events.ts";
import { clone } from "../lib/app/state.ts";
import { KeyStore } from "@commontools/identity";
import { property, state } from "lit/decorators.js";
import { Task } from "@lit/task";
import { RuntimeInternals } from "../lib/runtime.ts";
import { Runtime } from "@commontools/runner";
import { provide } from "@lit/context";
import { runtimeContext, sessionContext, type SessionInfo } from "@commontools/ui/v2";

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
          return undefined;
        }

        const rt = await RuntimeInternals.create({
          identity: app.identity,
          spaceName: app.spaceName,
          apiUrl: app.apiUrl,
        });

        if (signal.aborted) {
          rt.dispose().catch(console.error);
          return;
        }
        return rt;
      },
    },
  );

  // Provide the public Runtime to descendants via context so
  // components like ct-code-editor can consume it.
  @provide({ context: runtimeContext })
  private _providedRuntime: Runtime | undefined = undefined;

  // Provide lightweight session info (space, identity) for UI needs.
  @provide({ context: sessionContext })
  private _providedSession: SessionInfo | undefined = undefined;

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

    // Ensure provided context stays in sync when Task value updates.
    // Expose the public Runtime rather than internal wrapper.
    this._providedRuntime = this._rt.value?.cc().manager().runtime;

    // Keep session info in sync
    this._providedSession = {
      spaceName: current.spaceName,
      identityDid: current.identity?.did(),
      apiUrl: current.apiUrl,
    };
  }

  onCommand = (e: Event) => {
    const { detail: command } = e as CustomEvent;
    if (!isCommand(command)) {
      throw new Error(`Received a non-command: ${command}`);
    }
    this.processCommand(command);
  };

  apply(command: Command): Promise<void> {
    this.processCommand(command);
    this.requestUpdate();
    return this.updateComplete.then((_) => undefined);
  }

  state(): AppState {
    return clone(this._app);
  }

  private processCommand(command: Command) {
    try {
      // Apply command synchronouslyappProvider
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
    // Reflect latest runtime into provided context each render as well,
    // covering asynchronous Task completions.
    this._providedRuntime = this._rt.value?.cc().manager().runtime;
    this._providedSession = {
      spaceName: this._app.spaceName,
      identityDid: this._app.identity?.did(),
      apiUrl: this._app.apiUrl,
    };
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
