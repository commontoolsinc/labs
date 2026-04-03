import { CFAutoLayout } from "./cf-autolayout.ts";

if (!customElements.get("cf-autolayout")) {
  customElements.define("cf-autolayout", CFAutoLayout);
}

export { CFAutoLayout };
