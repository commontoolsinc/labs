import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTScreen - Full height screen layout component with header/main/footer slots
 *
 * This component requires its parent to provide a height constraint (height: 100%).
 * When used inside ct-cell-context (which is auto-injected by the pattern renderer),
 * ct-screen automatically sets the `fill` attribute on its parent ct-cell-context
 * to enable scroll containment and proper flex layout.
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

  override connectedCallback() {
    super.connectedCallback();
    // ct-screen requires height: 100% from its parent to work correctly.
    // When the parent is ct-cell-context (auto-injected by the pattern renderer),
    // set the `fill` attribute to enable height propagation.
    const parent = this.parentElement;
    if (parent?.tagName.toLowerCase() === "ct-cell-context") {
      parent.setAttribute("fill", "");
    }
  }

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
