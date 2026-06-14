import { CFVScroll } from "./cf-vscroll.ts";

if (!customElements.get("cf-vscroll")) {
  customElements.define("cf-vscroll", CFVScroll);
}

export { CFVScroll };
