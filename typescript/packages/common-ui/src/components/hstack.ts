import { LitElement, html, css } from 'lit-element';
import { customElement } from 'lit-element/decorators.js';
import { view } from '../hyperscript/view.js';

export const hstack = view('co-hstack', {});

@customElement('co-hstack')
export class HStackElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

    .hstack {
      display: flex;
    }
  `;

  override render() {
    return html`
      <div class="hstack">
        <slot></slot>
      </div>
    `;
  }
}