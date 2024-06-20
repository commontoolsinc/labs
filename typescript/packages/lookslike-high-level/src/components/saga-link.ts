import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { render } from "@commontools/common-ui";
import { Gem, ID, NAME } from "../recipe.js";

export const sagaLink = render.view("common-saga-link", {
  saga: { type: "object" },
  name: { tyoe: "string" },
});

@customElement("common-saga-link")
export class CommonSagaLink extends LitElement {
  static override styles = css`
    a {
      color: #3366cc;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  `;

  @property({ type: String })
  saga: Gem | undefined = undefined;

  @property({ type: String })
  name: string | undefined = undefined;

  handleClick(e: Event) {
    e.preventDefault();
    this.dispatchEvent(
      new CustomEvent("open-saga", {
        detail: { saga: this.saga },
        bubbles: true,
        composed: true,
      })
    );
  }

  override render() {
    console.log("rendering saga link", this.saga, this.name);
    if (!this.saga) return html``;
    return html`
      <a href="#${this.saga[ID]}" @click="${this.handleClick}">
        ${this.name ?? this.saga[NAME]}
      </a>
    `;
  }
}
