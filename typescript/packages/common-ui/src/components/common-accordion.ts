import { LitElement, html, css, PropertyValues } from "lit";
import { customElement } from "lit/decorators.js";
import { view } from "../hyperscript/render.js";
import { eventProps } from "../hyperscript/schema-helpers.js";

export const accordion = view("common-accordion", {
  ...eventProps(),
});

@customElement("common-accordion")
export class CommonAccordionElement extends LitElement {
  static override styles = [
    css`
      :host {
        display: block;
      }
    `,
  ];

  protected override firstUpdated(_changedProperties: PropertyValues): void {}

  override render() {
    return html`
      <ul uk-accordion>
        <li>
          <a class="uk-accordion-title" href>Hello</a>
          <div class="uk-accordion-content">World</div>
        </li>
        <li>
          <a class="uk-accordion-title" href>Hello 2</a>
          <div class="uk-accordion-content">World 2</div>
        </li>
      </ul>
    `;
  }
}
