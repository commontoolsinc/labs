import { CTCellContext } from "./ct-cell-context.ts";

if (!customElements.get("ct-cell-context")) {
  customElements.define("ct-cell-context", CTCellContext);
}

export { CTCellContext };
