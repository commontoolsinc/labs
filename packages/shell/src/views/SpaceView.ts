import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseView } from "./BaseView.ts";
import { Task } from "@lit/task";
import * as DefaultRecipe from "../lib/default-recipe.ts";
import { RuntimeInternals } from "../lib/runtime.ts";

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
  creatingDefaultRecipe = false;

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

  async onRequestDefaultRecipe(e: Event) {
    e.preventDefault();
    if (this.creatingDefaultRecipe) {
      return;
    }
    if (!this.rt) {
      throw new Error(
        "Cannot create default recipe without a runtime.",
      );
    }
    this.creatingDefaultRecipe = true;
    try {
      await DefaultRecipe.create(this.rt.cc());
    } catch (e) {
      console.error(`Could not create default recipe: ${e}`);
    } finally {
      this.creatingDefaultRecipe = false;
      this._charms.run();
    }
  }

  override render() {
    const spaceName = this.rt
      ? this.rt.cc().manager().getSpaceName()
      : undefined;
    const charms = this._charms.value;
    const defaultRecipe = charms
      ? DefaultRecipe.getDefaultRecipe(charms)
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
      : !defaultRecipe
      ? (this.creatingDefaultRecipe
        ? html`
          <v-box center="${true}">
            <div>Creating default recipe...</div>
            <x-spinner></x-spinner>
          </v-box>
        `
        : html`
          <v-box center="${true}">
            <div>Create default recipe?</div>
            <x-button variant="primary" @click="${this
            .onRequestDefaultRecipe}">Go!</x-button>
          </v-box>
        `)
      // TBD if we want to use x-charm or ct-render directly here
      : html`
        <x-charm-view .charm="${defaultRecipe}"></x-charm-view>
      `;

    return html`
      <v-box>
        ${inner}
      </v-box>
    `;
  }
}

globalThis.customElements.define("x-space-view", XSpaceView);
