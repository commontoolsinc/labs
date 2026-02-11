/**
 * ct-bar-mark - Bar mark element for ct-chart.
 *
 * Headless config holder. Renders nothing visible.
 * The parent ct-chart reads properties and renders the bar SVG.
 *
 * @element ct-bar-mark
 */
import type { MarkType } from "../types.ts";
import { MarkElement } from "./base-mark.ts";

export class CTBarMark extends MarkElement {
  readonly markType: MarkType = "bar";

  static override properties = {
    ...MarkElement.properties,
    opacity: { type: Number },
    barPadding: { type: Number },
  };

  declare opacity: number;
  declare barPadding: number;

  constructor() {
    super();
    this.opacity = 1;
    this.barPadding = 0.2;
  }
}

customElements.define("ct-bar-mark", CTBarMark);

declare global {
  interface HTMLElementTagNameMap {
    "ct-bar-mark": CTBarMark;
  }
}
