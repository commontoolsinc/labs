import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseView } from "../views/BaseView.ts";
import { CharmsController } from "@commontools/charm/ops";
import { Task } from "@lit/task";
import * as DefaultRecipe from "../lib/default-recipe.ts";

type CharmData = {
  name: string;
  id: string;
  href: string;
};

export class XSpaceElement extends BaseView {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background-color: white;
      padding: 1rem;
    }
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
          <div>
            <span>Creating default recipe...</span>
            <x-spinner></x-spinner>
          </div>
        `
        : html`
          <div>
            <span>Create default recipe?</span>
            <button @click="${this.onRequestDefaultRecipe}">Go!</button>
          </div>
        `)
      // TBD if we want to use x-charm or ct-render directly here
      : html`
        <x-charm .charmId="${defaultRecipe.id}" .cc="${this.cc}"></x-charm>
      `;

    return html`
      <div>
        <button @click="${this.onViewToggle}">${this.showCharmList
        ? "show default"
        : "show list"}</button>
        ${inner}
      </div>
    `;
  }
}

globalThis.customElements.define("x-space", XSpaceElement);
