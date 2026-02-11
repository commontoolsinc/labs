/**
 * ct-line-mark - Line mark element for ct-chart.
 *
 * Headless config holder. Renders nothing visible.
 * The parent ct-chart reads properties and renders the line SVG.
 *
 * @element ct-line-mark
 */
import type { CurveType, MarkType } from "../types.ts";
import { MarkElement } from "./base-mark.ts";

export class CTLineMark extends MarkElement {
  readonly markType: MarkType = "line";

  static override properties = {
    ...MarkElement.properties,
    strokeWidth: { type: Number },
    curve: { type: String },
  };

  declare strokeWidth: number;
  declare curve: CurveType;

  constructor() {
    super();
    this.strokeWidth = 2;
    this.curve = "linear";
  }
}

customElements.define("ct-line-mark", CTLineMark);

declare global {
  interface HTMLElementTagNameMap {
    "ct-line-mark": CTLineMark;
  }
}
