import { CFSeparator, SeparatorOrientation } from "./cf-separator.ts";
import { separatorStyles } from "./styles.ts";

if (!customElements.get("cf-separator")) {
  customElements.define("cf-separator", CFSeparator);
}

export { CFSeparator, separatorStyles };
export type { SeparatorOrientation };
