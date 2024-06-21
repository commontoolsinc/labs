import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { baseStyles } from "./style.js";
import { view } from '../hyperscript/render.js';
import { eventProps } from "../hyperscript/schema-helpers.js";

export const hscroll = view('common-hscroll', {
  ...eventProps()
});

@customElement("common-hscroll")
export class CommonHscrollElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      display: block;
      width: 100%;
    }

    .scroll {
      overflow-x: auto;
      overflow-y: hidden;
      width: 100%;
    }

    .scroll {
      scrollbar-width: none;  /* Firefox */
      -ms-overflow-style: none;  /* Internet Explorer 10+ */
    }

    .scroll::-webkit-scrollbar {
      width: 0;
      height: 0;
    }

    .scroll-body {
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      gap: var(--gap)
    }

    :host([gap="none"]) .scroll-body {
      gap: 0;
    }

    :host([gap="md"]) .scroll-body {
      gap: var(--gap);
    }

    :host([pad="md"]) .scroll-body {
      padding: var(--gap);
    }
    `
  ];

  override render() {
    return html`
    <div class="scroll">
      <div class="scroll-body">
        <slot></slot>
      </div>
    </div>
    `;
  }
}