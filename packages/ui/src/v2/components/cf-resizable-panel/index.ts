import { CFResizablePanel } from "./cf-resizable-panel.ts";

if (!customElements.get("cf-resizable-panel")) {
  customElements.define("cf-resizable-panel", CFResizablePanel);
}

export { CFResizablePanel };
