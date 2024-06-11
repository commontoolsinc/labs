import { LitElement, html, css } from 'lit-element';
import { repeat } from 'lit/directives/repeat.js';
import { customElement, property, state } from 'lit-element/decorators.js';
import { PanelModel } from './navpanel.js';

@customElement('com-navstack')
export class NavStack extends LitElement {
  static override styles = css`
    :host {
      --panel-background: #fff;
      display: block;
      width: 100cqw;
      height: 100cqh;
      container-type: size;
    }

    .container {
      position: relative;
      width: 100cqw;
      height: 100cqh;
    }

    .slot-root::slotted(*) {
      background: var(--panel-background);
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
      bottom: 0;
      z-index: 1;
    }

    .panels > * {
      background: var(--panel-background);
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
      bottom: 0;
      z-index: 2;
      opacity: 0;
      user-events: none;
      transition: opacity 0.3s ease-out;
    }

    .panel-prev {
      opacity: 1;
      user-events: none;
      z-index: 3;
    }

    .panel-curr {
      opacity: 1;
      user-events: all;
      z-index: 4;
    }
  `;

  @property({ type: Object })
  accessor panels = {};

  @state()
  accessor active = '';

  #onBack(event: CustomEvent) {
    event.stopPropagation();
    console.log('Back', event);
  }

  override render() {
    const panels = repeat(
      Object.values(this.panels),
      (panel: PanelModel) => {
        return html`
        <com-navpanel class="${this.active === panel.id ? 'panel-active' : 'panel-inactive'}" content="${panel.content}">
        </com-navpanel>
        `
      }
    )

    return html`
      <div class="container" @com-back="${this.#onBack}">
        <div class="panels">
          ${panels}
        </div>
      </div>
    `;
  }
}