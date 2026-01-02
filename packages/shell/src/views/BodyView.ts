import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { Task } from "@lit/task";
import { BaseView } from "./BaseView.ts";
import { RuntimeInternals } from "../lib/runtime.ts";
import { CharmController } from "@commontools/charm/ops";
import "../components/OmniLayout.ts";

export class XBodyView extends BaseView {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }

    .content {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      padding: 1rem;
      box-sizing: border-box;
    }

    x-omni-layout {
      flex: 1;
    }

    ct-charm,
    ct-render[slot="main"] {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }

    .pattern-error {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
      color: #c00;
      text-align: center;
    }

    .pattern-error h2 {
      margin: 0 0 1rem;
    }

    .pattern-error p {
      margin: 0;
      font-family: monospace;
    }

    v-box {
      flex: 1;
    }
  `;

  @property({ attribute: false })
  rt?: RuntimeInternals;

  @property({ attribute: false })
  activePattern?: CharmController;

  @property({ attribute: false })
  spaceRootPattern?: CharmController;

  @property()
  showShellCharmListView = false;

  @property({ type: Boolean })
  showSidebar = false;

  @property({ attribute: false })
  patternError?: Error;

  @state()
  private hasSidebarContent = false;

  private _charms = new Task(this, {
    task: async ([rt, _spaceRootPattern]) => {
      if (!rt) return undefined;
      // Include spaceRootPattern in args so we re-fetch when it changes.
      // This ensures newly created default patterns appear in the list.

      const manager = rt.cc().manager();
      await manager.synced();
      return rt.cc().getAllCharms();
    },
    args: () => [this.rt, this.spaceRootPattern],
  });

  override render() {
    const charms = this._charms.value;
    if (!charms) {
      return html`
        <div class="content">
          <x-spinner></x-spinner>
        </div>
      `;
    }

    if (this.showShellCharmListView) {
      const spaceName = this.rt?.cc().manager().getSpaceName();
      const spaceDid = this.rt?.cc().manager().getSpace();
      return html`
        <div class="content">
          <x-charm-list-view
            .charms="${charms}"
            .spaceName="${spaceName}"
            .spaceDid="${spaceDid}"
            .rt="${this.rt}"
            @charm-removed="${() => this._charms.run()}"
          ></x-charm-list-view>
        </div>
      `;
    }

    // Show error if pattern failed to start
    const mainContent = this.patternError
      ? html`
        <div slot="main" class="pattern-error">
          <h2>Failed to load charm</h2>
          <p>${this.patternError.message}</p>
        </div>
      `
      : this.activePattern
      ? html`
        <ct-charm slot="main" .charmId="${this.activePattern.id}">
          <ct-render .cell="${this.activePattern.getCell()}"></ct-render>
        </ct-charm>
      `
      : null;

    const sidebarCell = this.activePattern?.getCell().key("sidebarUI");
    const fabCell = this.spaceRootPattern?.getCell().key("fabUI");

    // Update sidebar content detection
    // TODO(seefeld): Fix possible race here where charm is already set, but
    // sidebar isn't loaded yet, which will now eventually render the sidebar,
    // but not the button to hide it.
    const hasSidebarContent = !!sidebarCell?.get();
    if (this.hasSidebarContent !== hasSidebarContent) {
      this.hasSidebarContent = hasSidebarContent;
      // Notify parent of sidebar content changes
      this.dispatchEvent(
        new CustomEvent("sidebar-content-change", {
          detail: { hasSidebarContent },
          bubbles: true,
          composed: true,
        }),
      );
    }

    return html`
      <div class="content">
        <x-omni-layout .sidebarOpen="${this.showSidebar}">
          ${mainContent} ${sidebarCell
            ? html`
              <ct-render slot="sidebar" .cell="${sidebarCell}"></ct-render>
            `
            : null} ${fabCell
            ? html`
              <ct-render slot="fab" .cell="${fabCell}"></ct-render>
            `
            : null}
        </x-omni-layout>
      </div>
    `;
  }
}

globalThis.customElements.define("x-body-view", XBodyView);
