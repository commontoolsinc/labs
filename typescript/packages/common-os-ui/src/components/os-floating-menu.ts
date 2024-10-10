import { LitElement, html, css, PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { base } from "../shared/styles.js";
import { createRect, Rect, positionMenu } from "../shared/position.js";
import { toggleInvisible } from "../shared/dom.js";

@customElement("os-floating-menu")
export class OsFloatingMenu extends LitElement {
  static override styles = [
    base,
    css`
      :host {
        --suggestions-width: calc(var(--u) * 80);
        display: block;
        left: 0;
        top: 0;
        position: absolute;
        width: var(--suggestions-width);
        transition: opacity var(--dur-md) var(--ease-out-expo);
      }

      .menu {
        background-color: var(--bg);
        padding: var(--pad-sm);
        border-radius: var(--radius);
        box-shadow: var(--shadow-menu);
      }
    `,
  ];

  @property({ attribute: false })
  anchor: Rect = createRect(0, 0, 0, 0);

  @property({ attribute: false })
  open: boolean = false;

  override render() {
    return html` <div class="menu"><slot></slot></div> `;
  }

  protected override updated(changedProperties: PropertyValues): void {
    if (changedProperties.has("anchor")) {
      positionMenu(this, this.anchor);
    }
    if (changedProperties.has("open")) {
      toggleInvisible(this, !this.open);
    }
  }
}
