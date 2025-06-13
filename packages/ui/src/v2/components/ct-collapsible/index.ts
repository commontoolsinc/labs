import { CTCollapsible } from "./ct-collapsible.ts";

if (!customElements.get("ct-collapsible")) {
  customElements.define("ct-collapsible", CTCollapsible);
}

export { CTCollapsible };
