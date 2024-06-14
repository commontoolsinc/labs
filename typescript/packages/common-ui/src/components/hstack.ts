import { LitElement, html, css } from 'lit-element';
import { customElement } from 'lit-element/decorators.js';
import { view } from '../hyperscript/render.js';

export const hstack = view('common-hstack', {});

@customElement('common-hstack')
export class HStackElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
      --gap: 16px;
    }

    .stack {
      display: flex;
      flex-direction: row;
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