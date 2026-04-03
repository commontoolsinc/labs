import { CTHGroup } from "./ct-hgroup.ts";

if (!customElements.get("ct-hgroup")) {
  customElements.define("ct-hgroup", CTHGroup);
}

export { CTHGroup };
