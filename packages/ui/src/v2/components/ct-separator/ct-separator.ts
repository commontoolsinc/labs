/**
 * @fileoverview UI Separator Component - Visual divider for content sections
 *
 * @module ct-separator
 * @description
 * A visual separator component used to divide content sections with a line.
 * Can be oriented horizontally or vertically and supports decorative mode
 * for purely visual separation without semantic meaning.
 *
 * @example
 * ```html
 * <div>Section 1</div>
 * <ct-separator></ct-separator>
 * <div>Section 2</div>
 *
 * <!-- Vertical separator -->
 * <ct-separator orientation="vertical"></ct-separator>
 *
 * <!-- Decorative separator (no semantic meaning) -->
 * <ct-separator decorative></ct-separator>
 * ```
 */

import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

export type SeparatorOrientation = "horizontal" | "vertical";

/**
 * CTSeparator provides a visual divider between content sections.
 *
 * @tag ct-separator
 * @extends BaseElement
 *
 * @property {SeparatorOrientation} orientation - Direction of the separator ("horizontal" | "vertical")
 * @property {boolean} decorative - Whether the separator is purely decorative (no semantic meaning)
 *
 * @attribute {string} orientation - Sets the separator direction
 * @attribute {boolean} decorative - Marks separator as decorative only
 *
 * @csspart separator - The separator line element
 *
 * @note When decorative is false, the component has role="separator" for accessibility
 */
export class CTSeparator extends BaseElement {
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

    .separator {
      background-color: var(--border, hsl(0, 0%, 89%));
      flex-shrink: 0;
    }

    /* Horizontal orientation (default) */
    .separator.horizontal {
      height: 1px;
      width: 100%;
    }

    /* Vertical orientation */
    .separator.vertical {
      height: 100%;
      width: 1px;
    }

    /* Host display adjustments for vertical */
    :host([orientation="vertical"]) {
      display: inline-block;
      height: 100%;
    }
  `;

  static override properties = {
    orientation: { type: String },
    decorative: { type: Boolean },
  };

  declare orientation: SeparatorOrientation;
  declare decorative: boolean;

  constructor() {
    super();
    this.orientation = "horizontal";
    this.decorative = false;
  }

  override render() {
    return html`
      <div
        class="separator ${this.orientation}"
        part="separator"
        role="${this.decorative ? "none" : "separator"}"
        aria-orientation="${this.decorative ? null : this.orientation}"
      >
      </div>
    `;
  }
}

globalThis.customElements.define("ct-separator", CTSeparator);
