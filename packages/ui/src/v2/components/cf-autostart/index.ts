import { CFAutostart } from "./cf-autostart.ts";

if (!customElements.get("cf-autostart")) {
  customElements.define("cf-autostart", CFAutostart);
}

export { CFAutostart };
