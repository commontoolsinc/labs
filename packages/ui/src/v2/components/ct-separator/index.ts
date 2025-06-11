import { CTSeparator, SeparatorOrientation } from "./ct-separator.ts";
import { separatorStyles } from "./styles.ts";

if (!customElements.get("ct-separator")) {
  customElements.define("ct-separator", CTSeparator);
}

export { CTSeparator, separatorStyles };
export type { SeparatorOrientation };
