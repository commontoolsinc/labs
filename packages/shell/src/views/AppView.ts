import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseView, createDefaultAppState } from "./BaseView.ts";
import { KeyStore } from "@commontools/identity";
import { RuntimeInternals } from "../lib/runtime.ts";
import { DebuggerController } from "../lib/debugger-controller.ts";
import "./DebuggerView.ts";
import { Task, TaskStatus } from "@lit/task";
import { CharmController } from "@commontools/charm/ops";
import { CellEventTarget, CellUpdateEvent } from "../lib/cell-event-target.ts";
import { NAME } from "@commontools/runner";
import { type NameSchema } from "@commontools/runner/schemas";
import { updatePageTitle } from "../lib/navigate.ts";
import { KeyboardController } from "../lib/keyboard-router.ts";

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

  @state()
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

  // Fetches the space root pattern from the space.
  _spaceRootPattern = new Task(this, {
    task: async (
      [rt],
    ): Promise<
      | CharmController<NameSchema>
      | undefined
    > => {
      if (!rt) return;
      try {
        return await rt.getSpaceRootPattern();
      } catch (err) {
        console.error("[AppView] Failed to load space root pattern:", err);
        throw err;
      }
    },
    args: () => [this.rt],
  });

  // This fetches the selected pattern, the explicitly chosen pattern
  // to render via URL e.g. `/space/someCharmId`.
  _selectedPattern = new Task(this, {
    task: async (
      [app, rt],
    ): Promise<
      | CharmController<NameSchema>
      | undefined
    > => {
      if (!rt) return;
      if ("charmId" in app.view && app.view.charmId) {
        return await rt.getPattern(app.view.charmId);
      }
    },
    args: () => [this.app, this.rt],
  });

  // This derives a space root pattern as well as an "active" (main)
  // pattern for use in child views.
  // This hybrid task intentionally only uses completed/fresh
  // source patterns to avoid unsyncing state.
  _patterns = new Task(this, {
    task: function (
      [
        app,
        spaceRootPatternValue,
        spaceRootPatternStatus,
        selectedPatternValue,
        selectedPatternStatus,
      ],
    ): {
      activePattern: CharmController<NameSchema> | undefined;
      spaceRootPattern: CharmController<NameSchema> | undefined;
    } {
      const spaceRootPattern = spaceRootPatternStatus === TaskStatus.COMPLETE
        ? spaceRootPatternValue
        : undefined;
      // The "active" pattern is the main pattern to be rendered.
      // This may be the same as the space root pattern, unless we're
      // in a view that specifies a different pattern to use.
      const useSpaceRootAsActive = !("charmId" in app.view && app.view.charmId);
      const activePattern = useSpaceRootAsActive
        ? spaceRootPattern
        : selectedPatternStatus === TaskStatus.COMPLETE
        ? selectedPatternValue
        : undefined;
      return {
        activePattern,
        spaceRootPattern,
      };
    },
    args: () => [
      this.app,
      this._spaceRootPattern.value,
      this._spaceRootPattern.status,
      this._selectedPattern.value,
      this._selectedPattern.status,
    ],
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
    if (changedProperties.has("app")) {
      this.debuggerController.setVisibility(
        this.app.config.showDebuggerView ?? false,
      );
    }
  }

  // Always defer to the loaded active pattern for the ID,
  // but until that loads, use an ID in the view if available.
  private getActivePatternId(): string | undefined {
    const activePattern = this._patterns.value?.activePattern;
    if (activePattern?.id) return activePattern.id;
    if ("charmId" in this.app.view && this.app.view.charmId) {
      return this.app.view.charmId;
    }
  }

  override render() {
    const config = this.app.config ?? {};
    const { activePattern, spaceRootPattern } = this._patterns.value ?? {};
    this.#setTitleSubscription(activePattern);

    const authenticated = html`
      <x-body-view
        .rt="${this.rt}"
        .activePattern="${activePattern}"
        .spaceRootPattern="${spaceRootPattern}"
        .showShellCharmListView="${config.showShellCharmListView ?? false}"
        .showSidebar="${config.showSidebar ?? false}"
      ></x-body-view>
    `;
    const unauthenticated = html`
      <x-login-view .keyStore="${this.keyStore}"></x-login-view>
    `;

    const charmId = this.getActivePatternId();
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
          .charmId="${charmId}"
          .showShellCharmListView="${config.showShellCharmListView ?? false}"
          .showDebuggerView="${config.showDebuggerView ?? false}"
          .showSidebar="${config.showSidebar ?? false}"
          .hasSidebarContent="${this.hasSidebarContent}"
        ></x-header-view>
        <div class="content-area">
          ${content}
        </div>
      </div>
      ${this.app.identity
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

globalThis.customElements.define("x-app-view", XAppView);
