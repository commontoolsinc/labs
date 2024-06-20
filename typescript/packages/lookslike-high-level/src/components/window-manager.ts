import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { view, tags, render } from "@commontools/common-ui";
import { isGem, Gem, ID } from "../recipe.js";
const { binding } = view;
const { include } = tags;

@customElement("common-window-manager")
export class CommonWindowManager extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      overflow-x: auto;
      width: 100%;
    }
    .window {
      flex: 0 0 auto;
      width: 300px;
      margin-right: 10px;
      border: 1px solid #ccc;
    }
  `;

  @property({ type: Array })
  sagas: Gem[] = [];

  private renderedSagas: { [key: string]: HTMLElement } = {};

  override render() {
    return html`
      ${this.sagas.map((saga) => {
        if (!this.renderedSagas[saga[ID]])
          this.renderedSagas[saga[ID]] = render.render(
            include({ content: binding("UI") }),
            {
              UI: saga.UI,
            }
          ) as HTMLElement;

        return html`
          <div class="window" id="${saga[ID]}">
            <common-screen-element>
              ${this.renderedSagas[saga[ID]]}
            </common-screen-element>
          </div>
        `;
      })}
    `;
  }

  openSaga(saga: Gem) {
    this.sagas = [...this.sagas, saga];
    this.updateComplete.then(() => {
      const newWindow = this.renderRoot.querySelector(".window:last-child");
      if (newWindow) {
        newWindow.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "start",
        });
      }
    });
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("open-saga", this.handleAddWindow);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("open-saga", this.handleAddWindow);
  }

  private handleAddWindow(e: Event) {
    const saga = (e as CustomEvent).detail.saga;
    if (isGem(saga)) {
      this.openSaga(saga);
    }
  }
}
