import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { baseStyles } from "./style.js";
import { view } from '../hyperscript/render.js';

export const vstack = view('common-vstack', {});

@customElement("common-vstack")
export class CommonVstackElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
    :host {
      display: block;
    }

    .stack {
      display: flex;
      flex-direction: column;
    }

    :host([gap="md"]) .stack {
      gap: var(--gap);
    }

    :host([gap="sm"]) .stack {
      gap: var(--gap-sm);
    }

    :host([pad="md"]) .stack {
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