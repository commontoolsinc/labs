import { CTSvg } from "./ct-svg.ts";

if (!customElements.get("ct-svg")) {
  customElements.define("ct-svg", CTSvg);
}

export { CTSvg };
export type { CTSvg as CTSvgElement } from "./ct-svg.ts";
