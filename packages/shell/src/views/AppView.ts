import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseView, createDefaultAppState } from "./BaseView.ts";
import { KeyStore } from "@commontools/identity";
import { RuntimeInternals } from "../lib/runtime.ts";
import { DebuggerController } from "../lib/debugger-controller.ts";
import { Task, TaskStatus } from "@lit/task";
import { CellEventTarget, CellUpdateEvent } from "../lib/cell-event-target.ts";
import { type NameSchema, stringSchema } from "@commontools/runner/schemas";
import { updatePageTitle } from "../../shared/mod.ts";
import { KeyboardController } from "../lib/keyboard-router.ts";
import { NAME, PageHandle } from "@commontools/runtime-client";

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
  pieceTitle?: string;

  @property({ attribute: false })
  private titleSubscription?: CellEventTarget<string>;

  @state()
  private _patternError?: Error;

  private debuggerController = new DebuggerController(this);
  private _keyboard = new KeyboardController(this);

  _spaceRootPattern = new Task(this, {
    task: async (
      [rt],
    ): Promise<
      | PageHandle<NameSchema>
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

  _selectedPattern = new Task(this, {
    task: async (
      [app, rt],
      { signal },
    ): Promise<
      | PageHandle<NameSchema>
      | undefined
    > => {
      if (!rt) return;
      this._patternError = undefined;
      if ("pieceId" in app.view && app.view.pieceId) {
        try {
          return await rt.getPattern(app.view.pieceId);
        } catch (e) {
          if (!signal.aborted) {
            this._patternError = e as any;
          }
        }
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
      activePattern: PageHandle<NameSchema> | undefined;
      spaceRootPattern: PageHandle<NameSchema> | undefined;
    } {
      const spaceRootPattern = spaceRootPatternStatus === TaskStatus.COMPLETE
        ? spaceRootPatternValue
        : undefined;
      // The "active" pattern is the main pattern to be rendered.
      // This may be the same as the space root pattern, unless we're
      // in a view that specifies a different pattern to use.
      const useSpaceRootAsActive = !("pieceId" in app.view && app.view.pieceId);
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

  #setTitleSubscription(activePiece?: PageHandle<NameSchema>) {
    if (!activePiece) {
      if (this.titleSubscription) {
        this.titleSubscription.removeEventListener(
          "update",
          this.#onPieceTitleChange,
        );
      }
      this.titleSubscription = undefined;
      this.pieceTitle = "Untitled";
    } else {
      const cell = activePiece.cell().key(NAME).asSchema<string>(stringSchema);
      if (
        this.titleSubscription && cell.equals(this.titleSubscription.cell())
      ) {
        return;
      }
      this.titleSubscription = new CellEventTarget(cell);
      try {
        this.pieceTitle = cell.get();
      } catch {
        // Cell not synced yet
        this.pieceTitle = undefined;
      }
    }
  }

  #onPieceTitleChange = (e: Event) => {
    const event = e as CellUpdateEvent<string | undefined>;
    this.pieceTitle = event.detail ?? "";
  };

  override updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has("pieceTitle")) {
      updatePageTitle(this.pieceTitle ?? "");
    }

    if (changedProperties.has("titleSubscription")) {
      const current = this.titleSubscription;
      const prev = changedProperties.get(
        "titleSubscription",
      ) as CellEventTarget<string | undefined> | undefined;
      if (prev) {
        prev.removeEventListener("update", this.#onPieceTitleChange);
      }
      if (current) {
        current.addEventListener("update", this.#onPieceTitleChange);
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

  #handlePatternRecreated = () => {
    // Re-run the space root pattern task to pick up the newly recreated pattern
    this._spaceRootPattern.run();
  };

  // Always defer to the loaded active pattern for the ID,
  // but until that loads, use an ID in the view if available.
  private getActivePatternId(): string | undefined {
    const activePattern = this._patterns.value?.activePattern;
    if (activePattern) return activePattern.id();
    if ("pieceId" in this.app.view && this.app.view.pieceId) {
      return this.app.view.pieceId;
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
        .patternError="${this._patternError}"
        .showShellPieceListView="${config.showShellPieceListView ?? false}"
        .showSidebar="${config.showSidebar ?? false}"
      ></x-body-view>
    `;
    const unauthenticated = html`
      <x-login-view .keyStore="${this.keyStore}"></x-login-view>
    `;

    const pieceId = this.getActivePatternId();
    const spaceName = this.app && "spaceName" in this.app.view
      ? this.app.view.spaceName
      : undefined;
    // We're viewing the default pattern if there's no pieceId in the current view
    const isViewingDefaultPattern = !("pieceId" in this.app.view &&
      this.app.view.pieceId);
    const content = this.app?.identity ? authenticated : unauthenticated;
    return html`
      <div class="shell-container">
        <x-header-view
          .isLoggedIn="${!!this.app.identity}"
          .spaceName="${spaceName}"
          .rt="${this.rt}"
          .keyStore="${this.keyStore}"
          .pieceTitle="${this.pieceTitle}"
          .pieceId="${pieceId}"
          .isViewingDefaultPattern="${isViewingDefaultPattern}"
          .showShellPieceListView="${config.showShellPieceListView ?? false}"
          .showDebuggerView="${config.showDebuggerView ?? false}"
          .showSidebar="${config.showSidebar ?? false}"
          @pattern-recreated="${this.#handlePatternRecreated}"
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
