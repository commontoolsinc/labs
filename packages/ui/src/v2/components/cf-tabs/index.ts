import { CFTabs } from "./cf-tabs.ts";
import { tabsStyles } from "./styles.ts";

if (!customElements.get("cf-tabs")) {
  customElements.define("cf-tabs", CFTabs);
}

export { CFTabs, tabsStyles };
