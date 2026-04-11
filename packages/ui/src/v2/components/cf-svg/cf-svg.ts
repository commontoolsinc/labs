import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { BaseElement } from "../../core/base-element.ts";
import { type CellHandle, isCellHandle } from "@commonfabric/runtime-client";
import { sanitizeSvg } from "./sanitize-svg.ts";

// TODO(v2-token-migration): Migrate this component to component-level tokens,
// matching the prior phase-1 token migration pattern.

/**
 * CFSvg - Renders SVG content from a string
 *
 * @element cf-svg
 *
 * @attr {string} content - The SVG markup to render (string or CellHandle<string>)
 *
 * @csspart content - The SVG content wrapper
 *
 * @example
 * <cf-svg content="<svg viewBox='0 0 100 100'><circle cx='50' cy='50' r='40' fill='blue'/></svg>"></cf-svg>
 *
 * @example
 * <cf-svg .content=${mySvgCell}></cf-svg>
 */
export class CFSvg extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        --cf-svg-width: 100%;
        --cf-svg-height: auto;

        display: block;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .svg-content {
        width: var(--cf-svg-width, 100%);
        height: var(--cf-svg-height, auto);
      }

      .svg-content svg {
        width: var(--cf-svg-width, 100%);
        height: var(--cf-svg-height, auto);
        display: block;
      }
    `,
  ];

  @property({ attribute: false })
  accessor content: CellHandle<string> | string = "";

  private _unsubscribe: (() => void) | null = null;

  constructor() {
    super();
    this.content = "";
  }

  private _getContentValue(): string {
    if (isCellHandle<string>(this.content)) {
      return this.content.get() ?? "";
    }
    return this.content ?? "";
  }

  override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.willUpdate(changedProperties);

    // Handle Cell subscription before render so first render has correct value
    if (changedProperties.has("content")) {
      // Clean up previous subscription
      if (this._unsubscribe) {
        this._unsubscribe();
        this._unsubscribe = null;
      }

      // Subscribe to new Cell if it's a Cell
      if (this.content && isCellHandle(this.content)) {
        this._unsubscribe = this.content.subscribe(() => {
          this.requestUpdate();
        });
      }
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  override render() {
    const contentValue = this._getContentValue();

    return html`
      <div class="svg-content" part="content">
        ${unsafeHTML(sanitizeSvg(contentValue))}
      </div>
    `;
  }
}

globalThis.customElements.define("cf-svg", CFSvg);
