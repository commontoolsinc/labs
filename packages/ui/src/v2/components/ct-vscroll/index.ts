import { CTVScroll } from "./ct-vscroll.ts";

if (!customElements.get("ct-vscroll")) {
  customElements.define("ct-vscroll", CTVScroll);
}

export { CTVScroll };
