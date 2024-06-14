import { LitElement, html, css } from 'lit-element';
import { customElement } from 'lit-element/decorators.js';
import { view } from '../hyperscript/render.js';

export const record = view('common-record', {});

@customElement('common-record')
export class RecordElement extends LitElement {
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