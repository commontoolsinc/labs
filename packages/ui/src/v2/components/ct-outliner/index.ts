import { CTOutliner } from "./ct-outliner.ts";

if (!customElements.get("ct-outliner")) {
  customElements.define("ct-outliner", CTOutliner);
}

export { CTOutliner };