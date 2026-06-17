import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseView, createDefaultAppState } from "./BaseView.ts";
import { type DID, KeyStore } from "@commonfabric/identity";
import { slugIdForSpace, validateSlug } from "@commonfabric/runner/slugs";
import { RuntimeInternals } from "../lib/runtime.ts";
import { DebuggerController } from "../lib/debugger-controller.ts";
import { Task, TaskStatus } from "@lit/task";
import { CellEventTarget, CellUpdateEvent } from "../lib/cell-event-target.ts";
import { type NameSchema, stringSchema } from "@commonfabric/runner/schemas";
import {
  isEmbeddedView,
  isViewingDefaultPatternView,
  replaceNavigation,
  updatePageTitle,
} from "../../shared/mod.ts";
import { KeyboardController } from "../lib/keyboard-router.ts";
import { type Cancel, NAME, PageHandle } from "@commonfabric/runtime-client";

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
      background-color: var(--shell-surface);
    }

    .content-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background-color: var(--shell-surface);
      min-height: 0; /* Important for flex children */
      isolation: isolate; /* Contain pattern z-indexes */
    }
  `;

  @property({ attribute: false })
  accessor app = createDefaultAppState();

  @property({ attribute: false })
  accessor rt: RuntimeInternals | undefined = undefined;

  /** The space the current view addresses — view state from RootView. */
  @property({ attribute: false })
  accessor space: DID | undefined = undefined;

  @property({ attribute: false })
  accessor keyStore: KeyStore | undefined = undefined;

  @state()
  accessor pieceTitle: string | undefined = undefined;

  @property({ attribute: false })
  private accessor titleSubscription: CellEventTarget<string> | undefined =
    undefined;

  @state()
  private accessor _patternError: Error | undefined = undefined;

  @state()
  private accessor _slugRevision = 0;

  private slugCancel: Cancel | undefined = undefined;
  private slugPollInterval: ReturnType<typeof setInterval> | undefined =
    undefined;
  private slugSubscriptionKey: string | undefined = undefined;
  private slugSubscriptionToken = 0;
  private slugTargetKey: string | undefined = undefined;

  private debuggerController = new DebuggerController(this);
  private _keyboard = new KeyboardController(this);

  _spaceRootPattern = new Task(this, {
    task: async (
      [rt, space],
    ): Promise<
      | PageHandle<NameSchema>
      | undefined
    > => {
      if (!rt || !space) return;
      try {
        return await rt.getSpaceRootPattern(space);
      } catch (err) {
        if (!rt.signal.aborted) {
          console.error("[AppView] Failed to load space root pattern:", err);
        }
        throw err;
      }
    },
    args: () => [this.rt, this.space],
  });

  _selectedPattern = new Task(this, {
    task: async (
      [app, rt, space],
      { signal },
    ): Promise<
      | PageHandle<NameSchema>
      | undefined
    > => {
      if (!rt || !space) return;
      this._patternError = undefined;
      if ("pieceSlug" in app.view && app.view.pieceSlug) {
        try {
          const pieceId = slugIdForSpace(space, app.view.pieceSlug);
          const pattern = await rt.getPattern(space, pieceId);
          // Track as recently visited (fire-and-forget) — but not after
          // the view moved on, or the write lands in the wrong space.
          if (!signal.aborted) rt.trackRecentPiece(space, pieceId);
          return pattern;
        } catch (e) {
          if (!signal.aborted) {
            this._patternError = e as any;
          }
        }
      }
      if ("pieceId" in app.view && app.view.pieceId) {
        try {
          const pattern = await rt.getPattern(space, app.view.pieceId);
          const slug = await rt.getSlug(space, app.view.pieceId);
          if (!signal.aborted && slug) {
            this.#replacePieceUrlWithSlug(app.view, slug);
          }
          // Track as recently visited (fire-and-forget)
          if (!signal.aborted) rt.trackRecentPiece(space, app.view.pieceId);
          return pattern;
        } catch (e) {
          if (!signal.aborted) {
            this._patternError = e as any;
          }
        }
      }
    },
    // _slugRevision is a rerun trigger only — keep it after the
    // destructured args.
    args: () => [this.app, this.rt, this.space, this._slugRevision],
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
      const useSpaceRootAsActive =
        !("pieceId" in app.view && app.view.pieceId) &&
        !("pieceSlug" in app.view && app.view.pieceSlug);
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

  #syncSlugSubscription() {
    const rt = this.rt;
    const space = this.space;
    const slug = "pieceSlug" in this.app.view
      ? this.app.view.pieceSlug
      : undefined;
    const key = rt && space && slug ? `${space}:${slug}` : undefined;

    if (key === this.slugSubscriptionKey) return;
    this.#clearSlugSubscription();
    if (!rt || !space || !slug || !key) return;

    this.slugSubscriptionKey = key;
    const token = ++this.slugSubscriptionToken;
    rt.getSlugCell(space, slug).then(async (cell) => {
      if (
        this.slugSubscriptionToken !== token ||
        this.slugSubscriptionKey !== key
      ) {
        return;
      }

      await this.#refreshSlugTarget(rt, space, slug, token, key, false);
      if (
        this.slugSubscriptionToken !== token ||
        this.slugSubscriptionKey !== key
      ) {
        return;
      }

      this.slugPollInterval = globalThis.setInterval(() => {
        void this.#refreshSlugTarget(rt, space, slug, token, key, true);
      }, 1000);

      let sawInitialCallback = false;
      this.slugCancel = cell.subscribe(() => {
        if (!sawInitialCallback) {
          sawInitialCallback = true;
          return;
        }
        void this.#refreshSlugTarget(rt, space, slug, token, key, true);
      });
    }).catch((error) => {
      if (this.slugSubscriptionToken !== token) return;
      if (rt.signal.aborted) {
        // Reset the subscription key so a replacement runtime for the
        // same space/slug re-subscribes instead of matching the stale key.
        this.#clearSlugSubscription();
        return;
      }
      console.error("[AppView] Failed to watch slug cell:", error);
    });
  }

  #clearSlugSubscription() {
    this.slugSubscriptionToken++;
    this.slugCancel?.();
    if (this.slugPollInterval !== undefined) {
      globalThis.clearInterval(this.slugPollInterval);
    }
    this.slugCancel = undefined;
    this.slugPollInterval = undefined;
    this.slugSubscriptionKey = undefined;
    this.slugTargetKey = undefined;
  }

  async #refreshSlugTarget(
    rt: RuntimeInternals,
    space: DID,
    slug: string,
    token: number,
    key: string,
    notify: boolean,
  ) {
    if (
      this.slugSubscriptionToken !== token ||
      this.slugSubscriptionKey !== key
    ) {
      return;
    }

    let targetKey: string;
    try {
      const pattern = await rt.refreshPattern(
        space,
        slugIdForSpace(space, slug),
      );
      targetKey = pattern.id();
    } catch (error) {
      if (rt.signal.aborted) {
        // The runtime this subscription polls was disposed (logout,
        // teardown, worker replacement) — stop polling it; a new runtime
        // re-subscribes via #syncSlugSubscription.
        if (
          this.slugSubscriptionToken === token &&
          this.slugSubscriptionKey === key
        ) {
          this.#clearSlugSubscription();
        }
        return;
      }
      if (notify) {
        console.error("[AppView] Failed to refresh slug target:", error);
      }
      return;
    }
    if (targetKey === this.slugTargetKey) return;
    this.slugTargetKey = targetKey;
    if (notify) {
      this.#handleSlugCellUpdate(rt, space, slug);
    }
  }

  #handleSlugCellUpdate(rt: RuntimeInternals, space: DID, slug: string) {
    if (
      this.rt !== rt ||
      !("pieceSlug" in this.app.view) ||
      this.app.view.pieceSlug !== slug
    ) {
      return;
    }

    rt.invalidatePattern(space, slugIdForSpace(space, slug));
    this._slugRevision++;
  }

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

  #replacePieceUrlWithSlug(view: typeof this.app.view, slug: string) {
    try {
      validateSlug(slug);
    } catch {
      return;
    }
    if ("spaceName" in view) {
      replaceNavigation({ spaceName: view.spaceName, pieceSlug: slug });
    } else if ("spaceDid" in view) {
      replaceNavigation({ spaceDid: view.spaceDid, pieceSlug: slug });
    }
  }

  #isRecreatingSpaceRootPattern = false;

  #handleRecreateSpaceRootPattern = async (e: Event) => {
    const done = (e as CustomEvent).detail?.done as (() => void) | undefined;
    if (!this.rt || !this.space) {
      done?.();
      return;
    }
    if (this.#isRecreatingSpaceRootPattern) return;
    this.#isRecreatingSpaceRootPattern = true;
    try {
      await this.rt.recreateSpaceRootPattern(this.space);
      this._spaceRootPattern.run();
    } catch (err) {
      console.error("[AppView] Failed to recreate pattern:", err);
    } finally {
      this.#isRecreatingSpaceRootPattern = false;
      done?.();
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener(
      "recreate-space-root-pattern",
      this.#handleRecreateSpaceRootPattern,
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener(
      "recreate-space-root-pattern",
      this.#handleRecreateSpaceRootPattern,
    );
    this.#clearSlugSubscription();
  }

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

    if (
      changedProperties.has("app") || changedProperties.has("rt") ||
      changedProperties.has("space")
    ) {
      this.#syncSlugSubscription();
    }
  }

  // Always defer to the loaded active pattern for the ID,
  // but until that loads, use an ID in the view if available.
  private getActivePatternId(): string | undefined {
    const activePattern = this._patterns.value?.activePattern;
    if (activePattern) return activePattern.id();
    if ("pieceId" in this.app.view && this.app.view.pieceId) {
      return this.app.view.pieceId;
    }
    if ("pieceSlug" in this.app.view && this.app.view.pieceSlug) {
      return this.space
        ? slugIdForSpace(this.space, this.app.view.pieceSlug)
        : this.app.view.pieceSlug;
    }
  }

  override render() {
    const config = this.app.config ?? {};
    const { activePattern, spaceRootPattern } = this._patterns.value ?? {};
    const embedded = isEmbeddedView(this.app.view);
    this.#setTitleSubscription(activePattern);

    const authenticated = html`
      <x-body-view
        .rt="${this.rt}"
        .activePattern="${activePattern}"
        .spaceRootPattern="${spaceRootPattern}"
        .patternError="${this._patternError}"
        .showShellPieceListView="${config.showShellPieceListView ?? false}"
        .showSidebar="${config.showSidebar ?? false}"
        .embedded="${embedded}"
      ></x-body-view>
    `;
    const unauthenticated = html`
      <x-login-view .keyStore="${this.keyStore}"></x-login-view>
    `;

    const pieceId = this.getActivePatternId();
    const spaceName = this.app && "spaceName" in this.app.view
      ? this.app.view.spaceName
      : this.app && "builtin" in this.app.view &&
          this.app.view.builtin === "home"
      ? "<home>"
      : undefined;
    const spaceDid = this.app && "spaceDid" in this.app.view
      ? this.app.view.spaceDid
      : undefined;
    const isViewingDefaultPattern = isViewingDefaultPatternView(this.app.view);
    const content = this.app?.identity ? authenticated : unauthenticated;
    return html`
      <div class="shell-container">
        ${embedded ? nothing : html`
          <x-header-view
            .isLoggedIn="${!!this.app.identity}"
            .spaceName="${spaceName}"
            .spaceDid="${spaceDid}"
            .rt="${this.rt}"
            .space="${this.space}"
            .keyStore="${this.keyStore}"
            .pieceTitle="${this.pieceTitle}"
            .pieceId="${pieceId}"
            .isViewingDefaultPattern="${isViewingDefaultPattern}"
            .showDebuggerView="${config.showDebuggerView ?? false}"
          ></x-header-view>
        `}
        <div class="content-area">
          ${content}
        </div>
      </div>
      ${this.app.identity && !embedded
        ? html`
          <x-debugger-view
            .visible="${this.debuggerController.isVisible()}"
            .telemetryMarkers="${this.debuggerController.getTelemetryMarkers()}"
            .debuggerController="${this.debuggerController}"
          ></x-debugger-view>
          <x-quick-jump-view
            .visible="${config.showQuickJumpView ?? false}"
            .rt="${this.rt}"
            .space="${this.space}"
            .spaceName="${spaceName}"
          ></x-quick-jump-view>
        `
        : ""}
    `;
  }
}

globalThis.customElements.define("x-app-view", XAppView);
