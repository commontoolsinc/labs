import { LitElement, html, css } from 'lit-element';
import { customElement, property } from 'lit-element/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { view } from '../hyperscript/render.js';

export const dict = view('common-dict', {
  type: 'object',
  properties: {
    records: { type: 'object' },
  }
});

@customElement('common-dict')
export class DictElement extends LitElement {
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
  records: Record<string, string>;

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