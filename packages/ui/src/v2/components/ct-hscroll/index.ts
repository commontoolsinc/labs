import { CTHScroll } from "./ct-hscroll.ts";

if (!customElements.get("ct-hscroll")) {
  customElements.define("ct-hscroll", CTHScroll);
}

export { CTHScroll };
