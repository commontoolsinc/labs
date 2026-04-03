import { CFScrollArea, ScrollOrientation } from "./cf-scroll-area.ts";

if (!customElements.get("cf-scroll-area")) {
  customElements.define("cf-scroll-area", CFScrollArea);
}

export { CFScrollArea };
export type { ScrollOrientation };
