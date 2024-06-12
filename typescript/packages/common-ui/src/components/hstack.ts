import { LitElement, html, css } from 'lit-element';
import { customElement } from 'lit-element/decorators.js';
import { view } from '../hyperscript/view.js';
import { register as registerView } from '../hyperscript/known-tags.js';

export const hstack = view('co-hstack', {});

registerView(hstack);

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