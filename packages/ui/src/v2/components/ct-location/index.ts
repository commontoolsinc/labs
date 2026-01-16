import { CTLocation } from "./ct-location.ts";

if (!customElements.get("ct-location")) {
  customElements.define("ct-location", CTLocation);
}

export { CTLocation };
export type { LocationData } from "./ct-location.ts";
