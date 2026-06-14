import { CFGrid } from "./cf-grid.ts";

if (!customElements.get("cf-grid")) {
  customElements.define("cf-grid", CFGrid);
}

export { CFGrid };
