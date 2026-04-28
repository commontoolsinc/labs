import { html, LitElement } from "lit";
import { styles } from "./styles.ts";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { consume } from "@lit/context";
import { BaseElement } from "../../core/base-element.ts";
import {
  applyThemeToElement,
  type CFTheme,
  cfThemeContext,
  type ComponentSize,
  defaultTheme,
} from "../theme-context.ts";

/**
 * CFButton - Interactive button element with multiple variants and sizes
 *
 * @element cf-button
 *
 * @attr {string} variant - Visual style variant: "primary" | "secondary" | "destructive" | "outline" | "ghost" | "link" | "pill"
 * @attr {string} size - Button size: "xs" | "sm" | "md" | "lg" | "xl" | "icon"
 * @attr {boolean} disabled - Whether the button is disabled
 * @attr {string} type - Button type: "button" | "submit" | "reset"
 *
 * @slot - Default slot for button content
 *
 * @example
 * <cf-button variant="primary" size="lg" @click=${() => console.log('Button clicked')}>Click Me</cf-button>
 */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "destructive"
  | "outline"
  | "ghost"
  | "link"
  | "pill";

export type ButtonSize = ComponentSize | "icon";

// ── Accessibility strategy ───────────────────────────────────────────
//
// The host carries role="button" so agents can find it via getByRole.
// The shadow DOM contains a real <button> for native keyboard handling
// (Enter/Space) and delegatesFocus. To prevent Playwright from seeing
// TWO buttons (host + inner), the inner <button> has aria-hidden="true".
//
// aria-hidden also hides the <slot> content from the a11y tree, so the
// host would lose its computed accessible name. We restore it by syncing
// the host's aria-label from the light DOM textContent via slotchange.
// This is skipped when the author provides their own aria-label or
// aria-labelledby.
// ─────────────────────────────────────────────────────────────────────

export class CFButton extends BaseElement {
  static override styles = [BaseElement.baseStyles, styles];
  static override shadowRootOptions = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  static override properties = {
    variant: { type: String },
    size: { type: String, reflect: true },
    disabled: { type: Boolean, reflect: true },
    type: { type: String },
    theme: { type: Object, attribute: false },
  };

  declare variant: ButtonVariant;
  declare size: ButtonSize;
  declare disabled: boolean;
  declare type: "button" | "submit" | "reset";

  @consume({ context: cfThemeContext, subscribe: true })
  @property({ attribute: false })
  accessor theme: CFTheme = defaultTheme;

  constructor() {
    super();
    this.variant = "primary";
    this.size = "md";
    this.disabled = false;
    this.type = "button";

    // Suppress click events on the host element when disabled.
    // JSX attaches onClick handlers to the host element, but click events
    // cross the shadow boundary and would fire even when disabled.
    this.addEventListener(
      "click",
      (e) => {
        if (this.disabled) {
          e.stopImmediatePropagation();
        }
      },
      { capture: true },
    );

    // Handle submit/reset for clicks from ANY source (mouse click on inner
    // button bubbles through shadow boundary to host; keyboard Enter/Space
    // on the inner button also fires a click that bubbles here).
    this.addEventListener("click", (e) => {
      this._handleClick(e);
    });
  }

  override firstUpdated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.firstUpdated(changedProperties);
    this._updateAccessibilityAttributes();
    this._updateThemeProperties();

    // Sync the host's aria-label from slotted text content. The inner
    // <button> is aria-hidden, so the slot content is invisible to the
    // a11y tree — we must provide the name explicitly on the host.
    const slot = this.shadowRoot?.querySelector("slot");
    if (slot) {
      slot.addEventListener("slotchange", () => this._syncAriaLabel());
      this._syncAriaLabel();
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    this._updateAccessibilityAttributes();
  }

  override updated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.updated(changedProperties);
    if (changedProperties.has("disabled")) {
      this._updateAccessibilityAttributes();
    }
    if (changedProperties.has("theme")) {
      this._updateThemeProperties();
    }
  }

  private _updateThemeProperties() {
    const currentTheme = this.theme || defaultTheme;
    applyThemeToElement(this, currentTheme);
  }

  private _updateAccessibilityAttributes() {
    if (!this.hasAttribute("role")) {
      this.setAttribute("role", "button");
    }
    if (!this.hasAttribute("exportparts")) {
      this.setAttribute("exportparts", "button");
    }
    this.tabIndex = this.disabled ? -1 : 0;
    this.setAttribute("aria-disabled", String(this.disabled));
  }

  /**
   * Sync the host's aria-label from slotted text content, unless the
   * author has provided their own aria-label or aria-labelledby.
   */
  private _syncAriaLabel() {
    if (
      this.hasAttribute("aria-labelledby") ||
      this._authorAriaLabel !== null
    ) {
      return;
    }
    const text = this.textContent?.trim() || "";
    if (text) {
      this.setAttribute("aria-label", text);
    }
  }

  /** Stash the author's aria-label (if any) so _syncAriaLabel won't overwrite it. */
  private get _authorAriaLabel(): string | null {
    // If aria-label was set before we started syncing, it's the author's.
    // After first sync, our generated value is present. We distinguish by
    // comparing against the current textContent — if they match, it's ours.
    const label = this.getAttribute("aria-label");
    if (label === null) return null;
    const text = this.textContent?.trim() || "";
    return label !== text ? label : null;
  }

  override render() {
    const classes: { [key: string]: true } = {
      button: true,
    };
    if (typeof this.variant === "string" && this.variant) {
      classes[this.variant] = true;
    }
    if (typeof this.size === "string" && this.size) classes[this.size] = true;

    // The inner <button> is aria-hidden so only the host appears in the
    // a11y tree with role="button". delegatesFocus forwards focus to the
    // inner button, which handles Enter/Space natively. The host's
    // aria-label is synced from slotted textContent via slotchange.
    return html`
      <button
        class="${classMap(classes)}"
        ?disabled="${this.disabled}"
        type="${this.type}"
        part="button"
        data-cf-button
        tabindex="-1"
        aria-hidden="true"
      >
        <slot></slot>
      </button>
    `;
  }

  private _handleClick(e: Event) {
    if (this.disabled) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // For submit/reset types, we need to manually find the ancestor cf-form
    // because the native button in our shadow DOM can't find forms across
    // shadow DOM boundaries
    if (this.type === "submit" || this.type === "reset") {
      const cfForm = this.closest("cf-form") as
        | (Element & { submit(): void; reset(): void })
        | null;
      if (cfForm) {
        e.preventDefault(); // Prevent native form lookup (which would fail)
        if (this.type === "submit") {
          cfForm.submit();
        } else {
          cfForm.reset();
        }
      }
      // If no cf-form found, let native behavior try (might work with light DOM forms)
      return;
    }
  }
}

globalThis.customElements.define("cf-button", CFButton);
