import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { provide } from "@lit/context";
import { BaseElement } from "../../core/base-element.ts";
import {
  applyThemeToElement,
  defaultTheme,
  mergeWithDefaultTheme,
  type CTTheme,
  themeContext,
} from "../theme-context.ts";

/**
 * ct-theme — Provides a theme to a subtree and applies CSS vars.
 *
 * Usage:
 * <ct-theme .theme=${partialTheme}><slot/></ct-theme>
 *
 * The component merges a partial theme (recipe-style) with defaults,
 * provides the result via context, and sets CSS custom properties on
 * the host so descendants pick up tokens.
 *
 * @element ct-theme
 */
export class CTThemeProvider extends BaseElement {
  static override styles = css`
    :host {
      display: contents; /* do not add extra layout */
    }
  `;

  /** Partial or full theme object (recipe-style supported) */
  @property({ attribute: false })
  theme: any = {};

  /** Computed full theme that is provided to children */
  @provide({ context: themeContext })
  @property({ attribute: false })
  _computedTheme: CTTheme = defaultTheme;

  override firstUpdated(changed: Map<string | number | symbol, unknown>) {
    super.firstUpdated(changed);
    this._recomputeAndApply();
  }

  override updated(changed: Map<string | number | symbol, unknown>) {
    super.updated(changed);
    if (changed.has("theme")) {
      this._recomputeAndApply();
    }
  }

  private _recomputeAndApply() {
    this._computedTheme = mergeWithDefaultTheme(this.theme);
    applyThemeToElement(this, this._computedTheme);
  }

  override render() {
    return html`<slot></slot>`;
  }
}

customElements.define("ct-theme", CTThemeProvider);

