import { CTTabs } from "./ct-tabs.ts";
import { tabsStyles } from "./styles.ts";

if (!customElements.get("ct-tabs")) {
  customElements.define("ct-tabs", CTTabs);
}

export { CTTabs, tabsStyles };
