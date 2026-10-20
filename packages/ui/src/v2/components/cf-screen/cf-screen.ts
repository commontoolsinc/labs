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
 * The screen holds its content a gutter in from its edges, so content that
 * does no layout of its own does not draw against the edge of whatever hosts
 * the screen. Each region pads itself rather than the screen as a whole: the
 * main region scrolls edge to edge with the gutter inside it, and an empty
 * header or footer adds nothing. A footer holding an inset `cf-tab-bar` keeps
 * no gutter, since that bar places itself. `bleed` drops the gutter from every
 * region, for content that lays out its own edge, such as a header bar that
 * paints its own background.
 *
 * @element cf-screen
 *
 * @attr {boolean} bleed - Lays every region out flush with the screen's edges.
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
      /* Internal fallback defaults for footer tab-bar overlap and fade. */
      --_cf-screen-footer-overlap-default: 4rem;
      --_cf-screen-footer-fade-height-default: 2rem;

      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      box-sizing: border-box;
    }

    :host([bleed]) {
      --_cf-screen-gutter: 0px;
    }

    .header {
      flex: none;
    }

    :host([data-header]) .header {
      padding: var(--_cf-screen-gutter) var(--_cf-screen-gutter) 0;
    }

    .main {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      overflow-x: hidden;
      padding: var(--_cf-screen-gutter);
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
    }

    :host([data-footer]:not([data-footer-fade])) .footer {
      padding: 0 var(--_cf-screen-gutter) var(--_cf-screen-gutter);
    }
  `;

  override firstUpdated() {
    this._syncHeader();
    this._syncFooter();
  }

  private _assigned(name: string): Element[] {
    return this.shadowRoot?.querySelector<HTMLSlotElement>(
      `slot[name="${name}"]`,
    )?.assignedElements({ flatten: true }) ?? [];
  }

  private _syncHeader = () => {
    this.toggleAttribute("data-header", this._assigned("header").length > 0);
  };

  private _syncFooter = () => {
    const footer = this._assigned("footer");
    this.toggleAttribute("data-footer", footer.length > 0);
    this.toggleAttribute("data-footer-fade", footerFades(footer));
  };

  override render() {
    return html`
      <div class="header" part="header">
        <slot name="header" @slotchange="${this._syncHeader}"></slot>
      </div>
      <div class="main" part="main">
        <slot></slot>
      </div>
      <div class="footer" part="footer">
        <slot name="footer" @slotchange="${this._syncFooter}"></slot>
      </div>
    `;
  }
}
