import { CTCellLink } from "./ct-cell-link.ts";

if (!customElements.get("ct-cell-link")) {
  customElements.define("ct-cell-link", CTCellLink);
}

export { CTCellLink };
