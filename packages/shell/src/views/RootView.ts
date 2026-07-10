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
import {
  clearRuntimeDebugGlobals,
  type CommonfabricDebugState,
  exposeCommonfabricGlobals,
} from "../lib/debug-utils.ts";
import { runtimeContext, spaceContext } from "@commonfabric/ui";
import { provide } from "@lit/context";
import {
  getThemePreference,
  type ThemePreference,
} from "../lib/theme-preference.ts";
import { COMMIT_SHA, ENVIRONMENT, EXPERIMENTAL } from "../lib/env.ts";
import { runtimeHostFlags } from "../lib/host-toggles.ts";
import { type BrowserTelemetry, initBrowserOtel } from "../lib/otel.ts";

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

    /* Anchored to the BOTTOM edge: an overlay pinned to the top covers the
      header breadcrumbs and steals their (hit-tested) clicks, breaking
      space navigation until dismissed. Nothing interactive is shell-owned
      at the bottom edge. */
    #version-skew-banner {
      position: fixed;
      inset-block-end: 0;
      inset-inline: 0;
      z-index: 2000;
      display: flex;
      gap: 12px;
      align-items: center;
      justify-content: center;
      padding: 8px 16px;
      font: 500 14px/1.4 system-ui, sans-serif;
      color: #1a1a1a;
      background: #ffe8a3;
      box-shadow: 0 -1px 4px rgba(0, 0, 0, 0.2);
    }

    #version-skew-banner button {
      font: inherit;
      cursor: pointer;
      border: 1px solid rgba(0, 0, 0, 0.3);
      border-radius: 4px;
      padding: 2px 10px;
      background: rgba(255, 255, 255, 0.6);
    }
  `;

  @state()
  accessor app = createDefaultAppState();

  @state()
  private accessor _themePreference: ThemePreference = getThemePreference();

  // Set when the worker reports a version-skew (a space's toolshed build differs
  // from this client build). Surfaces a non-blocking "reload to update" banner.
  @state()
  private accessor _versionSkew = false;

  // Handler for the worker's versionSkew IPC — raises the banner.
  readonly _handleVersionSkew = (event: unknown): void => {
    console.warn(
      "[shell] version skew — a newer build is available",
      event,
    );
    this._versionSkew = true;
  };

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
          this.#telemetry = undefined;
          clearRuntimeDebugGlobals(getCommonfabricGlobal());
          return undefined;
        }

        // Browser OpenTelemetry (Phase 3): self-gated + lazy — returns null
        // (and imports no OTel SDK) unless telemetryEnabled is set. Attributes
        // use the identity's DID and the currently resolved space; the runtime
        // (and this sink) outlives navigations, so #resolveViewSpace keeps the
        // sink's space.did current via setSpace.
        const userDid = app.identity.did();
        const telemetry = await initBrowserOtel({
          apiUrl: app.apiUrl,
          userDid,
          spaceDid: this.space ?? userDid,
          environment: ENVIRONMENT,
        });
        this.#telemetry = telemetry ?? undefined;

        const rt = await RuntimeInternals.create({
          identity: app.identity,
          apiUrl: app.apiUrl,
          experimental: EXPERIMENTAL,
          // This client build's git sha, for the system-pattern auto-update
          // version-skew gate (compared to a space's toolshed /api/meta).
          clientVersion: COMMIT_SHA,
          onVersionSkew: this._handleVersionSkew,
          // Per-profile dogfood toggles: worker-console forwarding and the
          // Epic H3a render ceiling (see lib/host-toggles.ts).
          ...runtimeHostFlags(),
          // lib-shell emits address-shaped targets ({spaceDid, pieceId});
          // mapNavigationView (shared/navigate.ts) maps a DID back to the
          // human-readable spaceName URL at the Navigation layer.
          navigate,
          // Purely additive; null when telemetry is disabled.
          telemetry: telemetry ?? undefined,
        });

        if (signal.aborted) {
          rt.dispose().catch(console.error);
          this.runtime = undefined;
          this.space = undefined;
          clearRuntimeDebugGlobals(getCommonfabricGlobal());
          return;
        }

        // Update the provided runtime; `space` is view state, resolved
        // from app.view in updated() independent of the runtime's life.
        this.runtime = rt.runtime();

        // Expose the runtime and cell debug utilities for console use
        // (e.g. commonfabric.rt.setLoggerLevel("debug")).
        exposeCommonfabricGlobals(
          getCommonfabricGlobal(),
          this.runtime,
          () => this.runtime,
          () => this.space as DID,
        );

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
    globalThis.addEventListener("beforeunload", this._onBeforeUnload);
  }

  override disconnectedCallback(): void {
    this.removeEventListener(SHELL_COMMAND, this.onCommand);
    document.removeEventListener(
      "theme-preference-changed",
      this._onThemeChanged,
    );
    globalThis.removeEventListener("beforeunload", this._onBeforeUnload);
    super.disconnectedCallback();
  }

  // A page teardown (reload, tab close, external navigation) terminates the
  // runtime worker, dropping any commit the server has not yet confirmed. The
  // worker mirrors its pending-commit state to `RuntimeClient.hasPendingWrites`
  // on every transition, so this synchronous check is current; while writes are
  // unconfirmed, ask the browser to confirm leaving instead of silently losing
  // them. Commits confirm quickly (typically well under a second), so the
  // prompt only appears in the narrow window a reload would actually lose data.
  private _onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (this.runtime?.hasPendingWrites()) {
      event.preventDefault();
    }
  };

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

  // The active browser telemetry sink (undefined when telemetry is disabled
  // or no runtime); kept only so space.did attribution can track navigation.
  #telemetry: BrowserTelemetry | undefined;

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
    // Keep browser OTel span attribution in sync with the resolved space —
    // the telemetry sink lives across navigations.
    this.#telemetry?.setSpace(space);
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
      ${this._versionSkew
        ? html`
          <div id="version-skew-banner" role="status">
            <span>A newer version is available.</span>
            <button @click="${() => globalThis.location.reload()}">
              Reload
            </button>
            <button @click="${() => (this._versionSkew = false)}">
              Dismiss
            </button>
          </div>
        `
        : null}
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
