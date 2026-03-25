import { CFCellLink } from "./cf-cell-link.ts";

if (!customElements.get("cf-cell-link")) {
  customElements.define("cf-cell-link", CFCellLink);
}

export { CFCellLink };
