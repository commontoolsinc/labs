import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { base } from "../styles";

const styles = css`
  :host {
    display: block;
  }

  .unibox {
    --min-height: calc(var(--unit) * 15);
    display: grid;
    background-color: var(--color-white);
    border-radius: calc(var(--min-height) / 2);
    grid-template-columns: 1fr min-content;
    grid-template-areas: "main end";
    gap: var(--gap);
    padding: calc(var(--unit) * 2);
    min-height: var(--min-height);
  }

  .unibox-main {
    grid-area: main;
    align-self: center;
    padding-left: calc(var(--unit) * 4);
  }

  .unibox-end {
    grid-area: end;
  }

  .suggestions {
    display: flex;
    /* expand to fill */
    flex-grow: 1;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: var(--gap);
    padding: calc(var(--unit) * 2);

    font-size: 0.8rem;
  }

  .suggestions li {
    cursor: pointer;
    opacity: 0.5;
  }

  .suggestions li:hover {
    text-decoration: underline;
    opacity: 1;
  }
`;

@customElement("com-unibox")
export class ComUnibox extends LitElement {
  static styles = [base, styles];

  @property() suggestions: string[] = [];

  render() {
    const clicked = (suggestion: string) => {
      const ev = new CustomEvent("suggested", {
        detail: { suggestion }
      });
      this.dispatchEvent(ev);
    };

    return html`
      <ul class="suggestions">
        ${this.suggestions.map(
          (suggestion) =>
            html`<li @click=${() => clicked(suggestion)}>${suggestion}</li> `
        )}
      </ul>
      <div class="unibox">
        <div class="unibox-main">
          <slot name="main"></slot>
        </div>
        <div class="unibox-end">
          <slot name="end"></slot>
        </div>
      </div>
    `;
  }
}
