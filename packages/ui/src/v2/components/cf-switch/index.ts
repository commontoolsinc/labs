import { CFSwitch } from "./cf-switch.ts";

if (!customElements.get("cf-switch")) {
  customElements.define("cf-switch", CFSwitch);
}

export { CFSwitch };
