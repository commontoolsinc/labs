import { CFTabs } from "./cf-tabs.ts";

if (!customElements.get("cf-tabs")) {
  customElements.define("cf-tabs", CFTabs);
}

export { CFTabs };
