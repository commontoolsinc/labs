import { css, html, PropertyValues } from "lit";
import {
  applyCommand,
  AppState,
  AppUpdateEvent,
  clone,
  Command,
  isAppViewEqual,
  isCommand,
  navigate,
} from "../../shared/mod.ts";
import { BaseView, createDefaultAppState, SHELL_COMMAND } from "./BaseView.ts";
import { KeyStore } from "@commonfabric/identity";
import { property, state } from "lit/decorators.js";
import { Task } from "@lit/task";
import { type RuntimeClient } from "@commonfabric/runtime-client";
import { type DID } from "@commonfabric/identity";
import { resolveSpaceDid, RuntimeInternals } from "@commonfabric/lib-shell";
import { shouldRecreateRuntime } from "../lib/runtime-lifecycle.ts";
import { createVDomDebugHelpers } from "@commonfabric/html/debug";
import { createDebugUtils, createViewSettled } from "../lib/debug-utils.ts";
import { runtimeContext, spaceContext } from "@commonfabric/ui";
import { provide } from "@lit/context";
import {
  getThemePreference,
  type ThemePreference,
} from "../lib/theme-preference.ts";
import { EXPERIMENTAL } from "../lib/env.ts";

type CommonfabricDebugState = Partial<ReturnType<typeof createDebugUtils>> & {
  rt?: RuntimeClient;
  viewSettled?: () => Promise<void>;
  vdom?: ReturnType<typeof createVDomDebugHelpers>;
  detectNonIdempotent?: (durationMs?: number) => Promise<unknown>;
};

function getCommonfabricGlobal(): typeof globalThis & {
  commonfabric?: CommonfabricDebugState;
} {
  return globalThis as typeof globalThis & {
    commonfabric?: CommonfabricDebugState;
  };
}

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
      height: 100dvh;
      overflow: hidden;
    }

    #body {
      height: 100%;
      width: 100%;
    }
  `;

  @state()
  accessor app = createDefaultAppState();

  @state()
  private accessor _themePreference: ThemePreference = getThemePreference();

  @property()
  accessor keyStore: KeyStore | undefined = undefined;

  @provide({ context: runtimeContext })
  @state()
  private accessor runtime: RuntimeClient | undefined = undefined;

  @provide({ context: spaceContext })
  @state()
  private accessor space: DID | undefined = undefined;

  // The runtime task runs when AppState changes, and determines if a
  // new RuntimeInternals must be created — only when identity or host
  // (apiUrl) change; one runtime serves every space. This is manually
  // run in `updated()` because we want to compare to previous values,
  // leaving this function responsible for cleaning up previous
  // runtimes, and creating a new one.
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
          const global = getCommonfabricGlobal();
          if (global.commonfabric) {
            global.commonfabric.rt = undefined;
            global.commonfabric.viewSettled = undefined;
          }
          return undefined;
        }

        const rt = await RuntimeInternals.create({
          identity: app.identity,
          apiUrl: app.apiUrl,
          experimental: EXPERIMENTAL,
          // lib-shell emits address-shaped targets ({spaceDid, pieceId});
          // mapNavigationView (shared/navigate.ts) maps a DID back to the
          // human-readable spaceName URL at the Navigation layer.
          navigate,
        });

        if (signal.aborted) {
          rt.dispose().catch(console.error);
          this.runtime = undefined;
          this.space = undefined;
          const global = getCommonfabricGlobal();
          if (global.commonfabric) {
            global.commonfabric.rt = undefined;
            global.commonfabric.viewSettled = undefined;
          }
          return;
        }

        // Update the provided runtime; `space` is view state, resolved
        // from app.view in updated() independent of the runtime's life.
        this.runtime = rt.runtime();

        // Expose RuntimeClient for console debugging
        // (e.g. commonfabric.rt.setLoggerLevel("debug"))
        const global = getCommonfabricGlobal();
        global.commonfabric ??= {};
        global.commonfabric.rt = this.runtime;
        global.commonfabric.viewSettled = createViewSettled(() => this.runtime);
        global.commonfabric.vdom = createVDomDebugHelpers();
        global.commonfabric.detectNonIdempotent = async (
          durationMs = 5000,
        ) => {
          const result = await rt.runtime().detectNonIdempotent(durationMs);
          console.table(
            result.nonIdempotent.map((r: any) => ({
              action: r.actionId,
              differingWrites: r.differingWriteKeys.join(", "),
            })),
          );
          console.log("Cycles:", result.cycles);
          return result;
        };

        // Debug utilities for inspecting cell values from the console
        const debugUtils = createDebugUtils(
          () => this.space as DID,
          () => this.runtime,
        );
        global.commonfabric.readCell = debugUtils.readCell;
        global.commonfabric.readArgumentCell = debugUtils.readArgumentCell;
        global.commonfabric.subscribeToCell = debugUtils.subscribeToCell;
        global.commonfabric.watchWrites = debugUtils.watchWrites;
        global.commonfabric.getWriteStackTrace = debugUtils.getWriteStackTrace;
        global.commonfabric.explainTriggerTrace =
          debugUtils.explainTriggerTrace;

        return rt;
      },
    },
  );

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener(SHELL_COMMAND, this.onCommand);
    document.addEventListener(
      "theme-preference-changed",
      this._onThemeChanged,
    );
  }

  override disconnectedCallback(): void {
    this.removeEventListener(SHELL_COMMAND, this.onCommand);
    document.removeEventListener(
      "theme-preference-changed",
      this._onThemeChanged,
    );
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

    const stateChanged = !!previous &&
      shouldRecreateRuntime(previous, current);

    if (flipState || stateChanged) {
      this._rt.run([current]);
    }
    if (
      flipState || stateChanged ||
      (previous && !isAppViewEqual(previous.view, current.view))
    ) {
      void this.#resolveViewSpace(current);
    }
  }

  // Resolve the current view to a space DID — view state, independent of
  // the runtime's lifecycle.
  #resolveSpaceToken = 0;
  async #resolveViewSpace(app: AppState | undefined): Promise<void> {
    const token = ++this.#resolveSpaceToken;
    let space: DID | undefined;
    const identity = app?.identity;
    const view = app?.view;
    if (identity && view) {
      if ("builtin" in view) {
        space = view.builtin === "home" ? identity.did() : undefined;
      } else if ("spaceDid" in view) {
        space = view.spaceDid;
      } else if ("spaceName" in view) {
        try {
          space = await resolveSpaceDid(identity, view.spaceName);
        } catch (error) {
          console.error("[RootView] Failed to resolve space name:", error);
          space = undefined;
        }
      }
    }
    if (token !== this.#resolveSpaceToken) return;
    this.space = space;
  }

  private _onThemeChanged = (e: Event) => {
    this._themePreference = (e as CustomEvent).detail;
  };

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
    return this.space;
  }

  override render() {
    return html`
      <cf-theme .theme="${{ colorScheme: this._themePreference }}">
        <x-app-view
          .app="${this.app}"
          .keyStore="${this.keyStore}"
          .rt="${this._rt.value}"
          .space="${this.space}"
        ></x-app-view>
      </cf-theme>
    `;
  }
}

globalThis.customElements.define("x-root-view", XRootView);
