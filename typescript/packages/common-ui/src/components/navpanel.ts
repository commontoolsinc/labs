import { LitElement, html, css } from 'lit-element';
import { customElement, property } from 'lit-element/decorators.js';

export type PanelModel = {
  id: string;
  content: any;
}

@customElement('com-navpanel')
export class PanelElement extends LitElement {
  static override styles = css`
  :host {
    --background: #fff;
    --nav-height: 44px;
    display: block;
    background: var(--background);
    width: 100cqw;
    height: 100cqh;
    container-type: size;
  }

  .panel {
    display: grid;
    grid-template-columns: 1fr;
    grid-template-rows: var(--nav-height) 1fr;
    grid-template-areas:
      "nav"
      "main";
    width: 100cqw;
    height: 100cqh;
  }
  
  .panel-nav {
    grid-area: nav;
    align-content: center;
  }

  .panel-main {
    grid-area: main;
    overflow: auto;
  }
  `;

  @property({ type: String })
  accessor content = '';

  #onClickBackButton(event: MouseEvent) {
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent(
        'com-back',
        {
          bubbles: true,
          composed: true
        }
      )
    );
  }

  override render() {
    return html`
      <section class="panel">
        <header class="panel-nav">
          <a @click="${this.#onClickBackButton}" href="#">Back</a>
        </header>
        <div class="panel-main">
          ${this.content}
        </div>
      </section>
    `;
  }
}