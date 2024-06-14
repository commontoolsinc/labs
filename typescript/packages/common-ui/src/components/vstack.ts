import { LitElement, html, css } from 'lit-element';
import { customElement } from 'lit-element/decorators.js';
import { view } from '../hyperscript/render.js';

export const vstack = view('common-vstack', {});

@customElement('common-vstack')
export class VStackElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
      --gap: 16px;
    }

    .stack {
      display: flex;
      flex-direction: column;
      gap: var(--gap);
    }
  `;

  override render() {
    return html`
      <div class="stack">
        <slot></slot>
      </div>
    `;
  }
}