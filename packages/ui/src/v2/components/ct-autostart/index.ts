import { CTAutostart } from "./ct-autostart.ts";

if (!customElements.get("ct-autostart")) {
  customElements.define("ct-autostart", CTAutostart);
}

export { CTAutostart };
