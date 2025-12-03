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

    v-box {
      flex: 1;
    }
  `;

  @property({ attribute: false })
  rt?: RuntimeInternals;

  @property({ attribute: false })
  activeCharm?: CharmController;

  @property({ attribute: false })
  defaultCharm?: CharmController;

  @property()
  showShellCharmListView = false;

  @property({ type: Boolean })
  showSidebar = false;

  @state()
  private hasSidebarContent = false;

  private _charms = new Task(this, {
    task: async ([rt]) => {
      if (!rt) return undefined;

      const manager = rt.cc().manager();
      await manager.synced();
      return rt.cc().getAllCharms();
    },
    args: () => [this.rt],
  });

  override render() {
    const charms = this._charms.value;
    const spaceName = this.rt
      ? this.rt.cc().manager().getSpaceName()
      : undefined;
    if (!charms) {
      return html`
        <div class="content">
          <x-spinner></x-spinner>
        </div>
      `;
    }

    if (this.showShellCharmListView) {
      return html`
        <div class="content">
          <x-charm-list-view
            .charms="${charms}"
            .spaceName="${spaceName}"
            .rt="${this.rt}"
            @charm-removed="${() => this._charms.run()}"
          ></x-charm-list-view>
        </div>
      `;
    }

    const mainContent = this.activeCharm
      ? html`
        <ct-charm slot="main" .charmId="${this.activeCharm.id}">
          <ct-render .cell="${this.activeCharm.getCell()}"></ct-render>
        </ct-charm>
      `
      : null;

    const sidebarCell = this.activeCharm?.getCell().key("sidebarUI");
    const fabCell = this.defaultCharm?.getCell().key("fabUI");

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
