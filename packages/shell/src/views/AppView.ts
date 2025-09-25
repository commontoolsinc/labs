import { css, html } from "lit";
import { property } from "lit/decorators.js";

import { AppState } from "../lib/app/mod.ts";
import { BaseView } from "./BaseView.ts";
import { KeyStore } from "@commontools/identity";
import { RuntimeInternals } from "../lib/runtime.ts";
import { DebuggerController } from "../lib/debugger-controller.ts";
import "./DebuggerView.ts";
import { Task } from "@lit/task";
import { CharmController } from "@commontools/charm/ops";
import { CellEventTarget, CellUpdateEvent } from "../lib/cell-event-target.ts";
import { NAME } from "@commontools/runner";
import { type NameSchema, nameSchema } from "@commontools/charm";
import { navigate, updatePageTitle } from "../lib/navigate.ts";
import { provide } from "@lit/context";
import { KeyboardRouter } from "../lib/keyboard-router.ts";
import { keyboardRouterContext } from "@commontools/ui/v2";

export class XAppView extends BaseView {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
    }

    .shell-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      background-color: white;
      border: var(--border-width, 2px) solid var(--border-color, #000);
    }

    .content-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      background-color: white;
      min-height: 0; /* Important for flex children */
    }
  `;

  @property({ attribute: false })
  app?: AppState;

  @property({ attribute: false })
  rt?: RuntimeInternals;

  @property({ attribute: false })
  keyStore?: KeyStore;

  @property({ attribute: false })
  charmTitle?: string;

  @property({ attribute: false })
  private titleSubscription?: CellEventTarget<string | undefined>;

  private debuggerController = new DebuggerController(this);
  @provide({ context: keyboardRouterContext })
  private keyboard = new KeyboardRouter();

  private _unsubShortcuts: Array<() => void> = [];

  override connectedCallback() {
    super.connectedCallback();
    // Listen for clear telemetry events
    this.addEventListener("clear-telemetry", this.handleClearTelemetry);

    // Register global shortcuts via keyboard router
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const mod = isMac ? { meta: true } : { ctrl: true };
    this._unsubShortcuts.push(
      this.keyboard.register(
        { code: "KeyO", ...mod, preventDefault: true },
        () => {
          this.command({ type: "set-show-quick-jump-view", show: true });
        },
      ),
    );
    this._unsubShortcuts.push(
      this.keyboard.register(
        { code: "KeyW", alt: true, preventDefault: true },
        () => {
          const spaceName = this.app?.spaceName ?? "common-knowledge";
          navigate({ type: "space", spaceName });
        },
      ),
    );
  }

  override disconnectedCallback() {
    this.removeEventListener("clear-telemetry", this.handleClearTelemetry);
    for (const off of this._unsubShortcuts) off();
    this._unsubShortcuts = [];
    this.keyboard.dispose();
    super.disconnectedCallback();
  }

  private handleClearTelemetry = () => {
    this.debuggerController.clearTelemetry();
  };

  // Do not make private, integration tests access this directly.
  _activeCharm = new Task(this, {
    task: async ([app, rt]): Promise<CharmController | undefined> => {
      if (!app || !app.activeCharmId || !rt) {
        this.#setTitleSubscription();
        return;
      }
      const current: CharmController | undefined = this._activeCharm.value;
      if (
        current && current.id === app.activeCharmId
      ) {
        return current;
      }
      const activeCharm = await rt.cc().get(app.activeCharmId, nameSchema);
      this.#setTitleSubscription(activeCharm);

      return activeCharm;
    },
    args: () => [this.app, this.rt],
  });

  #setTitleSubscription(activeCharm?: CharmController<NameSchema>) {
    if (!activeCharm) {
      if (this.titleSubscription) {
        this.titleSubscription.removeEventListener(
          "update",
          this.#onCharmTitleChange,
        );
      }
      this.titleSubscription = undefined;
      this.charmTitle = this.app?.spaceName ?? "Common Tools";
    } else {
      const cell = activeCharm.getCell();
      this.titleSubscription = new CellEventTarget(cell.key(NAME));
      this.charmTitle = cell.key(NAME).get();
    }
  }

  #onCharmTitleChange = (e: Event) => {
    const event = e as CellUpdateEvent<string | undefined>;
    this.charmTitle = event.detail ?? "";
  };

  override updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has("charmTitle")) {
      updatePageTitle(this.charmTitle ?? "");
    }

    if (changedProperties.has("titleSubscription")) {
      const current = this.titleSubscription;
      const prev = changedProperties.get(
        "titleSubscription",
      ) as CellEventTarget<string | undefined> | undefined;
      if (prev) {
        prev.removeEventListener("update", this.#onCharmTitleChange);
      }
      if (current) {
        current.addEventListener("update", this.#onCharmTitleChange);
      }
    }

    // Update debugger controller with runtime
    if (changedProperties.has("rt") && this.rt) {
      this.debuggerController.setRuntime(this.rt);
    }

    // Update debugger visibility from app state
    if (changedProperties.has("app") && this.app) {
      this.debuggerController.setVisibility(
        this.app.showDebuggerView ?? false,
      );
    }
  }

  override render() {
    const app = (this.app ?? {}) as AppState;
    const unauthenticated = html`
      <x-login-view .keyStore="${this.keyStore}"></x-login-view>
    `;
    const authenticated = html`
      <x-body-view
        .rt="${this.rt}"
        .activeCharm="${this._activeCharm.value}"
        .showShellCharmListView="${app.showShellCharmListView ?? false}"
      ></x-body-view>
    `;

    const content = this.app?.identity ? authenticated : unauthenticated;
    return html`
      <div class="shell-container">
        <x-header-view
          .isLoggedIn="${!!app.identity}"
          .spaceName="${app.spaceName}"
          .rt="${this.rt}"
          .keyStore="${this.keyStore}"
          .charmTitle="${this.charmTitle}"
          .charmId="${this._activeCharm.value?.id}"
          .showShellCharmListView="${app.showShellCharmListView ?? false}"
          .showDebuggerView="${app.showDebuggerView ?? false}"
        ></x-header-view>
        <div class="content-area">
          ${content}
        </div>
      </div>
      ${this.app?.identity
        ? html`
          <x-debugger-view
            .visible="${this.debuggerController.isVisible()}"
            .telemetryMarkers="${this.debuggerController.getTelemetryMarkers()}"
          ></x-debugger-view>
          <x-quick-jump-view
            .visible="${this.app?.showQuickJumpView ?? false}"
            .rt="${this.rt}"
          ></x-quick-jump-view>
        `
        : ""}
    `;
  }
}

globalThis.customElements.define("x-app-view", XAppView);
