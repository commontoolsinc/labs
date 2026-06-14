import { CFCellContext } from "./cf-cell-context.ts";

if (!customElements.get("cf-cell-context")) {
  customElements.define("cf-cell-context", CFCellContext);
}

export { CFCellContext };
