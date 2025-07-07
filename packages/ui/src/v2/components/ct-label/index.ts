import { CTLabel } from "./ct-label.ts";

if (!customElements.get("ct-label")) {
  customElements.define("ct-label", CTLabel);
}

export { CTLabel };
export type { CTLabel as CTLabelElement } from "./ct-label.ts";
