import { css, html } from "lit";
import { property, state } from "lit/decorators.js";

import { AppView } from "../lib/app/mod.ts";
import { BaseView, createDefaultAppState } from "./BaseView.ts";
import { KeyStore } from "@commontools/identity";
import { RuntimeInternals } from "../lib/runtime.ts";
import { DebuggerController } from "../lib/debugger-controller.ts";
import "./DebuggerView.ts";
import { Task } from "@lit/task";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { CellEventTarget, CellUpdateEvent } from "../lib/cell-event-target.ts";
import { NAME } from "@commontools/runner";
import { type NameSchema, nameSchema } from "@commontools/charm";
import { updatePageTitle } from "../lib/navigate.ts";
import { KeyboardController } from "../lib/keyboard-router.ts";
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
  app = createDefaultAppState();

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
  private _keyboard = new KeyboardController(this);

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener(
      "sidebar-content-change",
      this.handleSidebarContentChange,
    );
  }

  override disconnectedCallback() {
    this.removeEventListener(
      "sidebar-content-change",
      this.handleSidebarContentChange,
    );
    super.disconnectedCallback();
  }

  private handleSidebarContentChange = (e: Event) => {
    const event = e as CustomEvent<{ hasSidebarContent: boolean }>;
    this.hasSidebarContent = event.detail.hasSidebarContent;
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
      if (!rt) {
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
        this.app.config.showDebuggerView ?? false,
      );
    }
  }

  override render() {
    const config = this.app.config ?? {};
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
        .showShellCharmListView="${config.showShellCharmListView ?? false}"
        .showSidebar="${config.showSidebar ?? false}"
      ></x-body-view>
    `;

    const spaceName = this.app && "spaceName" in this.app.view
      ? this.app.view.spaceName
      : undefined;
    const content = this.app?.identity ? authenticated : unauthenticated;
    return html`
      <div class="shell-container">
        <x-header-view
          .isLoggedIn="${!!this.app.identity}"
          .spaceName="${spaceName}"
          .rt="${this.rt}"
          .keyStore="${this.keyStore}"
          .charmTitle="${this.charmTitle}"
          .charmId="${activePattern?.id}"
          .showShellCharmListView="${config.showShellCharmListView ?? false}"
          .showDebuggerView="${config.showDebuggerView ?? false}"
          .showSidebar="${config.showSidebar ?? false}"
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
            .visible="${config.showQuickJumpView ?? false}"
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
