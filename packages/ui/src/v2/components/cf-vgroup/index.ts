import { CFVGroup } from "./cf-vgroup.ts";

if (!customElements.get("cf-vgroup")) {
  customElements.define("cf-vgroup", CFVGroup);
}

export { CFVGroup };
