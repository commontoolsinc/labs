import { css, html } from "lit";
import { property } from "lit/decorators.js";

import { AppState } from "../lib/app/mod.ts";
import { BaseView } from "./BaseView.ts";
import { KeyStore } from "@commontools/identity";
import { RuntimeInternals } from "../lib/runtime.ts";
import { StorageInspectorController } from "../lib/inspector-controller.ts";
import "./InspectorView.ts";
import { Task } from "@lit/task";
import { CharmController } from "@commontools/charm/ops";
import { CellEventTarget, CellUpdateEvent } from "../lib/cell-event-target.ts";
import { NAME } from "@commontools/runner";
import { updatePageTitle } from "../lib/navigate.ts";

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
      overflow-y: auto;
      background-color: white;
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

  private inspectorController = new StorageInspectorController(this);

  private _activeCharm = new Task(this, {
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
      const activeCharm = await rt.cc().get(app.activeCharmId);
      this.#setTitleSubscription(activeCharm);

      return activeCharm;
    },
    args: () => [this.app, this.rt],
  });

  #setTitleSubscription(activeCharm?: CharmController) {
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
      this.charmTitle = cell.get()[NAME];
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

    // Update inspector controller with runtime
    if (changedProperties.has("rt") && this.rt) {
      this.inspectorController.setRuntime(this.rt);
    }

    // Update inspector visibility from app state
    if (changedProperties.has("app") && this.app) {
      this.inspectorController.setVisibility(
        this.app.showInspectorView ?? false,
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
          .showInspectorView="${app.showInspectorView ?? false}"
        ></x-header-view>
        <div class="content-area">
          ${content}
        </div>
      </div>
      ${this.app?.identity
        ? html`
          <x-inspector-view
            .visible="${this.inspectorController.isVisible()}"
            .inspectorState="${this.inspectorController.getState()}"
            .updateVersion="${this.inspectorController.getUpdateVersion()}"
          ></x-inspector-view>
        `
        : ""}
    `;
  }
}

globalThis.customElements.define("x-app-view", XAppView);
