import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { provide } from "@lit/context";
import { BaseElement } from "../../core/base-element.ts";
import {
  applyThemeToElement,
  type CTTheme,
  defaultTheme,
  mergeWithDefaultTheme,
  themeContext,
} from "../theme-context.ts";
import { type Cell, isCell } from "@commontools/runner";

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

  #unsubs: Array<() => void> = [];

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
    this.#setupSubscriptions();
  }

  #setupSubscriptions() {
    // Clear previous subscriptions
    for (const off of this.#unsubs) off();
    this.#unsubs = [];

    const t = this.theme as Record<string, unknown> | undefined;
    if (!t) return;

    // Subscribe to top-level cell properties to refresh CSS vars on change
    for (const key of Object.keys(t)) {
      const val = (t as any)[key];
      if (isCell && isCell(val)) {
        const cellVal = val as Cell<any>;
        const off = cellVal.sink(() => this._recomputeAndApply());
        this.#unsubs.push(off);
      }
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const off of this.#unsubs) off();
    this.#unsubs = [];
  }

  override render() {
    return html`
      <slot></slot>
    `;
  }
}

customElements.define("ct-theme", CTThemeProvider);
