import { CFResizablePanelGroup } from "./cf-resizable-panel-group.ts";

if (!customElements.get("cf-resizable-panel-group")) {
  customElements.define("cf-resizable-panel-group", CFResizablePanelGroup);
}

export { CFResizablePanelGroup };
