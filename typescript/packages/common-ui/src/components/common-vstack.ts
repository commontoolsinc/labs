import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { baseStyles } from "./style.js";
import { view } from '../hyperscript/render.js';
import { eventProps } from "../hyperscript/schema-helpers.js";

export const vstack = view('common-vstack', {
  ...eventProps(),
  gap: { type: 'string' },
  pad: { type: 'string' }
});

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
      gap: var(--pad);

    }

    :host([gap="none"]) .stack {
      gap: 0;
    }

    :host([gap="sm"]) .stack {
      gap: var(--pad-sm);
    }

    :host([pad="md"]) .stack {
      padding: var(--pad);
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