import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { baseStyles } from "./style.js";

@customElement("common-app")
export class AppElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      display: block;
    }

    .app {
      height: 100cqh;
      display: grid;
      grid-template-columns: 1fr;
      grid-template-rows: 1fr 300px min-content;
      grid-template-areas:
        "primary"
        "secondary"
        "search"
      ;
    }

    .app-primary {
      grid-area: primary;
      overflow: auto;
      container-type: size;
      container-name: app-primary;
    }
    
    .app-secondary {
      grid-area: secondary;  
    }
    
    .app-search {
      grid-area: search;
      background-color: var(--secondary-background);
      display: block;
      padding: var(--gap);
    }
    `
  ];

  override render() {
    return html`
    <div class="app">
      <main class="app-primary">
        <common-scroll>
          <slot></slot>
        </common-scroll>
      </main>
      <nav class="app-secondary">
        <slot name="secondary"></slot>
      </nav>
      <nav class="app-search">
        <slot name="search"></slot>
      </nav>
    </div>
    `;
  }
}