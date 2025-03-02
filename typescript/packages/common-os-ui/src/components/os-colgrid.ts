import { css, html } from "lit";
import { customElement } from "lit/decorators.ts";
import { base } from "../shared/styles.ts";
import {
  breakpointLg,
  breakpointMd,
  ResponsiveElement,
} from "./responsive-element.ts";

@customElement("os-colgrid")
export class OsColgrid extends ResponsiveElement {
  static override styles = [
    base,
    css`
      :host {
        display: block;
      }

      .colgrid {
        display: grid;
        gap: var(--gap);
        grid-template-columns: 1fr 1fr;
        align-items: center;
        justify-items: center;

        &.colgrid-md {
          grid-template-columns: 1fr 1fr 1fr;
        }

        &.colgrid-lg {
          grid-template-columns: 1fr 1fr 1fr 1fr;
        }
      }
    `,
  ];

  #getSizeClass() {
    const width = this.getObservedWidth();
    if (width >= breakpointLg) {
      return "colgrid-lg";
    } else if (width >= breakpointMd) {
      return "colgrid-md";
    } else {
      return "colgrid-sm";
    }
  }

  override render() {
    return html`
      <div class="colgrid ${this.#getSizeClass()}">
        <slot></slot>
      </div>
    `;
  }
}
