import { type DID, KeyStore } from "@commonfabric/identity";
import {
  isEmbeddedView,
  isViewingDefaultPatternView,
  replaceNavigation,
  updatePageTitle,
} from "@commonfabric/navigation";
import { type NameSchema, stringSchema } from "@commonfabric/runner/schemas";
import { slugIdForSpace, validateSlug } from "@commonfabric/runner/slugs";
import {
  type Cancel,
  type ErrorNotification,
  NAME,
  PieceHandle,
} from "@commonfabric/runtime-client";
import { Task, TaskStatus } from "@lit/task";
import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";

import { CellEventTarget, CellUpdateEvent } from "../lib/cell-event-target.ts";
import { DebuggerController } from "../lib/debugger-controller.ts";
import { GlobalShortcutsController } from "../lib/global-shortcuts-controller.ts";
import { prepareNamedSpace } from "../lib/named-space.ts";
import { RuntimeInternals } from "../lib/runtime.ts";
import { BaseView, createDefaultAppState } from "./BaseView.ts";
import type { LoadError } from "./BodyView.ts";

/**
 * One live watch on a slug reference: the reference itself, the runtime and
 * space it is read in, and the identity of the subscription it belongs to.
 * `token` and `key` are what a callback arriving after a view change checks
 * itself against.
 */
interface SlugWatch {
  rt: RuntimeInternals;
  space: DID;
  slug: string;
  member: string | undefined;
  token: number;
  key: string;
}

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

  @property({ attribute: false })
  accessor spaceLoadError: LoadError | undefined = undefined;

  @property({ attribute: false })
  accessor runtimeLoadErrors: readonly ErrorNotification[] = [];

  @property({ attribute: false })
  accessor preserveRuntimeErrorsForNextViewChange: (() => void) | undefined =
    undefined;

  @state()
  accessor pieceTitle: string | undefined = undefined;

  @property({ attribute: false })
  private accessor titleSubscription: CellEventTarget<string> | undefined =
    undefined;

  @state()
  private accessor _slugRevision = 0;

  #slugCancel: Cancel | undefined = undefined;
  #slugPollInterval: ReturnType<typeof setInterval> | undefined = undefined;
  #slugSubscriptionKey: string | undefined = undefined;
  #slugSubscriptionToken = 0;
  #slugTargetKey: string | undefined = undefined;

  /**
   * What the last resolution of the slug reference produced: the piece it
   * reached, or the failure it reported. A reference that resolves to nothing
   * is a target state like any other, and comparing against it is what
   * notices a member arriving later.
   */
  #slugResolutionKey: string | undefined = undefined;

  #selectedPatternTargetId: string | undefined = undefined;

  #debuggerController = new DebuggerController(this);
  #keyboard = new GlobalShortcutsController(this);

  _spaceRootPattern = new Task(this, {
    task: async (
      [app, rt, space],
    ): Promise<
      | PieceHandle<NameSchema>
      | undefined
    > => {
      if (!rt || !space) return;
      try {
        await prepareNamedSpace(app, rt, space);
        // The space home renders the root, so there it has to run. A
        // piece-focused view reads NOTHING from it — so it is not fetched
        // at all, and none of what the root's result reaches is demanded.
        // On a space whose root reaches a large piece, that demand is the
        // dominant cost of opening any piece in the space.
        if (!isViewingDefaultPatternView(app.view)) return;
        return await rt.getSpaceRootPattern(space);
      } catch (err) {
        if (!rt.signal.aborted) {
          console.error("[AppView] Failed to load space root pattern:", err);
        }
        throw err;
      }
    },
    args: () => [this.app, this.rt, this.space],
  });

  // One-shot ?path= deep-link delivery (set after the first send so slug
  // re-resolutions and task reruns never re-fire it).
  #openPathDelivered = false;

  /** Deliver a `?path=` deep link into the loaded piece, once.
   *
   * Opt-in by contract: the piece must export an `openPath` stream on its
   * result (e.g. Mobile Loom opens the given cabinet path in its page
   * viewer). Pieces without the stream are untouched — the field simply
   * goes undelivered. Fire-and-forget; a failed send must never affect
   * pattern loading. */
  #maybeDeliverOpenPath(pattern: PieceHandle<NameSchema>): void {
    if (this.#openPathDelivered) return;
    const view = this.app?.view;
    if (!view || !("openPath" in view) || !view.openPath) return;
    const data = pattern.cell().get() as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object" || !("openPath" in data)) return;
    this.#openPathDelivered = true;
    (pattern.cell() as unknown as {
      key(k: string): { send(v: unknown): Promise<void> };
    })
      .key("openPath")
      .send({ path: view.openPath });
  }

  _selectedPattern = new Task(this, {
    task: async (
      [app, rt, space],
      { signal },
    ): Promise<
      | PieceHandle<NameSchema>
      | undefined
    > => {
      if (!rt || !space) return;
      this.#selectedPatternTargetId = undefined;
      try {
        await prepareNamedSpace(app, rt, space);
        if ("pieceSlug" in app.view && app.view.pieceSlug) {
          // The reference is resolved before the piece is asked for, because
          // which piece a slug names is a question about the space and not
          // about the piece: a slug into a collection names the member the
          // path after it selects, and one into a piece at any other depth
          // names the piece that holds it.
          const pieceId = await rt.resolveSlug(
            space,
            app.view.pieceSlug,
            "pieceMember" in app.view ? app.view.pieceMember : undefined,
          );
          if (signal.aborted) return;
          this.#selectedPatternTargetId = pieceId;
          const pattern = await rt.getPattern(space, pieceId);
          if (!signal.aborted) this.#maybeDeliverOpenPath(pattern);
          return pattern;
        }
        if ("pieceId" in app.view && app.view.pieceId) {
          const target = await rt.getPattern(space, app.view.pieceId, {
            start: false,
          });
          if (signal.aborted) return;
          this.#selectedPatternTargetId = target.id();
          const pattern = await rt.getPattern(space, app.view.pieceId);
          const slug = await rt.getSlug(space, app.view.pieceId);
          if (!signal.aborted && slug) {
            this.#replacePieceUrlWithSlug(app.view, slug);
          }
          if (!signal.aborted) this.#maybeDeliverOpenPath(pattern);
          return pattern;
        }
      } catch (error) {
        if (!signal.aborted && !rt.signal.aborted) {
          console.error("[AppView] Failed to load selected piece:", error);
        }
        throw error;
      }
    },
    // _slugRevision is a rerun trigger only — keep it after the
    // destructured args.
    args: () => [this.app, this.rt, this.space, this._slugRevision],
  });

  // Derive the active pattern from completed task values so child views never
  // receive an in-flight or stale selection.
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
      activePattern: PieceHandle<NameSchema> | undefined;
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
      return { activePattern };
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
    const member = "pieceMember" in this.app.view
      ? this.app.view.pieceMember
      : undefined;
    // The member is part of what is watched: two references through the same
    // slug reach different pieces, so one subscription cannot stand for both.
    const key = rt && space && slug
      ? `${space}:${slug}:${member ?? ""}`
      : undefined;

    if (key === this.#slugSubscriptionKey) return;
    this.#clearSlugSubscription();
    if (!rt || !space || !slug || !key) return;

    this.#slugSubscriptionKey = key;
    const watch: SlugWatch = {
      rt,
      space,
      slug,
      member,
      token: ++this.#slugSubscriptionToken,
      key,
    };
    rt.getSlugCell(space, slug).then(async (cell) => {
      if (!this.#isCurrentSlugWatch(watch)) return;

      await this.#refreshSlugTarget(watch, false);
      if (!this.#isCurrentSlugWatch(watch)) return;

      this.#slugPollInterval = globalThis.setInterval(() => {
        void this.#refreshSlugTarget(watch, true);
      }, 1000);

      let sawInitialCallback = false;
      this.#slugCancel = cell.subscribe(() => {
        if (!sawInitialCallback) {
          sawInitialCallback = true;
          return;
        }
        void this.#refreshSlugTarget(watch, true);
      });
    }).catch((error) => {
      if (this.#slugSubscriptionToken !== watch.token) return;
      if (rt.signal.aborted) {
        // Reset the subscription key so a replacement runtime for the
        // same reference re-subscribes instead of matching the stale key.
        this.#clearSlugSubscription();
        return;
      }
      console.error("[AppView] Failed to watch slug cell:", error);
    });
  }

  #clearSlugSubscription() {
    this.#slugSubscriptionToken++;
    this.#slugCancel?.();
    if (this.#slugPollInterval !== undefined) {
      globalThis.clearInterval(this.#slugPollInterval);
    }
    this.#slugCancel = undefined;
    this.#slugPollInterval = undefined;
    this.#slugSubscriptionKey = undefined;
    this.#slugTargetKey = undefined;
    this.#slugResolutionKey = undefined;
  }

  /** Whether `watch` is still the subscription this view is running. */
  #isCurrentSlugWatch(watch: SlugWatch): boolean {
    return this.#slugSubscriptionToken === watch.token &&
      this.#slugSubscriptionKey === watch.key;
  }

  /**
   * Re-resolve the reference `watch` follows, and reload the view when it
   * reaches somewhere else than it did. `notify` is false for the first
   * resolution, which records where the reference points without reloading a
   * view already loading it.
   */
  async #refreshSlugTarget(watch: SlugWatch, notify: boolean) {
    if (!this.#isCurrentSlugWatch(watch)) return;

    let target: string | undefined;
    let resolution: string;
    try {
      target = await watch.rt.resolveSlug(
        watch.space,
        watch.slug,
        watch.member,
      );
      resolution = target;
    } catch (error) {
      if (watch.rt.signal.aborted) {
        // The runtime this subscription polls was disposed (logout,
        // teardown, worker replacement) — stop polling it; a new runtime
        // re-subscribes via #syncSlugSubscription.
        if (this.#isCurrentSlugWatch(watch)) this.#clearSlugSubscription();
        return;
      }
      resolution = `unresolved: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    if (!this.#isCurrentSlugWatch(watch)) return;
    if (resolution === this.#slugResolutionKey) return;
    this.#slugResolutionKey = resolution;
    this.#slugTargetKey = target;
    if (notify) {
      this.#handleSlugCellUpdate(watch);
    }
  }

  #handleSlugCellUpdate(watch: SlugWatch) {
    const member = "pieceMember" in this.app.view
      ? this.app.view.pieceMember
      : undefined;
    if (
      this.rt !== watch.rt ||
      !("pieceSlug" in this.app.view) ||
      this.app.view.pieceSlug !== watch.slug ||
      member !== watch.member
    ) {
      return;
    }

    this._slugRevision++;
  }

  #setTitleSubscription(activePiece?: PieceHandle<NameSchema>) {
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
    this.preserveRuntimeErrorsForNextViewChange?.();
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
      this.#debuggerController.setRuntime(this.rt);
    }

    // Update debugger visibility from app state
    if (changedProperties.has("app")) {
      this.#debuggerController.setVisibility(
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
  #getActivePatternId(): string | undefined {
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

  /**
   * How the piece this view addresses is cited from anywhere:
   * `/@<space>/<collection>/<member>`, the spelling every reader of a
   * reference resolves. Only a member of a named collection has one — a piece
   * reached by identity carries its own, and a collection's name with no
   * member after it names no piece at all.
   *
   * The space is taken from the view rather than from the resolved DID: a
   * space name derives that DID for everyone, so a name travels as far as the
   * DID does and reads better where it lands.
   */
  #getPieceReference(): string | undefined {
    const view = this.app.view;
    if (!("pieceSlug" in view) || !view.pieceSlug) return;
    const member = "pieceMember" in view ? view.pieceMember : undefined;
    if (!member) return;
    const space = "spaceName" in view
      ? view.spaceName
      : "spaceDid" in view
      ? view.spaceDid
      : undefined;
    if (!space) return;
    return `/@${space}/${view.pieceSlug}/${member}`;
  }

  #getRuntimeLoadError(): LoadError | undefined {
    const event = this.runtimeLoadErrors.findLast((candidate) =>
      this.#runtimeErrorMatchesView(candidate)
    );
    if (!event) return;

    return {
      kind: event.pieceId && !isViewingDefaultPatternView(this.app.view)
        ? "piece"
        : "space",
      error: event,
    };
  }

  #runtimeErrorMatchesView(event: ErrorNotification): boolean {
    if (!event.space || event.space !== this.space) return false;

    const isDefaultView = isViewingDefaultPatternView(this.app.view);
    const reportedPieceId = event.pieceId?.replace(/^of:/, "");
    if (reportedPieceId) {
      const addressedPieceIds = isDefaultView
        ? [this._spaceRootPattern.value?.id()]
        : "pieceSlug" in this.app.view
        ? [
          this.#slugTargetKey ?? this.#selectedPatternTargetId ??
            (this._selectedPattern.status === TaskStatus.COMPLETE
              ? this._selectedPattern.value?.id()
              : undefined),
        ]
        : [
          this._selectedPattern.status === TaskStatus.COMPLETE
            ? this._selectedPattern.value?.id()
            : undefined,
          this.#selectedPatternTargetId,
          "pieceId" in this.app.view ? this.app.view.pieceId : undefined,
        ];
      const knownPieceIds = addressedPieceIds.filter((id) => id !== undefined);
      if (
        knownPieceIds.length > 0 &&
        !knownPieceIds.some((id) => id?.replace(/^of:/, "") === reportedPieceId)
      ) {
        return false;
      }
      if (
        knownPieceIds.length === 0
      ) {
        return false;
      }
    }

    return true;
  }

  override render() {
    const config = this.app.config ?? {};
    const { activePattern } = this._patterns.value ?? {};
    const embedded = isEmbeddedView(this.app.view);
    const isViewingDefaultPattern = isViewingDefaultPatternView(this.app.view);
    const patternLoadError: LoadError | undefined = isViewingDefaultPattern
      ? this._spaceRootPattern.status === TaskStatus.ERROR
        ? { kind: "space", error: this._spaceRootPattern.error }
        : undefined
      : this._selectedPattern.status === TaskStatus.ERROR
      ? { kind: "piece", error: this._selectedPattern.error }
      : undefined;
    const loadError = this.spaceLoadError ?? patternLoadError;
    const runtimeLoadError = loadError
      ? undefined
      : this.#getRuntimeLoadError();
    this.#setTitleSubscription(activePattern);

    const authenticated = html`
      <x-body-view
        .rt="${this.rt}"
        .space="${this.space}"
        .activePattern="${activePattern}"
        .loadError="${loadError}"
        .runtimeError="${runtimeLoadError}"
        .showShellPieceListView="${config.showShellPieceListView ?? false}"
        .showSidebar="${config.showSidebar ?? false}"
        .embedded="${embedded}"
      ></x-body-view>
    `;
    const unauthenticated = html`
      <x-login-view .keyStore="${this.keyStore}"></x-login-view>
    `;

    const pieceId = this.#getActivePatternId();
    const spaceName = this.app && "spaceName" in this.app.view
      ? this.app.view.spaceName
      : this.app && "builtin" in this.app.view &&
          this.app.view.builtin === "home"
      ? "<home>"
      : undefined;
    const spaceDid = this.app && "spaceDid" in this.app.view
      ? this.app.view.spaceDid
      : undefined;
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
            .pieceReference="${this.#getPieceReference()}"
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
            .visible="${this.#debuggerController.isVisible()}"
            .telemetryMarkers="${this.#debuggerController
              .getTelemetryMarkers()}"
            .debuggerController="${this.#debuggerController}"
          ></x-debugger-view>
        `
        : ""}
    `;
  }
}

globalThis.customElements.define("x-app-view", XAppView);
