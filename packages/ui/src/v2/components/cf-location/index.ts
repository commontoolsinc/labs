import { CFLocation } from "./cf-location.ts";

if (!customElements.get("cf-location")) {
  customElements.define("cf-location", CFLocation);
}

export { CFLocation };
export type { LocationData } from "./cf-location.ts";
