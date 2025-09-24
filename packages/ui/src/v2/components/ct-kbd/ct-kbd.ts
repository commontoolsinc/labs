import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CTKbd - Inline keyboard hint element
 *
 * @element ct-kbd
 *
 * @slot - Shortcut text (e.g. ⌘N)
 */
export class CTKbd extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
      }

      .kbd {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0 0.375rem;
        height: 1.25rem;
        border-radius: 0.25rem;
        background: var(
          --ct-theme-color-surface,
          var(--ct-color-gray-100, #f3f4f6)
        );
        border: 1px solid
          var(--ct-theme-color-border, var(--ct-color-gray-300, #d1d5db));
        color: var(--ct-theme-color-text, var(--ct-color-gray-800, #1f2937));
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.75rem;
        line-height: 1;
        user-select: none;
        vertical-align: middle;
        margin-left: 0.375rem;
      }
    `,
  ];

  override render() {
    return html`<span class="kbd" part="kbd"><slot></slot></span>`;
  }
}

globalThis.customElements.define("ct-kbd", CTKbd);

