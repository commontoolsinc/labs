import { css, html, PropertyValues } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTVScroll - Vertical scroll container
 *
 * @element ct-vscroll
 *
 * @attr {boolean} show-scrollbar - Always show scrollbar
 * @attr {boolean} fade-edges - Show fade effect at edges
 * @attr {boolean} snap-to-bottom - Automatically scroll to bottom when new content is added
 * @attr {string} padding - Padding inside scroll area
 * @attr {string} height - Fixed height of the container
 * @attr {string} max-height - Maximum height of the container
 *
 * @slot - Content to be scrolled vertically
 *
 * @example
 * <ct-vscroll height="400px">
 *   <ct-vstack gap="4">
 *     <p>Long content...</p>
 *   </ct-vstack>
 * </ct-vscroll>
 */
export class CTVScroll extends BaseElement {
  static override properties = {
    showScrollbar: {
      type: Boolean,
      reflect: true,
      attribute: "show-scrollbar",
    },
    fadeEdges: { type: Boolean, reflect: true, attribute: "fade-edges" },
    snapToBottom: { type: Boolean, reflect: true, attribute: "snap-to-bottom" },
    padding: { type: String },
    height: { type: String },
    maxHeight: { type: String, attribute: "max-height" },
    _atStart: { type: Boolean, state: true },
    _atEnd: { type: Boolean, state: true },
  };

  static override styles = css`
    :host {
      display: block;
      position: relative;
      overflow: hidden;
    }

    .scroll-wrapper {
      position: relative;
      width: 100%;
      height: 100%;
    }

    .scroll-container {
      overflow-y: auto;
      overflow-x: hidden;
      width: 100%;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: thin;
    }

    /* Hide scrollbar by default */
    :host(:not([show-scrollbar])) .scroll-container {
      scrollbar-width: none;
      -ms-overflow-style: none;
    }

    :host(:not([show-scrollbar])) .scroll-container::-webkit-scrollbar {
      display: none;
    }

    /* Scrollbar styling when visible */
    .scroll-container::-webkit-scrollbar {
      width: 8px;
    }

    .scroll-container::-webkit-scrollbar-track {
      background: var(--muted, #f1f5f9);
      border-radius: 4px;
    }

    .scroll-container::-webkit-scrollbar-thumb {
      background: var(--muted-foreground, #64748b);
      border-radius: 4px;
    }

    .scroll-container::-webkit-scrollbar-thumb:hover {
      background: var(--foreground, #475569);
    }

    /* Padding utilities */
    .p-0 {
      padding: 0;
    }
    .p-1 {
      padding: 0.25rem;
    }
    .p-2 {
      padding: 0.5rem;
    }
    .p-3 {
      padding: 0.75rem;
    }
    .p-4 {
      padding: 1rem;
    }
    .p-5 {
      padding: 1.25rem;
    }
    .p-6 {
      padding: 1.5rem;
    }
    .p-8 {
      padding: 2rem;
    }

    /* Fade edges */
    :host([fade-edges]) .scroll-wrapper::before,
    :host([fade-edges]) .scroll-wrapper::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      height: 2rem;
      pointer-events: none;
      z-index: 1;
      transition: opacity 0.2s;
    }

    :host([fade-edges]) .scroll-wrapper::before {
      top: 0;
      background: linear-gradient(
        to bottom,
        var(--background, white),
        transparent
      );
      opacity: 0;
    }

    :host([fade-edges]) .scroll-wrapper::after {
      bottom: 0;
      background: linear-gradient(to top, var(--background, white), transparent);
      opacity: 0;
    }

    :host([fade-edges]) .scroll-wrapper:not(.at-start)::before {
      opacity: 1;
    }

    :host([fade-edges]) .scroll-wrapper:not(.at-end)::after {
      opacity: 1;
    }
  `;

  declare showScrollbar: boolean;
  declare fadeEdges: boolean;
  declare snapToBottom: boolean;
  declare padding: string;
  declare height: string;
  declare maxHeight: string;
  declare _atStart: boolean;
  declare _atEnd: boolean;

  private _scrollContainer: HTMLElement | null = null;
  private _mutationObserver: MutationObserver | null = null;
  private _wasAtBottom = true;

  constructor() {
    super();
    this.showScrollbar = false;
    this.fadeEdges = false;
    this.snapToBottom = false;
    this.padding = "0";
    this.height = "";
    this.maxHeight = "";
    this._atStart = true;
    this._atEnd = true;
  }

  get scrollContainer(): HTMLElement | null {
    if (!this._scrollContainer) {
      this._scrollContainer = this.shadowRoot?.querySelector(
        ".scroll-container",
      ) as HTMLElement | null;
    }
    return this._scrollContainer;
  }

  override firstUpdated() {
    // Cache reference
    this._scrollContainer = this.shadowRoot?.querySelector(
      ".scroll-container",
    ) as HTMLElement | null;
    this.updateScrollState();
  }

  override connectedCallback() {
    super.connectedCallback();
    // Set up scroll listener after element is ready
    this.updateComplete.then(() => {
      if (this.scrollContainer) {
        (this.scrollContainer as HTMLElement).addEventListener(
          "scroll",
          this.handleScroll,
        );
      }
      this.setupMutationObserver();
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.scrollContainer) {
      (this.scrollContainer as HTMLElement).removeEventListener(
        "scroll",
        this.handleScroll,
      );
    }
    this.cleanupMutationObserver();
  }

  private handleScroll = () => {
    this.updateScrollState();
    this.emit("ct-scroll", {
      scrollTop: (this.scrollContainer as HTMLElement)?.scrollTop || 0,
      scrollHeight: (this.scrollContainer as HTMLElement)?.scrollHeight || 0,
      clientHeight: (this.scrollContainer as HTMLElement)?.clientHeight || 0,
    });
  };

  private updateScrollState() {
    if (!this.scrollContainer) return;

    const { scrollTop, scrollHeight, clientHeight } = this
      .scrollContainer as HTMLElement;
    this._atStart = scrollTop <= 0;
    this._atEnd = scrollTop + clientHeight >= scrollHeight - 1;
    
    // Track if user was at bottom for snapToBottom behavior
    if (this.snapToBottom) {
      this._wasAtBottom = this._atEnd;
    }
  }

  override render() {
    const wrapperClasses = {
      "scroll-wrapper": true,
      "at-start": this._atStart,
      "at-end": this._atEnd,
    };

    const containerClasses = {
      "scroll-container": true,
      [`p-${this.padding}`]: true,
    };

    const containerStyles = {
      height: this.height || "100%",
      "max-height": this.maxHeight || "none",
    };

    return html`
      <div class="${classMap(wrapperClasses)}" part="wrapper">
        <div
          class="${classMap(containerClasses)}"
          style="${styleMap(containerStyles)}"
          part="container"
        >
          <slot></slot>
        </div>
      </div>
    `;
  }

  /**
   * Scroll to a specific vertical position
   */
  scrollToY(y: number, smooth: boolean = true) {
    if (this.scrollContainer) {
      (this.scrollContainer as HTMLElement).scrollTo({
        top: y,
        behavior: smooth ? "smooth" : "auto",
      });
    }
  }

  /**
   * Scroll by a specific vertical amount
   */
  scrollByY(y: number, smooth: boolean = true) {
    if (this.scrollContainer) {
      (this.scrollContainer as HTMLElement).scrollBy({
        top: y,
        behavior: smooth ? "smooth" : "auto",
      });
    }
  }

  /**
   * Scroll to the bottom of the container
   */
  scrollToBottom(smooth: boolean = true) {
    if (this.scrollContainer) {
      const { scrollHeight } = this.scrollContainer as HTMLElement;
      this.scrollToY(scrollHeight, smooth);
    }
  }

  private setupMutationObserver() {
    if (!this.snapToBottom) return;

    this.cleanupMutationObserver();

    this._mutationObserver = new MutationObserver(() => {
      // Only auto-scroll if user was at bottom when content changed
      if (this._wasAtBottom) {
        // Use requestAnimationFrame to ensure DOM has updated
        requestAnimationFrame(() => {
          this.scrollToBottom();
        });
      }
    });

    // Observe changes to the slotted content
    this._mutationObserver.observe(this, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  private cleanupMutationObserver() {
    if (this._mutationObserver) {
      this._mutationObserver.disconnect();
      this._mutationObserver = null;
    }
  }
}

globalThis.customElements.define("ct-vscroll", CTVScroll);
