import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import { consume } from "@lit/context";
import {
  applyThemeToElement,
  type CTTheme,
  defaultTheme,
  themeContext,
} from "../theme-context.ts";

/**
 * CTHeading – Theme-compliant heading that replaces h1–h6.
 *
 * @element ct-heading
 *
 * @attr {number} level - Heading level (1–6). Default: 3.
 * @attr {boolean} noMargin - Remove default bottom margin.
 *
 * @slot - Heading content
 */
export class CTHeading extends BaseElement {
  static override properties = {
    level: { type: Number, reflect: true },
    noMargin: { type: Boolean, reflect: true, attribute: "no-margin" },
  };

  @consume({ context: themeContext, subscribe: true })
  @property({ attribute: false })
  declare theme?: CTTheme;

  declare level: number;
  declare noMargin: boolean;

  constructor() {
    super();
    this.level = 3;
    this.noMargin = false;
  }

  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        color: var(--ct-theme-color-text, #111827);
        font-family: var(--ct-theme-font-family, inherit);
      }

      .heading {
        margin: 0 0 var(--ct-spacing-2, 0.5rem) 0;
      }

      :host([no-margin]) .heading {
        margin: 0;
      }

      /* Level styles using workspace variables */
      .h1 {
        font-size: var(--ct-font-size-4xl, 2.25rem);
        line-height: var(--ct-line-height-tight, 1.25);
        font-weight: var(--ct-font-weight-bold, 700);
      }

      .h2 {
        font-size: var(--ct-font-size-3xl, 1.875rem);
        line-height: var(--ct-line-height-snug, 1.375);
        font-weight: var(--ct-font-weight-semibold, 600);
      }

      .h3 {
        font-size: var(--ct-font-size-2xl, 1.5rem);
        line-height: var(--ct-line-height-normal, 1.5);
        font-weight: var(--ct-font-weight-semibold, 600);
      }

      .h4 {
        font-size: var(--ct-font-size-xl, 1.25rem);
        line-height: var(--ct-line-height-normal, 1.5);
        font-weight: var(--ct-font-weight-medium, 500);
      }

      .h5 {
        font-size: var(--ct-font-size-lg, 1.125rem);
        line-height: var(--ct-line-height-normal, 1.5);
        font-weight: var(--ct-font-weight-normal, 400);
      }

      .h6 {
        font-size: var(--ct-font-size-base, 1rem);
        line-height: var(--ct-line-height-normal, 1.5);
        font-weight: var(--ct-font-weight-normal, 400);
        color: var(--ct-theme-color-text-muted, #6b7280);
      }
    `,
  ];

  override firstUpdated() {
    applyThemeToElement(this, this.theme ?? defaultTheme);
  }

  override updated(changed: Map<string | number | symbol, unknown>) {
    if (changed.has("theme")) {
      applyThemeToElement(this, this.theme ?? defaultTheme);
    }
  }

  private _cls(): string {
    const lvl = Math.min(6, Math.max(1, Number(this.level) || 3));
    return `h${lvl}`;
  }

  override render() {
    const level = Math.min(6, Math.max(1, Number(this.level) || 3));
    return html`
      <div
        class="heading ${this._cls()}"
        role="heading"
        aria-level="${level}"
        part="heading"
      >
        <slot></slot>
      </div>
    `;
  }
}

if (!customElements.get("ct-heading")) {
  customElements.define("ct-heading", CTHeading);
}
