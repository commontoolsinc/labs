import { CTHeading } from "./ct-heading.ts";

if (!customElements.get("ct-heading")) {
  customElements.define("ct-heading", CTHeading);
}

export { CTHeading };
