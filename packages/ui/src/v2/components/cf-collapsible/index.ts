import { CFCollapsible } from "./cf-collapsible.ts";

if (!customElements.get("cf-collapsible")) {
  customElements.define("cf-collapsible", CFCollapsible);
}

export { CFCollapsible };
