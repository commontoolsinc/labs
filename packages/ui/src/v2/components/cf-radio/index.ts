import { CFRadio } from "./cf-radio.ts";

if (!customElements.get("cf-radio")) {
  customElements.define("cf-radio", CFRadio);
}

export { CFRadio };
