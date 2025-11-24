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
 * ## Empty Section Handling
 *
 * This component automatically hides header/footer sections when they have no
 * slotted content to avoid unnecessary whitespace.
 *
 * ### Implementation Approach
 *
 * We use JavaScript to detect empty slots because CSS cannot reliably detect
 * whether a slot has assigned content vs fallback content.
 *
 * The component listens to `slotchange` events and checks `assignedNodes()` to
 * determine if each slot has actual slotted content. It then adds/removes an
 * `.empty` class which CSS uses to hide the section.
 *
 * ### Why Not Pure CSS?
 *
 * We explored several CSS-only approaches but all had fundamental limitations:
 *
 * 1. **:not(:has(*))** - Doesn't work because slots with fallback content always
 *    have children (the fallback elements), even when showing no slotted content.
 *    This was the previous approach (commit 7696b91) which appeared to work in
 *    testing but failed in practice.
 *
 * 2. **:empty** - Doesn't work because the slot element itself exists, making
 *    parent divs non-empty.
 *
 * 3. **::slotted() selectors** - Cannot be used inside :has() or other complex
 *    selectors to detect presence/absence of content.
 *
 * 4. **Checking for non-fallback elements** - No CSS selector can distinguish
 *    between "slot showing fallback" vs "slot showing slotted content" because
 *    both render as the slot element with children in the DOM.
 *
 * 5. **Removing fallback content** - Would break the useful title/action/description
 *    slot pattern that provides structured header content.
 *
 * ### Performance
 *
 * The JS approach is very performant:
 * - `slotchange` only fires when content actually changes, not on every render
 * - `assignedNodes()` is a fast native DOM API call
 * - This is a standard pattern in professional web component libraries
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
      border-radius: var(--radius-lg, 0.5rem);
      border: 1px solid var(--border, hsl(0, 0%, 89%));
      background-color: var(--card, hsl(0, 0%, 100%));
      color: var(--card-foreground, hsl(0, 0%, 9%));
      overflow: hidden;
      transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
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
        padding: 1.5rem;
        padding-bottom: 0;
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
        gap: 1rem;
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
        margin-top: 0.25rem;
      }

      /* Content section */
      .card-content {
        padding: 1.5rem;
      }

      /* Hide content if empty (controlled by JS via .empty class) */
      .card-content.empty {
        display: none;
        padding: 0;
      }

      /* Footer section */
      .card-footer {
        padding: 1.5rem;
        padding-top: 0;
      }

      /* Hide footer if empty (controlled by JS via .empty class) */
      .card-footer.empty {
        display: none;
        padding: 0;
      }

      /* Adjust spacing when sections are used together */
      .card-header:not(:empty) + .card-content:not(:empty) {
        padding-top: 1.5rem;
      }

      .card-content:not(:empty) + .card-footer:not(:empty) {
        padding-top: 1.5rem;
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
      this.shadowRoot?.querySelectorAll('slot').forEach(slot => {
        slot.addEventListener('slotchange', () => this._updateEmptyStates());
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

    /**
     * Update empty state classes on header/content/footer sections based on
     * whether their slots have assigned content.
     */
    private _updateEmptyStates(): void {
      const headerSlot = this.shadowRoot?.querySelector('slot[name="header"]') as HTMLSlotElement | null;
      const contentNamedSlot = this.shadowRoot?.querySelector('slot[name="content"]') as HTMLSlotElement | null;
      const contentDefaultSlot = contentNamedSlot?.querySelector('slot:not([name])') as HTMLSlotElement | null;
      const footerSlot = this.shadowRoot?.querySelector('slot[name="footer"]') as HTMLSlotElement | null;

      // Check nested slots for title/description/action pattern
      const titleSlot = this.shadowRoot?.querySelector('slot[name="title"]') as HTMLSlotElement | null;
      const actionSlot = this.shadowRoot?.querySelector('slot[name="action"]') as HTMLSlotElement | null;
      const descriptionSlot = this.shadowRoot?.querySelector('slot[name="description"]') as HTMLSlotElement | null;

      const header = this.shadowRoot?.querySelector('.card-header');
      const content = this.shadowRoot?.querySelector('.card-content');
      const footer = this.shadowRoot?.querySelector('.card-footer');
      const titleWrapper = this.shadowRoot?.querySelector('.card-title-wrapper');

      // Check if slots have assigned content (actual slotted elements/nodes)
      const hasHeaderContent = (headerSlot?.assignedNodes().length ?? 0) > 0;

      // Content has content if EITHER the named "content" slot OR the default slot has nodes
      const hasContentNamedSlot = (contentNamedSlot?.assignedNodes().length ?? 0) > 0;
      const hasContentDefaultSlot = (contentDefaultSlot?.assignedNodes().length ?? 0) > 0;
      const hasContentContent = hasContentNamedSlot || hasContentDefaultSlot;

      const hasFooterContent = (footerSlot?.assignedNodes().length ?? 0) > 0;

      // Check if title/action slots have content (for title-wrapper visibility)
      const hasTitleContent = (titleSlot?.assignedNodes().length ?? 0) > 0;
      const hasActionContent = (actionSlot?.assignedNodes().length ?? 0) > 0;
      const hasTitleWrapperContent = hasTitleContent || hasActionContent;

      // If using title/description/action pattern, header should be visible even without explicit slot="header"
      const hasNestedHeaderContent = hasTitleContent || hasActionContent || ((descriptionSlot?.assignedNodes().length ?? 0) > 0);
      const shouldShowHeader = hasHeaderContent || hasNestedHeaderContent;

      // Add/remove 'empty' class based on slot content
      header?.classList.toggle('empty', !shouldShowHeader);
      content?.classList.toggle('empty', !hasContentContent);
      footer?.classList.toggle('empty', !hasFooterContent);
      titleWrapper?.classList.toggle('empty', !hasTitleWrapperContent);
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
