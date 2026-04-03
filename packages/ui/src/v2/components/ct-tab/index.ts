import { CTTab } from "./ct-tab.ts";
import { tabStyles } from "./styles.ts";

if (!customElements.get("ct-tab")) {
  customElements.define("ct-tab", CTTab);
}

export { CTTab, tabStyles };
