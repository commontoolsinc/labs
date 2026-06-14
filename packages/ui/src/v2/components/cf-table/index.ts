import { CFTable } from "./cf-table.ts";

if (!customElements.get("cf-table")) {
  customElements.define("cf-table", CFTable);
}

export { CFTable };
