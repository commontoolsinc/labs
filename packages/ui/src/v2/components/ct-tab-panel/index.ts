import { CTTabPanel } from "./ct-tab-panel.ts";
import { tabPanelStyles } from "./styles.ts";

if (!customElements.get("ct-tab-panel")) {
  customElements.define("ct-tab-panel", CTTabPanel);
}

export { CTTabPanel, tabPanelStyles };
