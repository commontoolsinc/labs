import { CFTab } from "./cf-tab.ts";
import { tabStyles } from "./styles.ts";

if (!customElements.get("cf-tab")) {
  customElements.define("cf-tab", CFTab);
}

export { CFTab, tabStyles };
