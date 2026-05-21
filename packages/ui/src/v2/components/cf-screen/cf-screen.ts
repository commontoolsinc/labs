import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFScreen - Full height screen layout component with header/main/footer slots
 *
 * @element cf-screen
 *
 * @slot header - Fixed header content at the top
 * @slot main - Main content that expands to fill available space (default slot)
 * @slot footer - Fixed footer content at the bottom
 *
 * @cssprop --cf-screen-footer-fade-height - Height of the main content fade when the footer contains an inset cf-tab-bar.
 * @cssprop --cf-screen-footer-overlap - Distance the main scroller overlaps into an inset cf-tab-bar footer.
 *
 * @example
 * <cf-screen>
 *   <h1 slot="header">Title</h1>
 *   <div slot="main">Expandable content</div>
 *   <div slot="footer">Footer</div>
 * </cf-screen>
 */
export class CFScreen extends BaseElement {
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
      overflow-y: auto;
      overflow-x: hidden;
    }

    :host([data-footer-fade]) .main {
      --_cf-screen-footer-overlap: var(
        --cf-screen-footer-overlap,
        var(--cf-tab-bar-height, 4rem)
      );
      --_cf-screen-footer-fade-height: var(
        --cf-screen-footer-fade-height,
        calc(var(--_cf-screen-footer-overlap) / 2)
      );
      margin-bottom: calc(-1 * var(--_cf-screen-footer-overlap));
      padding-bottom: var(--_cf-screen-footer-overlap);
      -webkit-mask-image: linear-gradient(
        to bottom,
        black 0,
        black calc(100% - var(--_cf-screen-footer-fade-height)),
        transparent 100%
      );
      mask-image: linear-gradient(
        to bottom,
        black 0,
        black calc(100% - var(--_cf-screen-footer-fade-height)),
        transparent 100%
      );
    }

    .footer {
      flex: none;
    }
  `;

  override firstUpdated() {
    this._syncFooterFade();
  }

  private _syncFooterFade = () => {
    const footerSlot = this.shadowRoot?.querySelector<HTMLSlotElement>(
      'slot[name="footer"]',
    );
    const hasFooterFade = footerSlot?.assignedElements({ flatten: true }).some(
      (element) =>
        element.localName === "cf-tab-bar" &&
        element.getAttribute("variant") === "inset" &&
        element.getAttribute("position") !== "top",
    ) ?? false;

    this.toggleAttribute("data-footer-fade", hasFooterFade);
  };

  override render() {
    return html`
      <div class="header" part="header">
        <slot name="header"></slot>
      </div>
      <div class="main" part="main">
        <slot></slot>
      </div>
      <div class="footer" part="footer">
        <slot name="footer" @slotchange="${this._syncFooterFade}"></slot>
      </div>
    `;
  }
}

globalThis.customElements.define("cf-screen", CFScreen);
