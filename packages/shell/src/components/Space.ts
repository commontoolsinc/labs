import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseView } from "../views/BaseView.ts";
import { CharmsController } from "@commontools/charm/ops";
import { Task } from "@lit/task";
import * as DefaultRecipe from "../lib/default-recipe.ts";

export class XSpaceElement extends BaseView {
  static override styles = css`
  `;

  @property({ attribute: false })
  cc?: CharmsController;

  @state()
  showCharmList = false;

  @state()
  creatingDefaultRecipe = false;

  private _charms = new Task(this, {
    task: async ([cc]) => {
      if (!cc) return undefined;

      // Ensure charms are synced before checking
      const manager = cc.manager();
      await manager.synced();
      return await cc.getAllCharms();
    },
    args: () => [this.cc],
  });

  async onRequestDefaultRecipe(e: Event) {
    e.preventDefault();
    if (this.creatingDefaultRecipe) {
      return;
    }
    if (!this.cc) {
      throw new Error(
        "Cannot create default recipe without a charms controller.",
      );
    }
    this.creatingDefaultRecipe = true;
    try {
      await DefaultRecipe.create(this.cc);
    } catch (e) {
      console.error(`Could not create default recipe: ${e}`);
    } finally {
      this.creatingDefaultRecipe = false;
      this._charms.run();
    }
  }

  onViewToggle(e: Event) {
    e.preventDefault();
    this.showCharmList = !this.showCharmList;
  }

  override render() {
    const spaceName = this.cc ? this.cc.manager().getSpaceName() : undefined;
    const charms = this._charms.value;
    const defaultRecipe = charms
      ? DefaultRecipe.getDefaultRecipe(charms)
      : undefined;

    const inner = !charms
      ? html`
        <x-spinner></x-spinner>
      `
      : this.showCharmList
      ? html`
        <x-charm-list .charms="${charms}" .spaceName="${spaceName}"></x-charm-list>
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
        <x-charm .charmId="${defaultRecipe.id}" .cc="${this.cc}"></x-charm>
      `;

    return html`
      <v-box>
        <button @click="${this.onViewToggle}">${this.showCharmList
        ? "show default"
        : "show list"}</button>
        ${inner}
      </v-box>
    `;
  }
}

globalThis.customElements.define("x-space", XSpaceElement);
