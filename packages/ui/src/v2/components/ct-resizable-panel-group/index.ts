import { CTResizablePanelGroup } from "./ct-resizable-panel-group.ts";

if (!customElements.get("ct-resizable-panel-group")) {
  customElements.define("ct-resizable-panel-group", CTResizablePanelGroup);
}

export { CTResizablePanelGroup };
