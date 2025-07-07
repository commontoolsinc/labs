import { CTTable } from "./ct-table.ts";

if (!customElements.get("ct-table")) {
  customElements.define("ct-table", CTTable);
}

export { CTTable };
