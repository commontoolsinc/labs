import { css, html, PropertyValues } from "lit";
import {
  applyCommand,
  AppState,
  AppUpdateEvent,
  clone,
  Command,
  isAppViewEqual,
  isCommand,
} from "../../shared/mod.ts";
import { BaseView, createDefaultAppState, SHELL_COMMAND } from "./BaseView.ts";
import { KeyStore } from "@commontools/identity";
import { property, state } from "lit/decorators.js";
import { Task } from "@lit/task";
import { type RuntimeClient } from "@commontools/runtime-client";
import { type DID } from "@commontools/identity";
import { RuntimeInternals } from "../lib/runtime.ts";
import { runtimeContext, spaceContext } from "@commontools/ui";
import { provide } from "@lit/context";

// The root element for the shell application.
//
// Derives `RuntimeInternals` for the application from its `AppState`.
// `Command` mutates the app state, which can be fired as events
// from children elements.
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
  app = createDefaultAppState();

  @property()
  keyStore?: KeyStore;

  @provide({ context: runtimeContext })
  @state()
  private runtime?: RuntimeClient;

  @provide({ context: spaceContext })
  @state()
  private space?: DID;

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

        if (!app || !app.identity) {
          // Clear the runtime and space when no app state
          this.runtime = undefined;
          this.space = undefined;
          if (globalThis.commontools) {
            globalThis.commontools.rt = undefined;
          }
          return undefined;
        }

        const rt = await RuntimeInternals.create({
          identity: app.identity,
          view: app.view,
          apiUrl: app.apiUrl,
        });

        if (signal.aborted) {
          rt.dispose().catch(console.error);
          this.runtime = undefined;
          this.space = undefined;
          if (globalThis.commontools) {
            globalThis.commontools.rt = undefined;
          }
          return;
        }

        // Update the provided runtime and space values
        this.runtime = rt.runtime();
        this.space = rt.space() as DID;

        // Expose RuntimeClient for console debugging
        // (e.g. commontools.rt.setLoggerLevel("debug"))
        if (!globalThis.commontools) {
          (globalThis as any).commontools = {};
        }
        globalThis.commontools.rt = this.runtime;

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
    if (!changedProperties.has("app")) {
      return;
    }
    const previous = changedProperties.get("app");
    const current = this.app;

    // If the first set, or if removed, run
    const flipState = (!previous && current) ||
      !current;

    let spaceChanged = false;
    if (previous && !isAppViewEqual(previous.view, current.view)) {
      // Check that if the view has changed, we may still
      // be in the same space
      if ("spaceName" in previous.view && "spaceName" in current.view) {
        spaceChanged = previous.view.spaceName !== current.view.spaceName;
      } else {
        spaceChanged = true;
      }
    }

    // If host, view's space, or identity changes, we'll
    // need to recreate the runtime.
    const stateChanged = !!previous &&
      (previous.apiUrl !== current.apiUrl ||
        previous.identity !== current.identity || spaceChanged);

    if (flipState || stateChanged) {
      this._rt.run([current]);
    }
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
    return clone(this.app);
  }

  private processCommand(command: Command) {
    try {
      // Apply command synchronously for state changes
      const state = applyCommand(this.app, command);
      this.app = state;
      this.dispatchEvent(new AppUpdateEvent(command, { state }));
    } catch (e) {
      const error = e as Error;
      this.dispatchEvent(
        new AppUpdateEvent(command, { error: error as Error }),
      );
      throw new Error(error.message, { cause: error });
    }
  }

  getRuntimeSpaceDID(): DID | undefined {
    return this._rt.value?.space();
  }

  override render() {
    return html`
      <x-app-view
        .app="${this.app}"
        .keyStore="${this.keyStore}"
        .rt="${this._rt.value}"
      ></x-app-view>
    `;
  }
}

globalThis.customElements.define("x-root-view", XRootView);
