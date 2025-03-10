import { css, html, LitElement } from "lit";

export class CommonRecordElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

    .record-key {
      font-weight: bold;
    }

    .record-key::marker {
      font-size: 12px;
    }

    .record-value {
      margin-top: 4px;
    }
  `;

  override render() {
    return html`
      <details class="record" open>
        <summary class="record-key"><slot name="key"></slot></summary>
        <div class="record-value"><slot></slot></div>
      </details>
    `;
  }
}
globalThis.customElements.define("common-record", CommonRecordElement);
