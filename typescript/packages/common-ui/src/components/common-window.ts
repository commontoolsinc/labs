import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { baseStyles } from "./style.js";
import { view } from '../hyperscript/render.js';

export const vstack = view('common-window', {});

@customElement("common-window")
export class CommonVstackElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      display: block;
      height: 100%;
    }

    .window {
      background-color: var(--background);
      display: grid;
      grid-template-columns: calc(var(--unit) * 60) 1fr;
      grid-template-areas: "sidebar main";
      overflow: hidden;
      height: 100%;
    }

    .window-sidebar {
      background-color: var(--secondary-background);
      grid-area: sidebar;
      display: flex;
      flex-direction: column;
      gap: var(--gap);
    }

    .window-main {
      background-color: var(--background);
      display: flex;
      flex-direction: column;
      gap: var(--gap);
    }
    `
  ];

  override render() {
    return html`
    <section class="window">
      <div class="window-main">
        <common-scroll>
        <slot></slot>
        </common-scroll>
      </div>
      <aside class="window-sidebar">
        <common-scroll>
          <slot name="sidebar"></slot>
        </common-scroll>
      </aside>
    </section>`;
  }
}