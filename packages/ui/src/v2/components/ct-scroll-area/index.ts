import { CTScrollArea, ScrollOrientation } from "./ct-scroll-area.ts";

if (!customElements.get("ct-scroll-area")) {
  customElements.define("ct-scroll-area", CTScrollArea);
}

export { CTScrollArea };
export type { ScrollOrientation };
