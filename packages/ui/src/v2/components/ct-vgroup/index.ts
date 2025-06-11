import { CTVGroup } from "./ct-vgroup.ts";

if (!customElements.get("ct-vgroup")) {
  customElements.define("ct-vgroup", CTVGroup);
}

export { CTVGroup };
