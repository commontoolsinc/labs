import { CFTabBar } from "./cf-tab-bar.ts";
import { CFTabBarItem } from "./cf-tab-bar-item.ts";

if (!customElements.get("cf-tab-bar")) {
  customElements.define("cf-tab-bar", CFTabBar);
}

if (!customElements.get("cf-tab-bar-item")) {
  customElements.define("cf-tab-bar-item", CFTabBarItem);
}

export { CFTabBar, CFTabBarItem };
