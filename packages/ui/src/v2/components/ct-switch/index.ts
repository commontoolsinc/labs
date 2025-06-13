import { CTSwitch } from "./ct-switch.ts";

if (!customElements.get("ct-switch")) {
  customElements.define("ct-switch", CTSwitch);
}

export { CTSwitch };
