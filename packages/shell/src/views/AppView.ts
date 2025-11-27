import { css, html } from "lit";
import { property, state } from "lit/decorators.js";

import { AppState, AppView } from "../lib/app/mod.ts";
import { BaseView } from "./BaseView.ts";
import { KeyStore } from "@commontools/identity";
import { RuntimeInternals } from "../lib/runtime.ts";
import { DebuggerController } from "../lib/debugger-controller.ts";
import "./DebuggerView.ts";
import { Task } from "@lit/task";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { CellEventTarget, CellUpdateEvent } from "../lib/cell-event-target.ts";
import { NAME } from "@commontools/runner";
import { type NameSchema, nameSchema } from "@commontools/charm";
import { navigate, updatePageTitle } from "../lib/navigate.ts";
import { provide } from "@lit/context";
import { KeyboardRouter } from "../lib/keyboard-router.ts";
import { keyboardRouterContext } from "@commontools/ui";
import * as PatternFactory from "../lib/pattern-factory.ts";

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

  @state()
  private hasSidebarContent = false;

  private debuggerController = new DebuggerController(this);
  @provide({ context: keyboardRouterContext })
  private keyboard = new KeyboardRouter();

  private _unsubShortcuts: Array<() => void> = [];

  override connectedCallback() {
    super.connectedCallback();
    // Listen for clear telemetry events
    this.addEventListener("clear-telemetry", this.handleClearTelemetry);
    // Listen for sidebar content changes
    this.addEventListener(
      "sidebar-content-change",
      this.handleSidebarContentChange,
    );
    // Listen for cell watch/unwatch events from ct-cell-context
    this.addEventListener("ct-cell-watch", this.handleCellWatch);
    this.addEventListener("ct-cell-unwatch", this.handleCellUnwatch);

    // Register global shortcuts via keyboard router
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const mod = isMac ? { meta: true } : { ctrl: true };
    this._unsubShortcuts.push(
      this.keyboard.register(
        { code: "KeyO", ...mod, shift: true, preventDefault: true },
        () => {
          this.command({ type: "set-show-quick-jump-view", show: true });
        },
      ),
    );
    this._unsubShortcuts.push(
      this.keyboard.register(
        { code: "KeyW", alt: true, preventDefault: true },
        () => {
          const spaceName = this.app && "spaceName" in this.app.view
            ? this.app.view.spaceName
            : "common-knowledge";
          navigate({ spaceName });
        },
      ),
    );
  }

  override disconnectedCallback() {
    this.removeEventListener("clear-telemetry", this.handleClearTelemetry);
    this.removeEventListener(
      "sidebar-content-change",
      this.handleSidebarContentChange,
    );
    this.removeEventListener("ct-cell-watch", this.handleCellWatch);
    this.removeEventListener("ct-cell-unwatch", this.handleCellUnwatch);
    for (const off of this._unsubShortcuts) off();
    this._unsubShortcuts = [];
    this.keyboard.dispose();
    super.disconnectedCallback();
  }

  private handleClearTelemetry = () => {
    this.debuggerController.clearTelemetry();
  };

  private handleSidebarContentChange = (e: Event) => {
    const event = e as CustomEvent<{ hasSidebarContent: boolean }>;
    this.hasSidebarContent = event.detail.hasSidebarContent;
  };

  private handleCellWatch = (e: Event) => {
    const event = e as CustomEvent<{ cell: unknown; label?: string }>;
    const { cell, label } = event.detail;
    // Cell type from @commontools/runner
    if (cell && typeof (cell as any).sink === "function") {
      this.debuggerController.watchCell(cell as any, label);
    }
  };

  private handleCellUnwatch = (e: Event) => {
    const event = e as CustomEvent<{ cell: unknown; label?: string }>;
    const { cell } = event.detail;
    // Find and remove the watch by matching the cell
    if (cell && typeof (cell as any).getAsNormalizedFullLink === "function") {
      const link = (cell as any).getAsNormalizedFullLink();
      const watches = this.debuggerController.getWatchedCells();
      const watch = watches.find((w) => w.cellLink.id === link.id);
      if (watch) {
        this.debuggerController.unwatchCell(watch.id);
      }
    }
  };

  // Do not make private, integration tests access this directly.
  //
  // This fetches the active pattern and space default pattern derived
  // from the current view.
  _activePatterns = new Task(this, {
    task: async (
      [app, rt],
    ): Promise<
      | { activePattern: CharmController; defaultPattern: CharmController }
      | undefined
    > => {
      if (!app || !rt) {
        this.#setTitleSubscription();
        return;
      }

      const patterns = await viewToPatterns(
        rt.cc(),
        app.view,
        this._activePatterns.value?.activePattern,
      );
      if (!patterns) {
        this.#setTitleSubscription();
        return;
      }

      // Record the charm as recently accessed so recents stay fresh.
      await rt.cc().manager().trackRecentCharm(
        patterns.activePattern.getCell(),
      );
      this.#setTitleSubscription(
        patterns.activePattern as CharmController<NameSchema>,
      );

      return patterns;
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
      this.charmTitle = this.app && "spaceName" in this.app.view
        ? this.app.view.spaceName
        : "Common Tools";
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
    const patterns = this._activePatterns.value;
    const activePattern = patterns?.activePattern;
    const defaultPattern = patterns?.defaultPattern;
    const authenticated = html`
      <x-body-view
        .rt="${this.rt}"
        .activeCharm="${activePattern}"
        .defaultCharm="${defaultPattern}"
        .showShellCharmListView="${app.showShellCharmListView ?? false}"
        .showSidebar="${app.showSidebar ?? false}"
      ></x-body-view>
    `;

    const spaceName = this.app && "spaceName" in this.app.view
      ? this.app.view.spaceName
      : undefined;
    const content = this.app?.identity ? authenticated : unauthenticated;
    return html`
      <div class="shell-container">
        <x-header-view
          .isLoggedIn="${!!app.identity}"
          .spaceName="${spaceName}"
          .rt="${this.rt}"
          .keyStore="${this.keyStore}"
          .charmTitle="${this.charmTitle}"
          .charmId="${activePattern?.id}"
          .showShellCharmListView="${app.showShellCharmListView ?? false}"
          .showDebuggerView="${app.showDebuggerView ?? false}"
          .showSidebar="${app.showSidebar ?? false}"
          .hasSidebarContent="${this.hasSidebarContent}"
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
            .debuggerController="${this.debuggerController}"
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

async function viewToPatterns(
  cc: CharmsController,
  view: AppView,
  currentActive?: CharmController<unknown>,
): Promise<
  {
    activePattern: CharmController<unknown>;
    defaultPattern: CharmController<unknown>;
  } | undefined
> {
  if ("builtin" in view) {
    if (view.builtin !== "home") {
      console.warn("Unsupported view type");
      return;
    }
    const pattern = await PatternFactory.getOrCreate(cc, "home");
    return { activePattern: pattern, defaultPattern: pattern };
  } else if ("spaceDid" in view) {
    console.warn("Unsupported view type");
    return;
  } else if ("spaceName" in view) {
    const defaultPattern = await PatternFactory.getOrCreate(
      cc,
      "space-default",
    );

    let activePattern: CharmController<unknown> | undefined;
    // If viewing a specific charm, use it as active; otherwise use default
    if (view.charmId) {
      if (currentActive && currentActive.id === view.charmId) {
        activePattern = currentActive;
      } else {
        activePattern = await cc.get(
          view.charmId,
          true,
          nameSchema,
        );
      }
    } else {
      activePattern = defaultPattern;
    }
    return { activePattern, defaultPattern };
  }
}

globalThis.customElements.define("x-app-view", XAppView);
