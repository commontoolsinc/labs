/**
 * ct-dot-mark - Dot/scatter mark element for ct-chart.
 *
 * Headless config holder. Renders nothing visible.
 * The parent ct-chart reads properties and renders the dot SVG.
 *
 * @element ct-dot-mark
 */
import type { MarkType } from "../types.ts";
import { MarkElement } from "./base-mark.ts";

export class CTDotMark extends MarkElement {
  readonly markType: MarkType = "dot";

  static override properties = {
    ...MarkElement.properties,
    radius: { type: Number },
  };

  declare radius: number;

  constructor() {
    super();
    this.radius = 3;
  }
}

customElements.define("ct-dot-mark", CTDotMark);

declare global {
  interface HTMLElementTagNameMap {
    "ct-dot-mark": CTDotMark;
  }
}
