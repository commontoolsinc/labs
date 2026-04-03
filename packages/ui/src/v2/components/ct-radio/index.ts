import { CTRadio } from "./ct-radio.ts";

if (!customElements.get("ct-radio")) {
  customElements.define("ct-radio", CTRadio);
}

export { CTRadio };
