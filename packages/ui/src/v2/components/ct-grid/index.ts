import { CTGrid } from "./ct-grid.ts";

if (!customElements.get("ct-grid")) {
  customElements.define("ct-grid", CTGrid);
}

export { CTGrid };
