import { CTAutoLayout } from "./ct-autolayout.ts";

if (!customElements.get("ct-autolayout")) {
  customElements.define("ct-autolayout", CTAutoLayout);
}

export { CTAutoLayout };
