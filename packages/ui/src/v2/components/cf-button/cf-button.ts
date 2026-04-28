import { html } from "lit";
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

// ── Why the inner element is a <div>, not a <button> ──────────────────
//
// The host carries role="button", tabindex, and aria-disabled — it IS
// the button as far as the accessibility tree is concerned. If the
// shadow DOM also contained a native <button>, Playwright's
// getByRole('button', { name }) would return TWO matches (host + inner)
// and fail in strict mode. We can't suppress the inner button because:
//
//   • role="presentation" / role="none" — spec says browsers MUST ignore
//     these on focusable elements, and <button> is inherently focusable.
//   • aria-hidden="true" — hides the <slot> content too, so the host
//     loses its accessible name (computed from slotted text).
//
// Using <div> avoids both problems. Keyboard activation (Enter/Space)
// is handled by a host-level keydown listener. Form submission is
// already manual (_handleClick searches for the closest cf-form).
//
// If native <button> behavior is ever required, the escape hatch is:
// swap <div> back to <button>, add aria-hidden="true", and sync the
// host's aria-label from slotted text via a slotchange listener.
// ──────────────────────────────────────────────────────────────────────

export class CFButton extends BaseElement {
  static override styles = [BaseElement.baseStyles, styles];

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

    // Handle submit/reset for clicks from ANY source (mouse on inner div
    // bubbles through shadow boundary to host; keyboard Enter/Space fires
    // this.click() directly on host). Listening here instead of on the
    // inner element ensures keyboard activation triggers form submission.
    this.addEventListener("click", (e) => {
      this._handleClick(e);
    });

    // The host carries role="button" and tabindex, so it receives keyboard
    // events directly. Activate on Enter/Space like a native button.
    this.addEventListener("keydown", (e: KeyboardEvent) => {
      if (this.disabled) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.click();
      }
    });
  }

  override firstUpdated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.firstUpdated(changedProperties);
    this._updateAccessibilityAttributes();
    this._updateThemeProperties();
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

  override render() {
    const classes: { [key: string]: true } = {
      button: true,
    };
    if (typeof this.variant === "string" && this.variant) {
      classes[this.variant] = true;
    }
    if (typeof this.size === "string" && this.size) classes[this.size] = true;

    // The inner element is a <div>, not a <button>, so only the host
    // appears in the accessibility tree with role="button". This avoids
    // Playwright strict-mode violations from getByRole returning two
    // matches (host + inner native button). Keyboard activation and form
    // submission are handled by the host's keydown listener and
    // _handleClick respectively.
    return html`
      <div
        class="${classMap(classes)}"
        part="button"
        data-cf-button
      >
        <slot></slot>
      </div>
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
