import { CTKbd } from "./ct-kbd.ts";

if (!customElements.get("ct-kbd")) {
  customElements.define("ct-kbd", CTKbd);
}

export type { CTKbd as CTKbdElement } from "./ct-kbd.ts";
