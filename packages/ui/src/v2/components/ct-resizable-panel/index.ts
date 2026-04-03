import { CTResizablePanel } from "./ct-resizable-panel.ts";

if (!customElements.get("ct-resizable-panel")) {
  customElements.define("ct-resizable-panel", CTResizablePanel);
}

export { CTResizablePanel };
