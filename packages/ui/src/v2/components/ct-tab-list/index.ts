import { CTTabList } from "./ct-tab-list.ts";
import { tabListStyles } from "./styles.ts";

if (!customElements.get("ct-tab-list")) {
  customElements.define("ct-tab-list", CTTabList);
}

export { CTTabList, tabListStyles };
