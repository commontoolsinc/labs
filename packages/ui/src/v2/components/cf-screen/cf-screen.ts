import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/** The part of a slotted element the footer-fade decision reads. */
type FooterSlotEntry = Pick<Element, "localName" | "getAttribute">;

/**
 * Whether the main scroller fades out where it meets the footer, given what
 * the footer slot holds. An inset `cf-tab-bar` along the bottom is the one
 * arrangement it fades for: the scroller runs underneath such a bar, so its
 * content has to fall away instead of ending at the bar's edge.
 */
export function footerFades(slotted: readonly FooterSlotEntry[]): boolean {
  return slotted.some((element) =>
    element.localName === "cf-tab-bar" &&
    element.getAttribute("variant") === "inset" &&
    element.getAttribute("position") !== "top"
  );
}

/**
 * CFScreen - Full height screen layout component with header/main/footer slots
 *
 * A screen has margins and bars do not. The screen pads itself by a gutter, so
 * content that does no layout of its own does not draw against the edge of
 * whatever hosts it. A `cf-toolbar` in the header or footer, or a `cf-tab-bar`
 * in the footer, cancels the gutter and runs to the screen's edges. `bleed`
 * drops the gutter, for content that lays out its own edge, such as a
 * hand-built header bar that paints its own background.
 *
 * @element cf-screen
 *
 * @attr {boolean} bleed - Lays the content out flush with the screen's edges.
 *
 * @slot header - Fixed header content at the top
 * @slot main - Main content that expands to fill available space (default slot)
 * @slot footer - Fixed footer content at the bottom
 *
 * @cssprop --cf-screen-gutter - Space between the screen's edges and its content. Defaults to the theme's `--cf-theme-spacing-loose`.
 * @cssprop --cf-screen-footer-overlap - Distance the main scroller overlaps into reserved inset footer space. Increase this to move the fade lower into the footer region.
 * @cssprop --cf-screen-footer-fade-height - Height of the main content fade at the bottom of the overlapped scroller region.
 *
 * @example
 * <cf-screen>
 *   <h1 slot="header">Title</h1>
 *   <div slot="main">Expandable content</div>
 *   <div slot="footer">Footer</div>
 * </cf-screen>
 */
export class CFScreen extends BaseElement {
  static override properties = {
    bleed: { type: Boolean, reflect: true },
  };

  declare bleed: boolean;

  constructor() {
    super();
    this.bleed = false;
  }

  static override styles = css`
    :host {
      --_cf-screen-gutter: var(
        --cf-screen-gutter,
        var(--cf-theme-spacing-loose, 0.75rem)
      );
      --_cf-screen-gutter-pull: calc(-1 * var(--_cf-screen-gutter));
      /* Internal fallback defaults for footer tab-bar overlap and fade. */
      --_cf-screen-footer-overlap-default: 4rem;
      --_cf-screen-footer-fade-height-default: 2rem;

      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      box-sizing: border-box;
      padding: var(--_cf-screen-gutter);
    }

    :host([bleed]) {
      --_cf-screen-gutter: 0px;
    }

    /* A region reaches into the padding at its outer edge and pads it back, */
    /* so a bar that cancels the gutter leaves the region its full height. */
    .header {
      flex: none;
      margin-top: var(--_cf-screen-gutter-pull);
      padding-top: var(--_cf-screen-gutter);
    }

    slot[name="header"]::slotted(cf-toolbar) {
      margin: var(--_cf-screen-gutter-pull) var(--_cf-screen-gutter-pull) 0;
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
        var(
          --cf-tab-bar-height,
          var(--_cf-screen-footer-overlap-default)
        )
      );
      --_cf-screen-footer-fade-height: var(
        --cf-screen-footer-fade-height,
        var(--_cf-screen-footer-fade-height-default)
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
      margin-bottom: var(--_cf-screen-gutter-pull);
      padding-bottom: var(--_cf-screen-gutter);
    }

    slot[name="footer"]::slotted(cf-toolbar),
    slot[name="footer"]::slotted(cf-tab-bar) {
      margin: 0 var(--_cf-screen-gutter-pull) var(--_cf-screen-gutter-pull);
    }
  `;

  override firstUpdated() {
    this._syncFooterFade();
  }

  private _syncFooterFade = () => {
    const footerSlot = this.shadowRoot?.querySelector<HTMLSlotElement>(
      'slot[name="footer"]',
    );
    this.toggleAttribute(
      "data-footer-fade",
      footerFades(footerSlot?.assignedElements({ flatten: true }) ?? []),
    );
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
