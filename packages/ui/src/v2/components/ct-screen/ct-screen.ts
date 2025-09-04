import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTScreen - Full height screen layout component with header/main/footer slots
 *
 * @element ct-screen
 *
 * @slot header - Fixed header content at the top
 * @slot main - Main content that expands to fill available space (default slot)
 * @slot footer - Fixed footer content at the bottom
 *
 * @example
 * <ct-screen>
 *   <h1 slot="header">Title</h1>
 *   <div slot="main">Expandable content</div>
 *   <div slot="footer">Footer</div>
 * </ct-screen>
 */
export class CTScreen extends BaseElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      box-sizing: border-box;
    }

    .header {
      flex: none;
    }

    .main {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    .footer {
      flex: none;
    }
  `;

  override render() {
    return html`
      <div class="header" part="header">
        <slot name="header"></slot>
      </div>
      <div class="main" part="main">
        <slot></slot>
      </div>
      <div class="footer" part="footer">
        <slot name="footer"></slot>
      </div>
    `;
  }
}

globalThis.customElements.define("ct-screen", CTScreen);
