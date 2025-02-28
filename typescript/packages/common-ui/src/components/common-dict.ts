import { css, html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

@customElement("common-dict")
export class CommonDictElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
      --gap: 8px;
    }

    .dict {
      display: flex;
      flex-direction: column;
      gap: var(--gap);
    }
  `;

  @property({ type: Object })
  accessor records: Record<string, string> = {};

  override render() {
    const records = repeat(Object.entries(this.records), ([key, value]) => {
      return html`
        <common-record>
          <span slot="key">${key}</span>
          ${value}
        </common-record>
      `;
    });

    return html`<div class="dict">${records}</div>`;
  }
}
