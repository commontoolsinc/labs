import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTCard - Content container with support for header, content, and footer sections
 *
 * @element ct-card
 *
 * @attr {boolean} clickable - Whether the card responds to click interactions
 *
 * @slot header - Card header content
 * @slot content - Main card content
 * @slot footer - Card footer content
 * @slot - Default slot (alternative to using named slots)
 *
 * @example
 * <ct-card>
 *   <h3 slot="header">Card Title</h3>
 *   <p slot="content">Card content goes here</p>
 *   <ct-button slot="footer">Action</ct-button>
 * </ct-card>
 *
 * Uses JS to detect empty slots (CSS :has() can't distinguish assigned vs fallback content).
 */

export class CTCard extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      box-sizing: border-box;
    }

    *,
    *::before,
    *::after {
      box-sizing: inherit;
    }

    .card {
      border-radius: var(--ct-theme-border-radius, 0.5rem);
      border: 1px solid var(--border, hsl(0, 0%, 89%));
      background-color: var(--card, hsl(0, 0%, 100%));
      color: var(--card-foreground, hsl(0, 0%, 9%));
      overflow: hidden;
      transition: all var(--ct-theme-animation-duration, 150ms)
        cubic-bezier(0.4, 0, 0.2, 1);
      }

      .card[tabindex="0"] {
        cursor: pointer;
      }

      .card[tabindex="0"]:hover {
        background-color: var(--accent, hsl(0, 0%, 96%));
        transform: translateY(-1px);
        box-shadow:
          0 4px 6px -1px rgba(0, 0, 0, 0.1),
          0 2px 4px -1px rgba(0, 0, 0, 0.06);
        }

        .card[tabindex="0"]:focus-visible {
          outline: 2px solid var(--ring, hsl(212, 100%, 47%));
          outline-offset: 2px;
        }

        .card[tabindex="0"]:active {
          transform: translateY(0);
        }

        /* Header section */
        .card-header {
          padding: var(--ct-theme-spacing-loose, 1rem);
          padding-bottom: 0;
        }

        /* When header is the only section, add bottom padding */
        .card-header:not(.empty):has(+ .card-content.empty) {
          padding-bottom: var(--ct-theme-spacing-loose, 1rem);
        }

        /* Hide header if empty (controlled by JS via .empty class) */
        .card-header.empty {
          display: none;
          padding: 0;
        }

        /* Title wrapper for title and action slots */
        .card-title-wrapper {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: var(--ct-theme-spacing-loose, 1rem);
        }

        /* Hide title wrapper if empty (controlled by JS via .empty class) */
        .card-title-wrapper.empty {
          display: none;
        }

        /* Title slot styling */
        ::slotted([slot="title"]) {
          font-size: 1.5rem;
          font-weight: 600;
          line-height: 2rem;
          letter-spacing: -0.025em;
          margin: 0;
        }

        /* Description slot styling */
        ::slotted([slot="description"]) {
          font-size: 0.875rem;
          line-height: 1.25rem;
          color: var(--muted-foreground, hsl(0, 0%, 45%));
          margin-top: var(--ct-theme-spacing-tight, 0.25rem);
        }

        /* Content section */
        .card-content {
          padding: var(--ct-theme-spacing-loose, 1rem);
        }

        /* Hide content if empty (controlled by JS via .empty class) */
        .card-content.empty {
          display: none;
          padding: 0;
        }

        /* Footer section */
        .card-footer {
          padding: var(--ct-theme-spacing-loose, 1rem);
          padding-top: 0;
        }

        /* Hide footer if empty (controlled by JS via .empty class) */
        .card-footer.empty {
          display: none;
          padding: 0;
        }

        /* Adjust spacing when sections are used together */
        .card-header:not(:empty) + .card-content:not(:empty) {
          padding-top: var(--ct-theme-spacing-loose, 1rem);
        }

        .card-content:not(:empty) + .card-footer:not(:empty) {
          padding-top: var(--ct-theme-spacing-loose, 1rem);
        }
      `;

      static override properties = {
        clickable: { type: Boolean },
      };

      declare clickable: boolean;

      constructor() {
        super();
        this.clickable = false;
      }

      override connectedCallback() {
        super.connectedCallback();
        if (this.clickable) {
          this.addEventListener("click", this._handleClick);
          this.addEventListener("keydown", this._handleKeydown);
        }
      }

      override firstUpdated() {
        // Set up slot change listeners to detect empty slots
        this.shadowRoot?.querySelectorAll("slot").forEach((slot) => {
          slot.addEventListener("slotchange", () => this._updateEmptyStates());
        });

        // Initial check for empty states
        this._updateEmptyStates();
      }

      override disconnectedCallback() {
        super.disconnectedCallback();
        this.removeEventListener("click", this._handleClick);
        this.removeEventListener("keydown", this._handleKeydown);
      }

      override updated(changedProperties: Map<string, any>) {
        if (changedProperties.has("clickable")) {
          if (this.clickable) {
            this.addEventListener("click", this._handleClick);
            this.addEventListener("keydown", this._handleKeydown);
          } else {
            this.removeEventListener("click", this._handleClick);
            this.removeEventListener("keydown", this._handleKeydown);
          }
        }
      }

      override render() {
        return html`
          <div
            class="card"
            part="card"
            tabindex="${this.clickable ? "0" : null}"
            role="${this.clickable ? "button" : null}"
          >
            <div class="card-header" part="header">
              <slot name="header">
                <div class="card-title-wrapper">
                  <slot name="title"></slot>
                  <slot name="action"></slot>
                </div>
                <slot name="description"></slot>
              </slot>
            </div>
            <div class="card-content" part="content">
              <slot name="content">
                <slot></slot>
              </slot>
            </div>
            <div class="card-footer" part="footer">
              <slot name="footer"></slot>
            </div>
          </div>
        `;
      }

      /** Check if slot has real content (not just whitespace) */
      private _slotHasContent(slot: HTMLSlotElement | null): boolean {
        if (!slot) return false;
        return slot.assignedNodes().some((node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent?.trim() !== "";
          }
          return true;
        });
      }

      /** Update empty state classes based on slot content */
      private _updateEmptyStates(): void {
        const getSlot = (name: string) =>
          this.shadowRoot?.querySelector(`slot[name="${name}"]`) as
            | HTMLSlotElement
            | null;

        const headerSlot = getSlot("header");
        const contentSlot = getSlot("content");
        const defaultSlot = contentSlot?.querySelector("slot:not([name])") as
          | HTMLSlotElement
          | null;
        const footerSlot = getSlot("footer");
        const titleSlot = getSlot("title");
        const actionSlot = getSlot("action");
        const descriptionSlot = getSlot("description");

        const hasHeader = this._slotHasContent(headerSlot);
        const hasContent = this._slotHasContent(contentSlot) ||
          this._slotHasContent(defaultSlot);
        const hasFooter = this._slotHasContent(footerSlot);
        const hasTitle = this._slotHasContent(titleSlot);
        const hasAction = this._slotHasContent(actionSlot);
        const hasDescription = this._slotHasContent(descriptionSlot);

        const showHeader = hasHeader || hasTitle || hasAction || hasDescription;
        const showTitleWrapper = hasTitle || hasAction;

        this.shadowRoot?.querySelector(".card-header")?.classList.toggle(
          "empty",
          !showHeader,
        );
        this.shadowRoot?.querySelector(".card-content")?.classList.toggle(
          "empty",
          !hasContent,
        );
        this.shadowRoot?.querySelector(".card-footer")?.classList.toggle(
          "empty",
          !hasFooter,
        );
        this.shadowRoot?.querySelector(".card-title-wrapper")?.classList.toggle(
          "empty",
          !showTitleWrapper,
        );
      }

      private _handleClick = (_event: Event): void => {
        if (!this.clickable) return;

        // Emit a custom click event
        this.emit("ct-card-click", {
          clickable: this.clickable,
        });
      };

      private _handleKeydown = (event: KeyboardEvent): void => {
        if (!this.clickable) return;

        // Handle Enter and Space keys for accessibility
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this._handleClick(event);
        }
      };

      /**
       * Focus the card programmatically (only works when clickable)
       */
      override focus(): void {
        if (this.clickable) {
          const card = this.shadowRoot?.querySelector(".card") as HTMLElement;
          card?.focus();
        }
      }

      /**
       * Blur the card programmatically
       */
      override blur(): void {
        const card = this.shadowRoot?.querySelector(".card") as HTMLElement;
        card?.blur();
      }
    }

    globalThis.customElements.define("ct-card", CTCard);
