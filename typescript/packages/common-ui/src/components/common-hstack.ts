import { LitElement, html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { view } from "../hyperscript/render.js";
import { baseStyles } from "./style.js";

export const hstack = view("common-hstack", {});

@customElement("common-hstack")
export class CommonHstackElement extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }

      .hstack {
        display: flex;
        flex-direction: row;
        align-items: center;
      }

      :host([gap="md"]) .hstack {
        gap: var(--gap);
      }

      :host([pad="md"]) .hstack {
        padding: var(--gap);
      }
    `,
  ];

  override render() {
    return html` <div class="hstack">
      <slot></slot>
    </div>`;
  }
}
