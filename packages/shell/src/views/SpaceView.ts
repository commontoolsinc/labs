import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseView } from "./BaseView.ts";
import { Task } from "@lit/task";
import * as DefaultPattern from "../lib/default-pattern.ts";
import { RuntimeInternals } from "../lib/runtime.ts";
import "../components/OmniLayout.ts";

export class XSpaceView extends BaseView {
  static override styles = css`
    :host {
      display: block;
      height: 100%;
    }
  `;

  @property({ attribute: false })
  rt?: RuntimeInternals;

  @property()
  showShellCharmListView = false;

  @state()
  creatingDefaultPattern = false;

  private _charms = new Task(this, {
    task: async ([rt]) => {
      if (!rt) return undefined;

      // Ensure charms are synced before checking
      const manager = rt.cc().manager();
      await manager.synced();
      return rt.cc().getAllCharms();
    },
    args: () => [this.rt],
  });

  async onRequestDefaultPattern(e: Event) {
    e.preventDefault();
    if (this.creatingDefaultPattern) {
      return;
    }
    if (!this.rt) {
      throw new Error(
        "Cannot create default pattern without a runtime.",
      );
    }
    this.creatingDefaultPattern = true;
    try {
      await DefaultPattern.create(this.rt.cc());
    } catch (e) {
      console.error(`Could not create default pattern: ${e}`);
    } finally {
      this.creatingDefaultPattern = false;
      this._charms.run();
    }
  }

  override render() {
    const spaceName = this.rt
      ? this.rt.cc().manager().getSpaceName()
      : undefined;
    const charms = this._charms.value;
    const defaultPattern = charms
      ? DefaultPattern.getDefaultPattern(charms)
      : undefined;

    const inner = !charms
      ? html`
        <x-spinner></x-spinner>
      `
      : this.showShellCharmListView
      ? html`
        <x-charm-list-view
          .charms="${charms}"
          .spaceName="${spaceName}"
          .rt="${this.rt}"
          @charm-removed="${() => this._charms.run()}"
        ></x-charm-list-view>
      `
      : !defaultPattern
      ? (this.creatingDefaultPattern
        ? html`
          <v-box center="${true}">
            <div>Creating default pattern...</div>
            <x-spinner></x-spinner>
          </v-box>
        `
        : html`
          <v-box center="${true}">
            <div>Create default pattern?</div>
            <x-button variant="primary" @click="${this
              .onRequestDefaultPattern}">Go!</x-button>
          </v-box>
        `)
      // TBD if we want to use x-charm or ct-render directly here
      : html`
          <x-omni-layout>
            <ct-render slot="main" .cell="${defaultPattern.getCell()}"></ct-render>
            <ct-render slot="sidebar" .cell="${defaultPattern.getCell().key('sidebarUI')}"></ct-render>
            <ct-render slot="fab" .cell="${defaultPattern.getCell().key('fabUI')}"></ct-render>
          </x-omni-layout>
      `;

    return html`
      <v-box>
        ${inner}
      </v-box>
    `;
  }
}

globalThis.customElements.define("x-space-view", XSpaceView);
