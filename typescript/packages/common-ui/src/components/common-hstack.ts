import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { view } from '../hyperscript/render.js';
import { baseStyles } from "./style.js";

export const hstack = view('common-hstack', {});

@customElement("common-hstack")
export class CommonHstackElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      display: block;
    }

    .stack {
      display: flex;
      flex-direction: row;
    }

    :host-context([gap="md"]) .stack {
      gap: var(--gap);
    }

    :host-context([pad="md"]) .stack {
      padding: var(--gap);
    }
    `
  ];

  override render() {
    return html`
    <div class="stack">
      <slot></slot>
    </div>`;
  }
}